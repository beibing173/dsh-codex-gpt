import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRequestBody, createCodexGptAdapter } from '../llm-adapter.js';

// All responses are in-memory SSE fixtures. No credentials or network are used.
const options = { model: 'edge-model', sessionId: 'edge-session', messages: [] };
const reasoning = (id, ...parts) => ({ type: 'reasoning', id, summary: parts.map(text => ({ type: 'summary_text', text })), encrypted_content: `opaque-${id}` });
const textItem = (id, text) => ({ type: 'message', id, role: 'assistant', status: 'completed', phase: 'commentary', content: [{ type: 'output_text', text, annotations: [] }] });
const tool = (id, call_id, name, args = '{}') => ({ type: 'function_call', id, call_id, name, arguments: args, status: 'completed' });
const done = (item, output_index) => ({ type: 'response.output_item.done', item, output_index });
const completed = (output = [], usage) => ({ type: 'response.completed', response: { status: 'completed', output, ...(usage ? { usage } : {}) } });
const source = output => ({ provider: 'openai-codex', model: options.model, replayState: { response: { status: 'completed', output } } });
const assistant = (content, output) => ({ role: 'assistant', content, source: source(output) });
const bodyFor = messages => buildRequestBody({ ...options, messages });
const hasNative = input => input.some(item => item.id !== undefined || item.encrypted_content !== undefined);

async function stream(events) {
  const savedFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => {
    requests++;
    return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''));
  };
  try {
    const adapter = createCodexGptAdapter({ getCredential: async () => ({ accessToken: 'offline-fixture' }), fetchModels: async () => [] });
    const chunks = [];
    for await (const chunk of adapter.stream(options)) chunks.push(chunk);
    assert.equal(requests, 1);
    assert.notEqual(chunks.at(-1)?.reason?.kind, 'error', JSON.stringify(chunks.at(-1)));
    return chunks;
  } finally {
    globalThis.fetch = savedFetch;
  }
}
function blocks(chunks) {
  // Durable blocks are ordered by their indexes, not completion arrival order.
  return chunks.filter(chunk => chunk.type === 'block-end').sort((a, b) => a.index - b.index).map(chunk => chunk.block);
}
function reasoningDeltas(chunks) {
  return chunks.filter(chunk => chunk.type === 'reasoning-delta').map(chunk => chunk.text).join('');
}
async function usageFor(usage) {
  return (await stream([completed([], usage)])).find(chunk => chunk.type === 'usage')?.usage;
}
function assertUsageConsistent(usage) {
  if (!usage) return; // Invalid upstream accounting may be rejected.
  for (const key of ['inputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens']) {
    if (usage[key] !== undefined) assert.ok(Number.isSafeInteger(usage[key]) && usage[key] >= 0, `${key}: ${usage[key]}`);
  }
  const prompt = usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
  assert.ok(Number.isSafeInteger(prompt));
  assert.ok(usage.totalTokens >= prompt + usage.outputTokens, JSON.stringify(usage));
  if (usage.cacheReadTokens !== undefined && usage.cacheWriteTokens !== undefined) assert.equal(usage.totalTokens, prompt + usage.outputTokens);
  if (usage.reasoningTokens !== undefined) assert.ok(usage.reasoningTokens <= usage.outputTokens);
}

test('multiple done-only reasoning items survive and round-trip natively', async () => {
  const output = [reasoning('r1', 'first'), textItem('m1', 'working'), reasoning('r2', 'second')];
  const chunks = await stream([...output.map(done), completed()]);
  assert.deepEqual(blocks(chunks), [{ type: 'reasoning', text: 'first' }, { type: 'text', text: 'working' }, { type: 'reasoning', text: 'second' }]);
  assert.equal(reasoningDeltas(chunks), 'firstsecond');
  const message = { role: 'assistant', content: blocks(chunks), source: { ...source(output), replayState: chunks.at(-1).replayState } };
  assert.deepEqual((await bodyFor([message])).input, output);
});

test('same item delta, summary done, item done emits reasoning exactly once', async () => {
  const item = reasoning('r1', 'alpha');
  const event = { item_id: item.id, output_index: 0, summary_index: 0 };
  const chunks = await stream([
    { type: 'response.reasoning_summary_text.delta', ...event, delta: 'al' },
    { type: 'response.reasoning_summary_text.delta', ...event, delta: 'pha' },
    { type: 'response.reasoning_summary_text.done', ...event, text: 'alpha' },
    done(item, 0), completed([item]),
  ]);
  assert.deepEqual(blocks(chunks), [{ type: 'reasoning', text: 'alpha' }]);
  assert.equal(reasoningDeltas(chunks), 'alpha');
  assert.equal(chunks.filter(chunk => chunk.type === 'block-start').length, 1);
});

