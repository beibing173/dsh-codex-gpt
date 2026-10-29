/**
 * dsh-codex Host 侧行为测试（OAuth 版）。
 *
 * 真实 Harness 包无法在包目录外解析，因此把源码复制到 test/.sandbox，
 * 并在其 node_modules 下放最小 schemastery 桩。OAuth 凭证直接写进
 * 临时 DSH_HOME 的 dsh-codex-auth.json；网络请求全部 mock。
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, copyFileSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'

const here = dirname(fileURLToPath(import.meta.url))
const packageDir = join(here, '..')
const sandbox = join(here, '.sandbox')
const fakeHome = join(tmpdir(), `dsh-codex-host-${process.pid}`)

let pluginModule
let sessionCounter = 0
const nextSession = () => `sess-test-${process.pid}-${++sessionCounter}`

const future = () => Math.floor(Date.now() / 1000) + 3600

function makeJwt(payload) {
  const enc = (value) => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${enc({ alg: 'none' })}.${enc(payload)}.sig`
}

/** 一份合法的插件 OAuth 凭证（写入 $DSH_HOME/dsh-codex-auth.json）。 */
function makeAuthRecord() {
  const authClaims = {
    chatgpt_plan_type: 'plus',
    chatgpt_account_id: 'acc-1',
    chatgpt_subscription_active_start: '2026-08-03T06:54:41+00:00',
    chatgpt_subscription_active_until: '2026-10-03T06:54:41+00:00',
  }
  return {
    version: 1,
    tokens: {
      access_token: makeJwt({ exp: future(), 'https://api.openai.com/auth': authClaims }),
      refresh_token: 'refresh-token-1',
      id_token: makeJwt({ exp: future(), email: 'codex@example.com', 'https://api.openai.com/auth': authClaims }),
      account_id: 'acc-1',
    },
    email: 'codex@example.com',
    plan: 'plus',
    active_start: '2026-08-03T06:54:41+00:00',
    active_until: '2026-10-03T06:54:41+00:00',
    last_refresh: new Date().toISOString(),
  }
}

function writeAuth(record = makeAuthRecord()) {
  writeFileSync(join(fakeHome, 'dsh-codex-auth.json'), JSON.stringify(record, null, 2))
}

function clearAuth() {
  rmSync(join(fakeHome, 'dsh-codex-auth.json'), { force: true })
  rmSync(join(fakeHome, 'dsh-codex.json'), { force: true })
}

before(async () => {
  rmSync(sandbox, { recursive: true, force: true })
  mkdirSync(join(sandbox, 'node_modules', '@deepseek-ai', 'schemastery'), { recursive: true })
  for (const file of ['index.js', 'codex.js', 'usage.js', 'network.js', 'oauth.js', 'llm-adapter.js']) {
    copyFileSync(join(packageDir, file), join(sandbox, file))
  }
  writeFileSync(join(sandbox, 'package.json'), JSON.stringify({ type: 'module' }))
  writeFileSync(
    join(sandbox, 'node_modules', '@deepseek-ai', 'schemastery', 'package.json'),
    JSON.stringify({ name: '@deepseek-ai/schemastery', version: '0.0.0-test', type: 'module', exports: { '.': './index.js' } }),
  )
  writeFileSync(
    join(sandbox, 'node_modules', '@deepseek-ai', 'schemastery', 'index.js'),
    `function chain(kind) {
  const node = {
    kind, meta: {},
    default(value) { this.meta.default = value; return this },
    description(value) { this.meta.description = value; return this },
    volatile() { this.meta.volatile = true; return this },
  }
  return node
}
const z = {
  string: () => chain('string'),
  boolean: () => chain('boolean'),
  number: () => chain('number'),
  array: () => chain('array'),
  object: (shape) => Object.assign(chain('object'), { shape }),
}
export default z
`,
  )
  process.env.DSH_HOME = fakeHome
  rmSync(fakeHome, { recursive: true, force: true })
  mkdirSync(fakeHome, { recursive: true })
  pluginModule = await import(`${pathToFileURL(join(sandbox, 'index.js')).href}?v=${Date.now()}`)
})

after(() => {
  rmSync(sandbox, { recursive: true, force: true })
  rmSync(fakeHome, { recursive: true, force: true })
})

