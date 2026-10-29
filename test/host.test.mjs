/**
 * dsh-codex Host 侧行为测试。
 *
 * 真实 Host 的 `@deepseek-ai/dsh-tools` / `@deepseek-ai/schemastery` 无法在
 * 包目录外解析（它们来自 Harness 安装目录），因此把源码复制到 test/.sandbox，
 * 并在其 node_modules 下放最小桩：只验证插件的接线与行为契约，不验证框架实现。
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
const fakeHome = join(tmpdir(), `dsh-codex-test-${process.pid}`)

let pluginModule
let sessionCounter = 0
const nextSession = () => `sess-test-${process.pid}-${++sessionCounter}`

before(async () => {
  rmSync(sandbox, { recursive: true, force: true })
  mkdirSync(join(sandbox, 'node_modules', '@deepseek-ai', 'dsh-tools'), { recursive: true })
  mkdirSync(join(sandbox, 'node_modules', '@deepseek-ai', 'schemastery'), { recursive: true })
  copyFileSync(join(packageDir, 'index.js'), join(sandbox, 'index.js'))
  copyFileSync(join(packageDir, 'codex.js'), join(sandbox, 'codex.js'))
  copyFileSync(join(packageDir, 'usage.js'), join(sandbox, 'usage.js'))
  copyFileSync(join(packageDir, 'network.js'), join(sandbox, 'network.js'))
  writeFileSync(join(sandbox, 'package.json'), JSON.stringify({ type: 'module' }))

  // 最小 schemastery：链式 API 只做记录，不实现校验。
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

  // 最小 dsh-tools：defineTool 只返回定义本身。
  writeFileSync(
    join(sandbox, 'node_modules', '@deepseek-ai', 'dsh-tools', 'package.json'),
    JSON.stringify({ name: '@deepseek-ai/dsh-tools', version: '0.0.0-test', type: 'module', exports: { '.': './index.js' } }),
  )
  writeFileSync(
    join(sandbox, 'node_modules', '@deepseek-ai', 'dsh-tools', 'index.js'),
    `export function defineTool(definition) { return definition }\n`,
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

/** 构造插件运行所需的最小 Context，并记录注册物。 */
function createHarness(initialConfig = {}) {
  const config = { ...initialConfig }
  const tools = []
  const sections = []
  const routes = []
  const effects = []
  const settingsUpdates = []
  const ctx = {
    get(name) {
      if (name === 'settings') {
        return {
          async update(ns, patch) {
            settingsUpdates.push({ ns, patch })
            Object.assign(config, patch)
          },
        }
      }
      return undefined
    },
    webServer: {
      register(route) {
        routes.push(route)
        return () => {}
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
    on() {
      return () => {}
    },
    effect(callback) {
      const dispose = callback()
      if (typeof dispose === 'function') effects.push(dispose)
      return () => {}
    },
  }
  const apply = pluginModule.apply(ctx, config)
  return { apply, config, ctx, tools, sections, routes, effects, settingsUpdates }
}

function makeRequest({ method = 'GET', url = '/dsh-codex-api', body, remoteAddress = '127.0.0.1' } = {}) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]
  return {
    method,
    url,
    headers: {},
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

/** 打一次状态路由，返回 { status, json }。 */
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
  const tool = findTool(harness)
  return tool.execute(args, { agent: { id: sessionId }, signal: undefined })
}

test('apply 注册工具、提示段与状态路由', () => {
  const harness = createHarness()
  assert.equal(harness.tools.length, 1)
  assert.equal(harness.tools[0].name, 'codex')
  // 工具 parameters 必须是完整 JSON Schema（只传字段表会让模型请求以 INVALID_REQUEST 失败）
  assert.equal(harness.tools[0].parameters.type, 'object')
  assert.deepEqual(harness.tools[0].parameters.required, ['task'])
  assert.equal(harness.tools[0].parameters.properties.task.type, 'string')
  assert.deepEqual(harness.tools[0].parameters.properties.mode.enum, ['analyze', 'build'])
  assert.equal(harness.sections.length, 1)
  assert.equal(harness.sections[0].name, 'dsh-codex-policy')
  assert.equal(typeof harness.sections[0].text, 'function')
  assert.equal(harness.routes.length, 1)
  assert.equal(harness.routes[0].path, '/dsh-codex-api')
  assert.equal(harness.routes[0].kind, 'prefix')
})

test('GET 快照不泄露 API Key', async () => {
  const harness = createHarness({ apiKey: 'sk-secret-value', defaultModel: 'gpt-5-codex' })
  const { status, json } = await callApi(harness)
  assert.equal(status, 200)
  assert.equal(json.ok, true)
  assert.equal(json.global.apiConfigured, true)
  assert.equal(json.global.keySource, 'config')
  assert.equal(json.global.defaultModel, 'gpt-5-codex')
  assert.equal(json.session, null)
  assert.doesNotMatch(JSON.stringify(json), /sk-secret-value/)
})

test('未授权会话调用 codex 被拒绝', async () => {
  const harness = createHarness({ apiKey: 'sk-test' })
  const text = await runTool(harness, { task: '分析架构' }, nextSession())
  assert.match(text, /未授权/)
  assert.match(text, /Codex/)
})

test('设置页授权后会话状态持久化并可读回', async () => {
  const harness = createHarness()
  const sessionId = nextSession()
  const enabled = await callApi(harness, {
    method: 'POST',
    body: { op: 'setSessionEnabled', sessionId, enabled: true },
  })
  assert.equal(enabled.status, 200)
  assert.equal(enabled.json.session.enabled, true)

  const read = await callApi(harness, { url: `/dsh-codex-api?sessionId=${sessionId}` })
  assert.equal(read.json.session.enabled, true)
})

test('已授权但未配置 API Key 时给出配置指引', async () => {
  const harness = createHarness({ apiKey: '' })
  const sessionId = nextSession()
  await callApi(harness, { method: 'POST', body: { op: 'setSessionEnabled', sessionId, enabled: true } })
  const text = await runTool(harness, { task: '分析架构' }, sessionId)
  assert.match(text, /API Key/)
})

test('已授权 + 已配置时调用 OpenAI 并返回模型与耗时', async (t) => {
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
        JSON.stringify({ output: [{ type: 'message', content: [{ type: 'output_text', text: '专业分析结果' }] }] }),
    }
  }
  const harness = createHarness({ apiKey: 'sk-test', defaultModel: 'gpt-5-codex', models: ['gpt-5-codex', 'gpt-5'] })
  const sessionId = nextSession()
  await callApi(harness, { method: 'POST', body: { op: 'setSessionEnabled', sessionId, enabled: true } })
  const text = await runTool(harness, { task: '审查这段并发代码', mode: 'analyze', context: '代码...' }, sessionId)
  assert.match(text, /Codex · gpt-5-codex/)
  assert.match(text, /专业分析结果/)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'https://api.openai.com/v1/responses')
  const body = JSON.parse(calls[0].init.body)
  assert.match(body.input[0].content[0].text, /审查这段并发代码/)
  assert.match(body.input[0].content[0].text, /代码\.\.\./)
})

