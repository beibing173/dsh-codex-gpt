import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  composeUserInput,
  extractResponsesText,
  extractChatText,
  callCodex,
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

test('extractResponsesText: 标准 output 数组', () => {
  const json = {
    output: [
      { type: 'reasoning', content: [{ type: 'reasoning_text', text: '不要被提取' }] },
      { type: 'message', content: [{ type: 'output_text', text: '第一段' }, { type: 'output_text', text: '第二段' }] },
    ],
  }
  assert.equal(extractResponsesText(json), '第一段\n\n第二段')
})

test('extractResponsesText: 顶层 output_text 优先', () => {
  assert.equal(extractResponsesText({ output_text: '快捷字段' }), '快捷字段')
})

test('extractResponsesText: 空响应返回空串', () => {
  assert.equal(extractResponsesText({}), '')
  assert.equal(extractResponsesText(null), '')
})

test('extractChatText: 字符串与分段数组都支持', () => {
  assert.equal(extractChatText({ choices: [{ message: { content: '你好' } }] }), '你好')
  assert.equal(extractChatText({ choices: [{ message: { content: [{ text: '你' }, { text: '好' }] } }] }), '你好')
  assert.equal(extractChatText({}), '')
})

test('callCodex: Responses API 正常返回', async (t) => {
  const original = globalThis.fetch
  t.after(() => {
    globalThis.fetch = original
  })
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init })
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          output: [{ type: 'message', content: [{ type: 'output_text', text: '分析结果' }] }],
        }),
    }
  }
  const result = await callCodex({
    apiKey: 'sk-test',
    baseUrl: 'https://api.example.com/v1/',
    model: 'gpt-5-codex',
    mode: 'analyze',
    task: '任务',
    context: '上下文',
    maxOutputTokens: 100,
  })
  assert.equal(result.text, '分析结果')
  assert.equal(result.endpoint, 'responses')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'https://api.example.com/v1/responses')
  const body = JSON.parse(calls[0].init.body)
  assert.equal(body.model, 'gpt-5-codex')
  assert.equal(body.instructions, ANALYZE_INSTRUCTIONS)
  assert.equal(body.max_output_tokens, 100)
  assert.equal(calls[0].init.headers.Authorization, 'Bearer sk-test')
})

test('callCodex: 404 回退 Chat Completions', async (t) => {
  const original = globalThis.fetch
  t.after(() => {
    globalThis.fetch = original
  })
  const urls = []
  globalThis.fetch = async (url) => {
    urls.push(url)
    if (url.endsWith('/responses')) {
      return { ok: false, status: 404, statusText: 'Not Found', text: async () => '{"error":{"message":"no such route"}}' }
    }
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ choices: [{ message: { content: '回退结果' } }] }),
    }
  }
  const result = await callCodex({
    apiKey: 'k',
    baseUrl: 'https://proxy.example.com/v1',
    model: 'gpt-5',
    mode: 'build',
    task: '写代码',
  })
  assert.equal(result.text, '回退结果')
  assert.equal(result.endpoint, 'chat/completions')
  assert.deepEqual(urls, ['https://proxy.example.com/v1/responses', 'https://proxy.example.com/v1/chat/completions'])
})

test('callCodex: 401 不触发回退并抛出可读错误', async (t) => {
  const original = globalThis.fetch
  t.after(() => {
    globalThis.fetch = original
  })
  let count = 0
  globalThis.fetch = async () => {
    count += 1
    return { ok: false, status: 401, statusText: 'Unauthorized', text: async () => '{"error":{"message":"bad key"}}' }
  }
  await assert.rejects(
    () => callCodex({ apiKey: 'bad', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5', mode: 'analyze', task: 'x' }),
    /HTTP 401/,
  )
  assert.equal(count, 1)
})

test('指令文本包含关键约束', () => {
  assert.match(ANALYZE_INSTRUCTIONS, /分析/)
  assert.match(BUILD_INSTRUCTIONS, /代码/)
})