/** 最小 Context + 注册物收集。 */
function createHarness(initialConfig = {}) {
  const config = { ...initialConfig }
  const tools = []
  const sections = []
  const routes = []
  const effects = []
  const settingsUpdates = []
  const settings = {
    async update(ns, patch) {
      settingsUpdates.push({ ns, patch })
      Object.assign(config, patch)
    },
  }
  const ctx = {
    get(name) {
      if (name === 'settings') return settings
      return undefined
    },
    webServer: {
      register(route) {
        routes.push(route)
        return () => {}
      },
      getOrigin() {
        return 'http://127.0.0.1:26336'
      },
    },
    tools: {
      register(definition) {
        tools.push(definition)
        return () => {}
      },
    },
    systemPrompt: {
      section(section) {
        sections.push(section)
        return () => {}
      },
    },
    llm: {
      registerAdapter() {
        const handle = () => {}
        handle.replace = () => {}
        return handle
      },
      registerConfigurableProviders() {
        const handle = () => {}
        handle.replace = () => {}
        return handle
      },
    },
    attachments: {
      async readImage() {
        return { data: new Uint8Array([1, 2, 3]), ref: {} }
      },
    },
    on() {
      return () => {}
    },
    effect(callback) {
      const dispose = callback()
      if (typeof dispose === 'function') effects.push(dispose)
      return () => {}
    },
    inject(_deps, callback) {
      const child = Object.create(ctx)
      child.settings = { ...settings, configure: () => () => {} }
      child.effect = (fn) => {
        const dispose = fn()
        if (typeof dispose === 'function') effects.push(dispose)
        return () => {}
      }
      try {
        callback(child)
      } catch {
        // 测试里忽略子作用域初始化错误
      }
      return () => {}
    },
  }
  pluginModule.apply(ctx, config)
  return { config, ctx, tools, sections, routes, effects, settingsUpdates }
}

function makeRequest({ method = 'GET', url = '/dsh-codex-api', body, remoteAddress = '127.0.0.1', headers } = {}) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]
  const finalHeaders = headers || (method === 'POST' ? { 'content-type': 'application/json' } : {})
  return {
    method,
    url,
    headers: finalHeaders,
    socket: { remoteAddress },
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
}

function makeResponse() {
  return {
    statusCode: 0,
    headers: undefined,
    body: '',
    writeHead(status, headers) {
      this.statusCode = status
      this.headers = headers
    },
    end(chunk) {
      if (chunk !== undefined) this.body = chunk.toString()
    },
  }
}

async function callApi(harness, options = {}) {
  const route = harness.routes[0]
  assert.ok(route, '状态路由未注册')
  const req = makeRequest(options)
  const res = makeResponse()
  await route.handler(req, res)
  return { status: res.statusCode, json: res.body ? JSON.parse(res.body) : undefined }
}

function findTool(harness) {
  const tool = harness.tools.find((item) => item.name === 'codex')
  assert.ok(tool, 'codex 工具未注册')
  return tool
}

async function runTool(harness, args, sessionId) {
  return findTool(harness).execute(args, { agent: { id: sessionId }, signal: undefined })
}

/** mock Codex 后端：模型列表 + SSE 回答。 */
function mockBackend({ models, sse, modelStatus = 200 } = {}) {
  return async (url) => {
    const target = String(url)
    if (target.includes('/codex/models')) {
      if (modelStatus !== 200) {
        return { ok: false, status: modelStatus, text: async () => '{"error":{"message":"no models"}}' }
      }
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            models:
              models ||
              [
                { slug: 'gpt-5-codex', display_name: 'GPT-5 Codex', context_window: 272000 },
                { slug: 'gpt-5', context_window: 272000 },
              ],
          }),
      }
    }
    if (target.includes('/codex/responses')) {
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'text/event-stream' },
        text: async () =>
          sse ||
          'data: {"type":"response.output_text.delta","delta":"专业分析结果"}\n\ndata: {"type":"response.completed","response":{}}',
      }
    }
    throw new Error(`unexpected fetch: ${target}`)
  }
}

test('apply 注册工具（完整 JSON Schema）、提示段与状态路由', () => {
  const harness = createHarness()
  assert.equal(harness.tools.length, 1)
  const tool = harness.tools[0]
  assert.equal(tool.name, 'codex')
  assert.equal(tool.parameters.type, 'object')
  assert.deepEqual(tool.parameters.required, ['task'])
  assert.equal(tool.parameters.properties.task.type, 'string')
  assert.deepEqual(tool.parameters.properties.mode.enum, ['analyze', 'build'])
  assert.equal(harness.sections.length, 1)
  assert.equal(harness.sections[0].name, 'dsh-codex-policy')
  assert.equal(harness.routes.length, 1)
  assert.equal(harness.routes[0].path, '/dsh-codex-api')
  assert.equal(harness.routes[0].kind, 'prefix')
})

