import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createCodexGptAdapter,
  buildRequestBody,
  convertMessages,
  parseSseFrame,
  normalizeModels,
  LEGACY_PROVIDER_IDS,
  PROVIDER_ID,
} from '../llm-adapter.js'

test('provider id：规范 id 与旧别名都能路由', async () => {
  assert.equal(PROVIDER_ID, 'openai-codex')
  assert.deepEqual(LEGACY_PROVIDER_IDS, ['chatgpt-codex'])

  const adapter = createCodexGptAdapter({
    getCredential: async () => ({ accessToken: 'at' }),
    fetchModels: async () => [{ slug: 'gpt-5.6-sol', displayName: 'GPT-5.6' }],
    fallbackModel: 'gpt-5.6-sol',
  })

  // providerInfo 的 id 必须等于注册时的路由 id，否则 DSH 会拒绝这条路由。
  assert.deepEqual(adapter.providerInfo(PROVIDER_ID), { id: 'openai-codex', name: 'ChatGPT' })
  assert.deepEqual(adapter.providerInfo('chatgpt-codex'), { id: 'chatgpt-codex', name: 'ChatGPT（旧 id）' })

  const canonical = await adapter.listModels(PROVIDER_ID)
  assert.deepEqual(canonical.map((m) => m.provider), ['openai-codex'])

  // 老会话保存的选择仍是 chatgpt-codex：必须照样列模型、照样解析，不能变成不可路由。
  const legacy = await adapter.listModels('chatgpt-codex')
  assert.deepEqual(legacy.map((m) => m.provider), ['chatgpt-codex'])
  const resolved = await adapter.resolveModel('chatgpt-codex', 'gpt-5.6-sol')
  assert.equal(resolved.provider, 'chatgpt-codex')
  assert.equal(resolved.name, 'GPT-5.6')

  await assert.rejects(() => adapter.listModels('deepseek-account'), /不支持的 LLM provider/)
})

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

test('listModels: 凭证/目录不可用时返回兜底模型，绝不返回空列表', async () => {
  const cases = [
    {
      name: '凭证刷新抛错',
      getCredential: async () => {
        throw new Error('refresh failed')
      },
      fetchModels: async () => [{ slug: 'gpt-9-sol' }],
    },
    {
      name: '未登录',
      getCredential: async () => undefined,
      fetchModels: async () => [{ slug: 'gpt-9-sol' }],
    },
    {
      name: '上游 429',
      getCredential: async () => ({ accessToken: 'at' }),
      fetchModels: async () => {
        throw new Error('HTTP 429')
      },
    },
    {
      name: '上游空列表',
      getCredential: async () => ({ accessToken: 'at' }),
      fetchModels: async () => [],
    },
  ]

  for (const item of cases) {
    const adapter = createCodexGptAdapter({
      getCredential: item.getCredential,
      fetchModels: item.fetchModels,
      fallbackModel: 'gpt-5.6-sol',
    })
    const models = await adapter.listModels(PROVIDER_ID)
    assert.equal(models.length, 1, `${item.name}: 必须返回兜底模型`)
    assert.equal(models[0].provider, PROVIDER_ID)
    assert.equal(models[0].id, 'gpt-5.6-sol')
    assert.deepEqual(models[0].inputModalities, ['text', 'image'])
  }

  // 有正常目录时不塞兜底，直接用上游结果。
  const adapter = createCodexGptAdapter({
    getCredential: async () => ({ accessToken: 'at' }),
    fetchModels: async () => [{ slug: 'gpt-9-sol', displayName: 'GPT-9' }],
    fallbackModel: 'gpt-5.6-sol',
  })
  const live = await adapter.listModels(PROVIDER_ID)
  assert.deepEqual(
    live.map((model) => model.id),
    ['gpt-9-sol'],
  )
})

test('listModels: 目录没过期时不等待网络，直读缓存', async () => {
  let calls = 0
  const adapter = createCodexGptAdapter({
    getCredential: async () => ({ accessToken: 'at' }),
    fetchModels: async () => {
      calls += 1
      return [{ slug: 'gpt-9-sol' }]
    },
    fallbackModel: 'gpt-5.6-sol',
  })
  const first = await adapter.listModels(PROVIDER_ID)
  assert.deepEqual(first.map((m) => m.id), ['gpt-9-sol'])

  // 第二次（DSH 打开选择器/切换会话时）必须命中缓存：既不重复请求上游，也不等待。
  const started = Date.now()
  const second = await adapter.listModels(PROVIDER_ID)
  const elapsed = Date.now() - started
  assert.deepEqual(second.map((m) => m.id), ['gpt-9-sol'])
  assert.equal(calls, 1)
  assert.ok(elapsed < 50, `缓存命中应瞬时返回，实际 ${elapsed}ms`)
})

test('listModels: 目录过期时先返回旧缓存，后台再续期', async () => {
  let clock = 1_000_000
  let revision = 1
  const adapter = createCodexGptAdapter({
    getCredential: async () => ({ accessToken: 'at' }),
    fetchModels: async () => [{ slug: `gpt-${revision}` }],
    fallbackModel: 'gpt-5.6-sol',
    now: () => clock,
  })
  await adapter.listModels(PROVIDER_ID)
  revision = 2
  clock += 6 * 60 * 1000 // 超过 5 分钟 TTL

  const stale = await adapter.listModels(PROVIDER_ID)
  assert.deepEqual(stale.map((m) => m.id), ['gpt-1'], '过期时先给旧缓存，不阻塞')

  // 后台刷新完成后，下一次调用拿到新目录。
  await new Promise((resolve) => setTimeout(resolve, 10))
  const refreshed = await adapter.listModels(PROVIDER_ID)
  assert.deepEqual(refreshed.map((m) => m.id), ['gpt-2'])
})

test('listModels: 冷启动上游卡住时按超时返回兜底，不阻塞模型选择器', async () => {
  const adapter = createCodexGptAdapter({
    getCredential: async () => ({ accessToken: 'at' }),
    fetchModels: () => new Promise(() => {}),
    fallbackModel: 'gpt-5.6-sol',
  })
  const started = Date.now()
  const models = await adapter.listModels(PROVIDER_ID)
  const elapsed = Date.now() - started
  assert.deepEqual(models.map((m) => m.id), ['gpt-5.6-sol'])
  assert.ok(elapsed < 3000, `冷启动必须有上限，实际 ${elapsed}ms`)
})

test('resolveModel: 复用目录缓存，选完模型不重打上游', async () => {
  let calls = 0
  const adapter = createCodexGptAdapter({
    getCredential: async () => ({ accessToken: 'at' }),
    fetchModels: async () => {
      calls += 1
      return [{ slug: 'gpt-9-sol', displayName: 'GPT-9' }]
    },
    fallbackModel: 'gpt-5.6-sol',
  })
  await adapter.listModels(PROVIDER_ID)
  assert.equal(calls, 1)

  const started = Date.now()
  const resolved = await adapter.resolveModel(PROVIDER_ID, 'gpt-9-sol')
  const elapsed = Date.now() - started
  assert.equal(resolved.id, 'gpt-9-sol')
  assert.equal(resolved.name, 'GPT-9')
  assert.equal(calls, 1, '解析模型应命中缓存，不应再次请求上游')
  assert.ok(elapsed < 50, `解析应瞬时完成，实际 ${elapsed}ms`)
})