test('mode=build 使用构建指令', async (t) => {
  const original = globalThis.fetch
  t.after(() => {
    globalThis.fetch = original
  })
  let captured
  globalThis.fetch = async (url, init) => {
    captured = JSON.parse(init.body)
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ output: [{ content: [{ type: 'output_text', text: 'ok' }] }] }),
    }
  }
  const harness = createHarness({ apiKey: 'sk-test' })
  const sessionId = nextSession()
  await callApi(harness, { method: 'POST', body: { op: 'setSessionEnabled', sessionId, enabled: true } })
  await runTool(harness, { task: '实现一个限流器', mode: 'build' }, sessionId)
  assert.match(captured.instructions, /编码模型/)
})

test('缺少 task 时拒绝并提示', async () => {
  const harness = createHarness({ apiKey: 'sk-test' })
  const sessionId = nextSession()
  await callApi(harness, { method: 'POST', body: { op: 'setSessionEnabled', sessionId, enabled: true } })
  const text = await runTool(harness, {}, sessionId)
  assert.match(text, /缺少 task/)
})

test('setGlobal 更新默认模型与模型列表', async () => {
  const harness = createHarness()
  const { status, json } = await callApi(harness, {
    method: 'POST',
    body: {
      op: 'setGlobal',
      patch: { defaultModel: 'gpt-5', models: ['gpt-5', 'gpt-5-mini'], autoConsult: false },
    },
  })
  assert.equal(status, 200)
  assert.equal(json.global.defaultModel, 'gpt-5')
  assert.deepEqual(json.global.models, ['gpt-5', 'gpt-5-mini'])
  assert.equal(json.global.autoConsult, false)
})