test('未登录：快照 loggedIn=false，工具提示先登录', async () => {
  clearAuth()
  const harness = createHarness()
  const { status, json } = await callApi(harness)
  assert.equal(status, 200)
  assert.equal(json.auth.loggedIn, false)
  const text = await runTool(harness, { task: '分析架构' }, nextSession())
  assert.match(text, /尚未登录/)
})

test('已登录：OAuth 凭证被识别，返回邮箱与订阅计划', async () => {
  writeAuth()
  const harness = createHarness()
  const { json } = await callApi(harness, { url: '/dsh-codex-api?auth=1' })
  assert.equal(json.auth.loggedIn, true)
  assert.equal(json.auth.email, 'codex@example.com')
  assert.equal(json.auth.planLabel, 'Plus')
  assert.equal(json.auth.activeUntil, '2026-10-03T06:54:41+00:00')
  // 快照不泄露 token
  assert.doesNotMatch(JSON.stringify(json), /access_token|refresh_token|id_token/)
})

test('模型列表从 OpenAI codex/models 实时拉取', async (t) => {
  const original = globalThis.fetch
  t.after(() => {
    globalThis.fetch = original
  })
  globalThis.fetch = mockBackend()
  writeAuth()
  const harness = createHarness()
  const { status, json } = await callApi(harness, { url: '/dsh-codex-api?models=1' })
  assert.equal(status, 200)
  assert.equal(json.models.length, 2)
  assert.equal(json.models[0].slug, 'gpt-5-codex')
  assert.equal(json.models[0].contextWindow, 272000)
})

test('已登录但会话未授权：工具拒绝且不请求后端', async (t) => {
  const original = globalThis.fetch
  t.after(() => {
    globalThis.fetch = original
  })
  let fetched = 0
  globalThis.fetch = async () => {
    fetched += 1
    throw new Error('should not fetch')
  }
  writeAuth()
  const harness = createHarness()
  const text = await runTool(harness, { task: '分析' }, nextSession())
  assert.match(text, /未授权/)
  assert.equal(fetched, 0)
})

test('已授权 + 已登录：调用 Codex 后端并返回结果', async (t) => {
  const original = globalThis.fetch
  t.after(() => {
    globalThis.fetch = original
  })
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init })
    return mockBackend()(url, init)
  }
  writeAuth()
  const harness = createHarness()
  const sessionId = nextSession()
  await callApi(harness, { method: 'POST', body: { op: 'setSessionEnabled', sessionId, enabled: true } })
  const text = await runTool(harness, { task: '审查并发代码', mode: 'analyze', context: '代码...' }, sessionId)
  assert.match(text, /Codex · gpt-5-codex/)
  assert.match(text, /专业分析结果/)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'https://chatgpt.com/backend-api/codex/responses')
  const body = JSON.parse(calls[0].init.body)
  assert.equal(body.model, 'gpt-5-codex')
  assert.match(body.input[0].content[0].text, /审查并发代码/)
})

test('会话模型覆盖：setSessionModel 后使用该模型', async (t) => {
  const original = globalThis.fetch
  t.after(() => {
    globalThis.fetch = original
  })
  let seenModel = ''
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('/codex/responses')) {
      seenModel = JSON.parse(init.body).model
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'text/event-stream' },
        text: async () => 'data: {"type":"response.output_text.delta","delta":"ok"}',
      }
    }
    throw new Error('unexpected')
  }
  writeAuth()
  const harness = createHarness()
  const sessionId = nextSession()
  await callApi(harness, { method: 'POST', body: { op: 'setSessionEnabled', sessionId, enabled: true } })
  await callApi(harness, { method: 'POST', body: { op: 'setSessionModel', sessionId, model: 'gpt-5' } })
  await runTool(harness, { task: 'x' }, sessionId)
  assert.equal(seenModel, 'gpt-5')
})

test('setGlobal 更新默认模型与开关', async () => {
  writeAuth()
  const harness = createHarness()
  const { status, json } = await callApi(harness, {
    method: 'POST',
    body: { op: 'setGlobal', patch: { defaultModel: 'gpt-5', autoConsult: false, allowLanAccess: true } },
  })
  assert.equal(status, 200)
  assert.equal(json.global.defaultModel, 'gpt-5')
  assert.equal(json.global.autoConsult, false)
  assert.equal(json.global.allowLanAccess, true)
})