test('multiple summary parts combine without duplicate deltas and replay', async () => {
  const item = reasoning('r1', 'first ', 'second');
  const chunks = await stream([
    { type: 'response.reasoning_summary_text.delta', item_id: 'r1', output_index: 0, summary_index: 0, delta: 'first ' },
    { type: 'response.reasoning_summary_text.done', item_id: 'r1', output_index: 0, summary_index: 0, text: 'first ' },
    { type: 'response.reasoning_summary_text.done', item_id: 'r1', output_index: 0, summary_index: 1, text: 'second' },
    done(item, 0), completed([item]),
  ]);
  assert.deepEqual(blocks(chunks), [{ type: 'reasoning', text: 'first second' }]);
  assert.equal(reasoningDeltas(chunks), 'first second');
  assert.deepEqual((await bodyFor([assistant(blocks(chunks), [item])])).input, [item]);
});

test('streamed reasoning followed by a done-only reasoning item is not dropped', async () => {
  const output = [reasoning('r1', 'one'), reasoning('r2', 'two')];
  const chunks = await stream([
    { type: 'response.reasoning_summary_text.delta', item_id: 'r1', output_index: 0, summary_index: 0, delta: 'one' },
    { type: 'response.reasoning_summary_text.done', item_id: 'r1', output_index: 0, summary_index: 0, text: 'one' },
    done(output[0], 0), done(output[1], 1), completed(output),
  ]);
  assert.deepEqual(blocks(chunks), [{ type: 'reasoning', text: 'one' }, { type: 'reasoning', text: 'two' }]);
});

test('moving reasoning across text or a tool forces visible-content fallback', async () => {
  const output = [reasoning('r1', 'one'), textItem('m1', 'working'), tool('fc1', 'c1', 'read'), reasoning('r2', 'two')];
  const original = [{ type: 'reasoning', text: 'one' }, { type: 'text', text: 'working' }, { type: 'tool-call', id: 'c1', name: 'read', arguments: '{}' }, { type: 'reasoning', text: 'two' }];
  assert.deepEqual((await bodyFor([assistant(original, output)])).input, output);
  for (const changed of [[original[1], original[0], original[2], original[3]], [original[0], original[1], original[3], original[2]]]) {
    const body = await bodyFor([assistant(changed, output)]);
    assert.equal(hasNative(body.input), false);
    assert.deepEqual(body.input.map(item => item.type ?? item.role), ['assistant', 'function_call']);
  }
});

test('malformed replay metadata degrades gracefully to durable visible content', async () => {
  const valid = [reasoning('r1', 'summary'), textItem('m1', 'visible')];
  const cases = [[null], [42], [{ type: 'reasoning', encrypted_content: 'opaque', summary: {} }], [{ type: 'reasoning', encrypted_content: 'opaque', summary: [null] }], [{ type: 'message', role: 'assistant', content: [null] }], [{ type: 'function_call', call_id: 'c1', name: 'read', arguments: {} }], [{ type: 'unknown' }], { not: 'an array' }];
  for (const output of cases) {
    const message = assistant([{ type: 'text', text: 'visible' }], valid);
    message.source.replayState.response.output = output;
    const body = await bodyFor([message]);
    assert.deepEqual(body.input, [{ role: 'assistant', content: [{ type: 'output_text', text: 'visible' }] }]);
  }
});

test('invalid optional count types never fabricate cache or reasoning tokens', async () => {
  for (const invalid of [true, false, [], [1], {}, '', '   ', '1.5', 1.5, -1, Number.MAX_SAFE_INTEGER + 1]) {
    const usage = await usageFor({ input_tokens: 100, output_tokens: 10, input_tokens_details: { cached_tokens: invalid, cache_write_tokens: invalid }, output_tokens_details: { reasoning_tokens: invalid } });
    assert.deepEqual(usage, { inputTokens: 100, outputTokens: 10, totalTokens: 110 }, JSON.stringify(invalid));
  }
});

test('integer numeric strings and null field aliases retain valid usage', async () => {
  const usage = await usageFor({ input_tokens: null, prompt_tokens: '100', output_tokens: '10', input_tokens_details: { cached_tokens: null }, cached_tokens: '20', output_tokens_details: { reasoning_tokens: '5' } });
  assert.deepEqual(usage, { inputTokens: 80, outputTokens: 10, totalTokens: 110, cacheReadTokens: 20, reasoningTokens: 5 });
});

test('optional cache sums and reasoning cannot exceed their inclusive totals', async () => {
  for (const details of [{ cached_tokens: 101 }, { cached_tokens: 60, cache_write_tokens: 41 }]) {
    const usage = await usageFor({ input_tokens: 100, output_tokens: 10, input_tokens_details: details, output_tokens_details: { reasoning_tokens: 11 } });
    assert.deepEqual(usage, { inputTokens: 100, outputTokens: 10, totalTokens: 110 });
    assertUsageConsistent(usage);
  }
});