test('未知操作返回 400 与原因', async () => {
  const harness = createHarness()
  const { status, json } = await callApi(harness, { method: 'POST', body: { op: 'nope' } })
  assert.equal(status, 400)
  assert.equal(json.ok, false)
  assert.match(json.error, /未知操作/)
})

test('非回环地址默认 403，开启局域网访问后放行', async () => {
  const harness = createHarness({ allowLanAccess: false })
  const blocked = await callApi(harness, { remoteAddress: '192.168.1.9' })
  assert.equal(blocked.status, 403)

  await callApi(harness, { method: 'POST', body: { op: 'setGlobal', patch: { allowLanAccess: true } } })
  const allowed = await callApi(harness, { remoteAddress: '192.168.1.9' })
  assert.equal(allowed.status, 200)
})

test('提示段按会话授权状态切换文案', async () => {
  const harness = createHarness({ autoConsult: true })
  const section = harness.sections[0]
  const sessionId = nextSession()
  const context = { agent: { id: sessionId } }

  const before = section.text(context)
  assert.match(before, /未授权/)
  assert.match(before, /Codex/)

  await callApi(harness, { method: 'POST', body: { op: 'setSessionEnabled', sessionId, enabled: true } })
  const after = section.text(context)
  assert.match(after, /已由用户【授权】/)
  assert.match(after, /codex/)
  assert.match(after, /自主调用|主动调用/)
})

test('提示段在拿不到会话时返回空串', () => {
  const harness = createHarness()
  const section = harness.sections[0]
  assert.equal(section.text({}), '')
  assert.equal(section.text(undefined), '')
})

test('testConnection 走真实调用路径并返回延迟', async (t) => {
  const original = globalThis.fetch
  t.after(() => {
    globalThis.fetch = original
  })
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ output: [{ content: [{ type: 'output_text', text: 'OK' }] }] }),
  })
  const harness = createHarness({ apiKey: 'sk-test', defaultModel: 'gpt-5-mini' })
  const { status, json } = await callApi(harness, { method: 'POST', body: { op: 'testConnection' } })
  assert.equal(status, 200)
  assert.equal(json.result.model, 'gpt-5-mini')
  assert.equal(json.result.endpoint, 'responses')
  assert.equal(typeof json.result.latencyMs, 'number')
})

test('testNetwork 汇总外网链路可达性（非 2xx 也算可达）', async (t) => {
  const original = globalThis.fetch
  t.after(() => {
    globalThis.fetch = original
  })
  const targets = []
  globalThis.fetch = async (url) => {
    const target = String(url)
    targets.push(target)
    if (target.includes('api.openai.com')) {
      // 没带凭证 → 401，但链路可达
      return { ok: false, status: 401, body: null, text: async () => '' }
    }
    if (target.includes('chatgpt.com')) {
      return { ok: true, status: 200, body: null, text: async () => '' }
    }
    throw new Error('getaddrinfo ENOTFOUND auth.openai.com')
  }
  const harness = createHarness()
  const { status, json } = await callApi(harness, { method: 'POST', body: { op: 'testNetwork' } })
  assert.equal(status, 200)
  assert.equal(json.result.total, 3)
  assert.equal(json.result.reachable, 2)
  const byId = Object.fromEntries(json.result.targets.map((item) => [item.id, item]))
  assert.equal(byId['openai-api'].ok, true)
  assert.equal(byId['openai-api'].status, 401)
  assert.equal(byId['chatgpt-usage'].ok, true)
  assert.equal(byId['openai-auth'].ok, false)
  assert.match(byId['openai-auth'].error, /ENOTFOUND/)
  assert.equal(targets.length, 3)
})
