import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createCodexGptAdapter,
  buildRequestBody,
  convertMessages,
  parseSseFrame,
  normalizeModels,
  PROVIDER_ID,
} from '../llm-adapter.js'

test('buildRequestBody: 组装 Codex Responses 请求体', async () => {
  const body = await buildRequestBody({
    model: 'gpt-5.6-sol',
    system: '你是助手',
    messages: [
      { role: 'user', content: [{ type: 'text', text: '你好' }] },
      { role: 'assistant', content: [{ type: 'text', text: '在的' }] },
    ],
    tools: [{ name: 'read', description: '读文件', parameters: { type: 'object', properties: {} } }],
    reasoningEffort: 'high',
    maxTokens: 1000,
  })
  assert.equal(body.model, 'gpt-5.6-sol')
  assert.equal(body.stream, true)
  assert.equal(body.store, false)
  assert.equal(body.instructions, '你是助手')
  assert.deepEqual(body.input[0], { role: 'user', content: [{ type: 'input_text', text: '你好' }] })
  assert.deepEqual(body.input[1], { role: 'assistant', content: [{ type: 'output_text', text: '在的' }] })
  assert.equal(body.tools[0].name, 'read')
  assert.equal(body.reasoning.effort, 'high')
  assert.equal(body.max_output_tokens, 1000)
})

test('convertMessages: tool-call 与 tool 结果映射为 function_call 项', async () => {
  const { input } = await convertMessages([
    { role: 'assistant', content: [{ type: 'text', text: '我来读' }, { type: 'tool-call', id: 'call_1', name: 'read', arguments: { path: 'a.txt' } }] },
    { role: 'tool', toolCallId: 'call_1', content: [{ type: 'text', text: '文件内容' }] },
  ])
  assert.equal(input.length, 3)
  assert.equal(input[0].type, 'function_call')
  assert.equal(input[0].call_id, 'call_1')
  assert.equal(input[0].arguments, '{"path":"a.txt"}')
  assert.equal(input[1].role, 'assistant')
  assert.equal(input[2].type, 'function_call_output')
  assert.equal(input[2].call_id, 'call_1')
  assert.equal(input[2].output, '文件内容')
})

test('parseSseFrame: 解析 data 行，忽略心跳与坏 JSON', () => {
  assert.deepEqual(parseSseFrame('data: {"type":"x"}'), { type: 'x' })
  assert.equal(parseSseFrame(': keep-alive'), undefined)
  assert.equal(parseSseFrame('data: not-json'), undefined)
  assert.equal(parseSseFrame('data: [DONE]'), undefined)
})

test('normalizeModels: 兼容 snake_case 与缺省上下文窗口', () => {
  const models = normalizeModels([
    { slug: 'gpt-5.6-sol', display_name: 'GPT-5.6 Sol', context_window: 272000 },
    { slug: 'gpt-5' },
    { nope: true },
  ])
  assert.equal(models.length, 2)
  assert.equal(models[0].displayName, 'GPT-5.6 Sol')
  assert.equal(models[0].contextWindow, 272000)
  assert.equal(models[1].contextWindow, 272000)
})

test('adapter: providerInfo / listModels / resolveModel', async () => {
  const adapter = createCodexGptAdapter({
    getCredential: async () => ({ accessToken: 'at', accountId: 'acc' }),
    fetchModels: async () => [{ slug: 'gpt-5.6-sol', displayName: 'GPT-5.6 Sol', contextWindow: 272000 }],
  })
  assert.deepEqual(adapter.providerInfo(), { id: PROVIDER_ID, name: 'ChatGPT' })
  const models = await adapter.listModels(PROVIDER_ID)
  assert.equal(models.length, 1)
  assert.equal(models[0].provider, PROVIDER_ID)
  assert.equal(models[0].id, 'gpt-5.6-sol')
  const resolved = await adapter.resolveModel(PROVIDER_ID, 'gpt-5.6-sol')
  assert.equal(resolved.context.contextWindow, 272000)
  assert.equal(resolved.defaultMaxTokens, 64000)
  assert.ok(Array.isArray(resolved.reasoning.efforts))
  assert.equal(resolved.reasoning.defaultEffort, 'high')
  const effortIds = resolved.reasoning.efforts.map((effort) => effort.id)
  assert.deepEqual(effortIds, ['off', 'low', 'high', 'max'])
})

test('buildRequestBody: 思考档位映射到 Codex（max→xhigh，off 不传）', async () => {
  const maxBody = await buildRequestBody({ model: 'gpt-5.6-sol', messages: [], reasoningEffort: 'max' })
  assert.deepEqual(maxBody.reasoning, { effort: 'xhigh', summary: 'auto' })
  const offBody = await buildRequestBody({ model: 'gpt-5.6-sol', messages: [], reasoningEffort: 'off' })
  assert.equal(offBody.reasoning, undefined)
})

test('convertMessages: 图片块转成 input_image data URL', async () => {
  const { input } = await convertMessages(
    [{ role: 'user', content: [{ type: 'text', text: '看图' }, { type: 'image', attachment: { attachmentId: 'a1', mediaType: 'image/png' } }] }],
    undefined,
    async () => ({ data: new Uint8Array([1, 2, 3]), mediaType: 'image/png' }),
  )
  assert.equal(input.length, 1)
  assert.deepEqual(input[0].content[0], { type: 'input_text', text: '看图' })
  assert.equal(input[0].content[1].type, 'input_image')
  assert.equal(input[0].content[1].image_url, 'data:image/png;base64,AQID')
})

test('adapter: stream 把 SSE 转成 DSH StreamChunk', async (t) => {
  const original = globalThis.fetch
  t.after(() => {
    globalThis.fetch = original
  })
  const sse = [
    'data: {"type":"response.output_text.delta","delta":"你"}',
    'data: {"type":"response.output_text.delta","delta":"好"}',
    'data: {"type":"response.completed","response":{"usage":{"input_tokens":3,"output_tokens":2}}}',
  ].join('\n\n')
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(sse))
        controller.close()
      },
    }),
  })
  const adapter = createCodexGptAdapter({
    getCredential: async () => ({ accessToken: 'at' }),
    fetchModels: async () => [],
  })
  const chunks = []
  for await (const chunk of adapter.stream({ provider: PROVIDER_ID, model: 'gpt-5.6-sol', messages: [] })) {
    chunks.push(chunk)
  }
  const types = chunks.map((chunk) => chunk.type)
  assert.ok(types.includes('block-start'))
  assert.ok(types.includes('text-delta'))
  assert.ok(types.includes('block-end'))
  assert.ok(types.includes('usage'))
  const finish = chunks.find((chunk) => chunk.type === 'finish')
  assert.equal(finish.reason.kind, 'stop')
  const text = chunks
    .filter((chunk) => chunk.type === 'text-delta')
    .map((chunk) => chunk.text)
    .join('')
  assert.equal(text, '你好')
})