test('contradictory explicit total never emits a DSH-invalid usage sample', async () => {
  assertUsageConsistent(await usageFor({ input_tokens: 100, output_tokens: 10, total_tokens: 50 }));
});

test('derived token sums remain safe integers', async () => {
  assertUsageConsistent(await usageFor({ input_tokens: Number.MAX_SAFE_INTEGER, output_tokens: 1 }));
});

test('same-session branches and truncation never restore discarded native items', async () => {
  const oldOutput = [reasoning('old-r', 'old summary'), textItem('old-m', 'old branch'), tool('old-fc', 'old-call', 'read')];
  const oldMessage = assistant([{ type: 'reasoning', text: 'old summary' }, { type: 'text', text: 'old branch' }, { type: 'tool-call', id: 'old-call', name: 'read', arguments: '{}' }], oldOutput);
  await bodyFor([oldMessage]);
  const newOutput = [textItem('new-m', 'new branch')];
  assert.deepEqual((await bodyFor([assistant([{ type: 'text', text: 'new branch' }], newOutput)])).input, newOutput);
  assert.deepEqual((await bodyFor([])).input, []);
  assert.deepEqual((await bodyFor([{ role: 'user', content: 'truncated' }])).input, [{ role: 'user', content: [{ type: 'input_text', text: 'truncated' }] }]);
});

test('editing tool identity, name, arguments or deleting it never revives old output', async () => {
  const output = [textItem('m1', 'before'), tool('fc1', 'c1', 'read', '{"path":"old"}')];
  const original = assistant([{ type: 'text', text: 'before' }, { type: 'tool-call', id: 'c1', name: 'read', arguments: '{"path":"old"}' }], output);
  for (const edit of [message => { message.content[1].id = 'edited-call'; }, message => { message.content[1].name = 'write'; }, message => { message.content[1].arguments = '{"path":"new"}'; }, message => { message.content.pop(); }]) {
    const message = structuredClone(original);
    edit(message);
    const body = await bodyFor([message]);
    assert.equal(hasNative(body.input), false);
    const calls = body.input.filter(item => item.type === 'function_call');
    const durable = message.content.find(block => block.type === 'tool-call');
    assert.deepEqual(calls, durable ? [{ type: 'function_call', call_id: durable.id, name: durable.name, arguments: durable.arguments }] : []);
  }
});

test('foreign text and two tools preserve interleaved order and result IDs', async () => {
  const content = [{ type: 'text', text: 'before' }, { type: 'tool-call', id: 'a', name: 'read', arguments: '{}' }, { type: 'text', text: 'between' }, { type: 'tool-call', id: 'b', name: 'write', arguments: '{}' }, { type: 'text', text: 'after' }];
  const body = await bodyFor([{ role: 'assistant', content }, { role: 'tool', toolCallId: 'a', content: 'A' }, { role: 'tool', toolCallId: 'b', content: 'B' }]);
  assert.deepEqual(body.input.map(item => item.type ?? item.role), ['assistant', 'function_call', 'assistant', 'function_call', 'assistant', 'function_call_output', 'function_call_output']);
  assert.deepEqual(body.input.filter(item => item.call_id).map(item => item.call_id), ['a', 'b', 'a', 'b']);
});

test('interleaved tool deltas and reverse done events retain indexed order', async () => {
  const a = tool('fc_a', 'call_a', 'read', '{"a":1}');
  const b = tool('fc_b', 'call_b', 'write', '{"b":2}');
  const chunks = await stream([
    { type: 'response.output_item.added', output_index: 0, item: { ...a, arguments: '' } },
    { type: 'response.output_item.added', output_index: 1, item: { ...b, arguments: '' } },
    { type: 'response.function_call_arguments.delta', item_id: 'fc_b', delta: '{"b":' },
    { type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"a":' },
    { type: 'response.function_call_arguments.delta', output_index: 1, delta: '2}' },
    { type: 'response.function_call_arguments.delta', item_id: 'fc_a', delta: '1}' },
    done(b, 1), done(a, 0), completed(),
  ]);
  assert.deepEqual(blocks(chunks), [{ type: 'tool-call', id: 'call_a', name: 'read', arguments: '{"a":1}' }, { type: 'tool-call', id: 'call_b', name: 'write', arguments: '{"b":2}' }]);
  assert.equal(chunks.at(-1).reason.kind, 'tool-calls');
  assert.deepEqual(chunks.at(-1).replayState.response.output, [a, b]);
  assert.deepEqual((await bodyFor([assistant(blocks(chunks), [a, b])])).input, [a, b]);
});
