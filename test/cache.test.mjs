import test from 'node:test';
import assert from 'node:assert/strict';
import {buildRequestBody, createCodexGptAdapter} from '../llm-adapter.js';
const options={sessionId:'session-stable',model:'test-model',system:'stable rules',messages:[{role:'user',content:'hello'}]};
async function run(events, opts=options){
 let request;
 const original=globalThis.fetch;
 globalThis.fetch=async(url,init)=>{request={body:JSON.parse(init.body),headers:init.headers};return new Response(events.map(e=>'data: '+JSON.stringify(e)+'\n\n').join(''));};
 try {const a=createCodexGptAdapter({getCredential:async()=>({accessToken:'offline-only'}),fetchModels:async()=>[]});const chunks=[];for await(const c of a.stream(opts))chunks.push(c);return {chunks,request};}finally{globalThis.fetch=original;}
}
const completed=usage=>({type:'response.completed',response:{status:'completed',usage,output:[]}});
test('stable routing key and native reasoning include',async()=>{
 const a=await buildRequestBody(options);const b=await buildRequestBody({...options,messages:[...options.messages,{role:'user',content:'next'}]});
 assert.equal(a.prompt_cache_key,'session-stable');assert.equal(b.prompt_cache_key,a.prompt_cache_key);assert.deepEqual(a.include,['reasoning.encrypted_content']);assert.equal(a.store,false);
 const {request}=await run([completed({input_tokens:100,output_tokens:10})]);assert.equal(request.headers['session-id'],'session-stable');assert.equal(request.headers['thread-id'],'session-stable');
 assert.equal((await buildRequestBody({...options,sessionId:undefined})).prompt_cache_key,undefined);
});
test('late developer instructions do not invalidate existing prefix',async()=>{
 const a=await buildRequestBody(options);const b=await buildRequestBody({...options,messages:[...options.messages,{role:'developer',content:'new task guidance'}]});assert.equal(a.instructions,b.instructions);assert.deepEqual(b.input.slice(0,a.input.length),a.input);assert.equal(b.input.at(-1).role,'developer');
});
test('foreign assistant preserves text before tool order',async()=>{
 const b=await buildRequestBody({...options,messages:[{role:'assistant',content:[{type:'text',text:'working'},{type:'tool-call',id:'c1',name:'read',arguments:'{}'}]}]});assert.equal(b.input[0].role,'assistant');assert.equal(b.input[1].type,'function_call');
});
const output=[{type:'reasoning',id:'rs_1',summary:[{type:'summary_text',text:'summary'}],encrypted_content:'opaque-fixture'},{type:'message',role:'assistant',id:'msg_1',status:'completed',phase:'commentary',content:[{type:'output_text',text:'working',annotations:[]}]},{type:'function_call',id:'fc_1',call_id:'c1',name:'read',arguments:'{}',status:'completed'}];
const assistant={role:'assistant',content:[{type:'reasoning',text:'summary'},{type:'text',text:'working'},{type:'tool-call',id:'c1',name:'read',arguments:'{}'}],source:{provider:'openai-codex',model:'test-model',replayState:{response:{status:'completed',output}}}};
test('native replay keeps original output IDs reasoning and phase',async()=>{
 const b=await buildRequestBody({...options,messages:[assistant]});assert.deepEqual(b.input,output);
});
test('edited, foreign-model, or incomplete history never restores stale output',async()=>{
 for(const change of [m=>m.content[1].text='edited',m=>m.source.model='other',m=>m.source.replayState.response.status='incomplete',m=>m.content.pop(),m=>m.content[0].text='edited summary']){
  const m=structuredClone(assistant);change(m);const b=await buildRequestBody({...options,messages:[m]});assert.ok(!b.input.some(i=>i.type==='reasoning'));assert.ok(!b.input.some(i=>i.id==='msg_1'));
 }
});
test('cached input is subtracted and terminal usage enrichment survives dedup',async()=>{
 const base={input_tokens:10000,output_tokens:100,total_tokens:10100};const {chunks}=await run([{type:'response.usage',usage:base},completed({...base,input_tokens_details:{cached_tokens:8192}})]);
 const u=chunks.filter(c=>c.type==='usage');assert.equal(u.length,2);assert.deepEqual(u.at(-1).usage,{inputTokens:1808,outputTokens:100,totalTokens:10100,cacheReadTokens:8192});
 assert.equal(u.at(-1).usage.inputTokens+u.at(-1).usage.cacheReadTokens+u.at(-1).usage.outputTokens,u.at(-1).usage.totalTokens);
});
test('cache write and read are nonoverlapping input components',async()=>{
 const {chunks}=await run([completed({input_tokens:12000,output_tokens:100,input_tokens_details:{cached_tokens:4000,cache_write_tokens:7000}})]);const u=chunks.find(c=>c.type==='usage').usage;assert.equal(u.inputTokens,1000);assert.equal(u.totalTokens,12100);
});
test('null usage fields do not shadow numeric fallback',async()=>{
 const {chunks}=await run([completed({input_tokens:null,prompt_tokens:500,output_tokens:10,input_tokens_details:{cached_tokens:null},cached_tokens:200})]);assert.equal(chunks.find(c=>c.type==='usage').usage.inputTokens,300);
});
test('completed output items survive a terminal response without output',async()=>{
 const events=output.map((item,output_index)=>({type:'response.output_item.done',item,output_index}));
 events.push({type:'response.completed',response:{status:'completed',usage:{input_tokens:100,output_tokens:10}}});
 const {chunks}=await run(events);const finish=chunks.find(c=>c.type==='finish');assert.deepEqual(finish.replayState.response.output,output);
 assert.ok(chunks.some(c=>c.type==='block-end' && c.block.type==='reasoning' && c.block.text==='summary'));
 const m={role:'assistant',content:chunks.filter(c=>c.type==='block-end').map(c=>c.block),source:{provider:'openai-codex',model:'test-model',replayState:finish.replayState}};
 const body=await buildRequestBody({...options,messages:[m]});assert.deepEqual(body.input,output);
});
test('equal usage is deduplicated but reasoning enrichment is not',async()=>{
 const usage={input_tokens:200,output_tokens:100};const {chunks}=await run([{type:'response.usage',usage},{type:'response.usage',usage},completed({...usage,output_tokens_details:{reasoning_tokens:30}})]);assert.equal(chunks.filter(c=>c.type==='usage').length,2);
});
