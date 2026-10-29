import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  composeUserInput,
  extractResponsesText,
  parseCodexSse,
  callCodexBackend,
  fetchCodexModels,
  ANALYZE_INSTRUCTIONS,
  BUILD_INSTRUCTIONS,
} from '../codex.js'

test('composeUserInput: 只有任务时不加后缀', () => {
  assert.equal(composeUserInput('分析一下', ''), '分析一下')
  assert.equal(composeUserInput('  分析一下  ', '   '), '分析一下')
})

test('composeUserInput: 带上下文时保留两部分', () => {
  const text = composeUserInput('任务', '代码')
  assert.match(text, /^任务/)
  assert.match(text, /附加上下文：\n代码$/)
})

test('extractResponsesText: 标准 output 数组，跳过 reasoning', () => {
  const json = {
    output: [
      { type: 'reasoning', content: [{ type: 'reasoning_text', text: '不要被提取' }] },
      { type: 'message', content: [{ type: 'output_text', text: '第一段' }, { type: 'output_text', text: '第二段' }] },
    ],
  }
  assert.equal(extractResponsesText(json), '第一段\n\n第二段')
  assert.equal(extractResponsesText({ output_text: '快捷字段' }), '快捷字段')
  assert.equal(extractResponsesText({}), '')
})

test('parseCodexSse: 拼接 output_text delta', () => {
  const sse = [
    'data: {"type":"response.created"}',
    'data: {"type":"response.output_text.delta","delta":"专业"}',
    'data: {"type":"response.output_text.delta","delta":"分析"}',
    'data: {"type":"response.completed","response":{}}',
    'data: [DONE]',
  ].join('\n\n')
  assert.equal(parseCodexSse(sse), '专业分析')
})

test('parseCodexSse: 没有 delta 时退回 completed 完整输出', () => {
  const sse = [
    'data: {"type":"response.completed","response":{"output":[{"type":"message","content":[{"type":"output_text","text":"完整回答"}]}]}}',
  ].join('\n\n')
  assert.equal(parseCodexSse(sse), '完整回答')
})

test('parseCodexSse: failed 事件抛错', () => {
  const sse = 'data: {"type":"response.failed","response":{"error":{"message":"quota exceeded"}}}'
  assert.throws(() => parseCodexSse(sse), /quota exceeded/)
})

test('callCodexBackend: 发到 codex/responses 并解析 SSE', async (t) => {
  const original = globalThis.fetch
  t.after(() => {
    globalThis.fetch = original
  })
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init })
    const body = 'data: {"type":"response.output_text.delta","delta":"结果"}\n\ndata: {"type":"response.completed","response":{}}'
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'text/event-stream' },
      text: async () => body,
    }
  }
  const result = await callCodexBackend({
    accessToken: 'at-1',
    accountId: 'acc-1',
    model: 'gpt-5-codex',
    mode: 'analyze',
    task: '分析',
    context: '上下文',
  })
  assert.equal(result.text, '结果')
  assert.equal(result.endpoint, 'codex/responses')
  assert.equal(calls[0].url, 'https://chatgpt.com/backend-api/codex/responses')
  assert.equal(calls[0].init.headers.Authorization, 'Bearer at-1')
  assert.equal(calls[0].init.headers.originator, 'codex_cli_rs')
  assert.equal(calls[0].init.headers['chatgpt-account-id'], 'acc-1')
  const body = JSON.parse(calls[0].init.body)
  assert.equal(body.model, 'gpt-5-codex')
  assert.equal(body.stream, true)
  assert.match(body.input[0].content[0].text, /附加上下文/)
})

test('callCodexBackend: 非 2xx 带 status 抛错', async (t) => {
  const original = globalThis.fetch
  t.after(() => {
    globalThis.fetch = original
  })
  globalThis.fetch = async () => ({
    ok: false,
    status: 401,
    statusText: 'Unauthorized',
    headers: { get: () => 'application/json' },
    text: async () => '{"error":{"message":"bad token"}}',
  })
  await assert.rejects(
    () => callCodexBackend({ accessToken: 'x', model: 'gpt-5-codex', mode: 'analyze', task: 'x' }),
    /HTTP 401/,
  )
})