test('跨站请求被拒绝（Origin / Content-Type / 非回环）', async () => {
  writeAuth()
  const harness = createHarness()
  const crossOrigin = await callApi(harness, {
    headers: { origin: 'https://evil.example', 'content-type': 'application/json' },
  })
  assert.equal(crossOrigin.status, 403)

  const plainPost = await callApi(harness, {
    method: 'POST',
    body: { op: 'setGlobal', patch: { defaultModel: 'x' } },
    headers: { 'content-type': 'text/plain' },
  })
  assert.equal(plainPost.status, 403)

  const lan = await callApi(harness, { remoteAddress: '192.168.1.9' })
  assert.equal(lan.status, 403)
})

test('外网连通性检查：3 条链路并行探测', async (t) => {
  const original = globalThis.fetch
  t.after(() => {
    globalThis.fetch = original
  })
  globalThis.fetch = async (url) => {
    const target = String(url)
    if (target.includes('api.openai.com')) return { ok: false, status: 401, body: null, text: async () => '' }
    if (target.includes('chatgpt.com')) return { ok: true, status: 200, body: null, text: async () => '' }
    throw new Error('getaddrinfo ENOTFOUND auth.openai.com')
  }
  writeAuth()
  const harness = createHarness()
  const { status, json } = await callApi(harness, { method: 'POST', body: { op: 'testNetwork' } })
  assert.equal(status, 200)
  assert.equal(json.result.total, 3)
  assert.equal(json.result.reachable, 2)
})

test('重置卡：GET ?resets=1 返回可用张数与明细', async (t) => {
  const original = globalThis.fetch
  t.after(() => {
    globalThis.fetch = original
  })
  globalThis.fetch = async (url) => {
    const target = String(url)
    assert.match(target, /rate-limit-reset-credits/)
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          available_count: 2,
          credits: [
            { id: 'c-1', status: 'available', title: 'Full reset (Weekly + 5 hr)', expires_at: '2026-11-03T00:00:00Z' },
          ],
        }),
    }
  }
  writeAuth()
  const harness = createHarness()
  const { status, json } = await callApi(harness, { url: '/dsh-codex-api?resets=1' })
  assert.equal(status, 200)
  assert.equal(json.result.availableCount, 2)
  assert.equal(json.result.credits.length, 1)
  assert.equal(json.result.credits[0].id, 'c-1')
})

test('重置卡：consumeReset 先取最早一张再兑换', async (t) => {
  const original = globalThis.fetch
  t.after(() => {
    globalThis.fetch = original
  })
  const calls = []
  globalThis.fetch = async (url, init) => {
    const target = String(url)
    calls.push({ target, init })
    if (target.endsWith('/rate-limit-reset-credits')) {
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            available_count: 2,
            credits: [
              { id: 'c-late', status: 'available', expires_at: '2026-12-01T00:00:00Z' },
              { id: 'c-soon', status: 'available', expires_at: '2026-11-01T00:00:00Z' },
            ],
          }),
      }
    }
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ code: 'reset', windows_reset: 2, credit: { id: 'c-soon' } }),
    }
  }
  writeAuth()
  const harness = createHarness()
  const { status, json } = await callApi(harness, { method: 'POST', body: { op: 'consumeReset' } })
  assert.equal(status, 200)
  assert.equal(json.result.code, 'reset')
  assert.equal(json.result.windowsReset, 2)
  const consumeCall = calls.find((call) => call.target.endsWith('/consume'))
  assert.ok(consumeCall, '没有发兑换请求')
  const body = JSON.parse(consumeCall.init.body)
  assert.equal(body.credit_id, 'c-soon')
  assert.match(body.redeem_request_id, /^[0-9a-f-]{36}$/)
})

test('提示段按登录/授权状态切换文案', async () => {
  const harness = createHarness()
  const section = harness.sections[0]
  const sessionId = nextSession()
  const context = { agent: { id: sessionId } }

  clearAuth()
  const loggedOut = section.text(context)
  assert.match(loggedOut, /尚未登录/)

  writeAuth()
  const loggedIn = section.text(context)
  assert.match(loggedIn, /未授权/)
  assert.match(loggedIn, /已登录/)

  await callApi(harness, { method: 'POST', body: { op: 'setSessionEnabled', sessionId, enabled: true } })
  const authorized = section.text(context)
  assert.match(authorized, /已由用户【授权】/)
  assert.match(authorized, /codex/)

  assert.equal(section.text({}), '')
  assert.equal(section.text(undefined), '')
})