test('fetchCodexModels: 从 codex/models 拉取 slug 与上下文窗口', async (t) => {
  const original = globalThis.fetch
  t.after(() => {
    globalThis.fetch = original
  })
  let url = ''
  globalThis.fetch = async (target) => {
    url = String(target)
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          models: [
            { slug: 'gpt-5-codex', display_name: 'GPT-5 Codex', context_window: 272000 },
            { slug: 'gpt-5', context_window: 272000 },
            { slug: '' },
          ],
        }),
    }
  }
  const models = await fetchCodexModels({ accessToken: 'at-1', accountId: 'acc-1' })
  assert.equal(url, 'https://chatgpt.com/backend-api/codex/models?client_version=1.0.0')
  assert.equal(models.length, 2)
  assert.equal(models[0].slug, 'gpt-5-codex')
  assert.equal(models[0].displayName, 'GPT-5 Codex')
  assert.equal(models[0].contextWindow, 272000)
  assert.equal(models[1].displayName, 'gpt-5')
})

test('指令文本包含关键约束', () => {
  assert.match(ANALYZE_INSTRUCTIONS, /分析/)
  assert.match(BUILD_INSTRUCTIONS, /代码/)
})

test('fetchResetCredits: 只保留 available、按过期时间排序', async (t) => {
  const original = globalThis.fetch
  t.after(() => {
    globalThis.fetch = original
  })
  let url = ''
  globalThis.fetch = async (target) => {
    url = String(target)
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          available_count: 3,
          credits: [
            { id: 'c-late', status: 'available', title: 'Full reset', expires_at: '2026-12-01T00:00:00Z' },
            { id: 'c-expired', status: 'redeemed', title: 'old', expires_at: '2026-01-01T00:00:00Z' },
            { id: 'c-soon', status: 'available', description: 'Ready', expires_at: '2026-11-01T00:00:00Z' },
          ],
        }),
    }
  }
  const { fetchResetCredits } = await import('../codex.js')
  const result = await fetchResetCredits({ accessToken: 'at', accountId: 'acc' })
  assert.equal(url, 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits')
  assert.equal(result.availableCount, 3)
  assert.deepEqual(
    result.credits.map((credit) => credit.id),
    ['c-soon', 'c-late'],
  )
  assert.equal(result.credits[0].title, 'Ready')
})

test('consumeResetCredit: 带幂等键与 credit_id 兑换', async (t) => {
  const original = globalThis.fetch
  t.after(() => {
    globalThis.fetch = original
  })
  let captured
  globalThis.fetch = async (target, init) => {
    captured = { url: String(target), init }
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({ code: 'reset', windows_reset: 2, credit: { id: 'c-1', status: 'redeemed' } }),
    }
  }
  const { consumeResetCredit } = await import('../codex.js')
  const result = await consumeResetCredit({ accessToken: 'at', accountId: 'acc', creditId: 'c-1' })
  assert.equal(captured.url, 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume')
  const body = JSON.parse(captured.init.body)
  assert.equal(body.credit_id, 'c-1')
  assert.match(body.redeem_request_id, /^[0-9a-f-]{36}$/)
  assert.equal(captured.init.headers['chatgpt-account-id'], 'acc')
  assert.equal(result.code, 'reset')
  assert.equal(result.windowsReset, 2)
})

test('consumeResetCredit: nothing_to_reset 等结果码原样返回', async (t) => {
  const original = globalThis.fetch
  t.after(() => {
    globalThis.fetch = original
  })
  globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ code: 'nothing_to_reset' }) })
  const { consumeResetCredit } = await import('../codex.js')
  const result = await consumeResetCredit({ accessToken: 'at', accountId: 'acc' })
  assert.equal(result.code, 'nothing_to_reset')
  assert.equal(result.windowsReset, 0)
})
