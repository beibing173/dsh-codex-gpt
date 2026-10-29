/**
 * dsh-codex — DeepSeek Harness 的 Codex 桥接插件（Host 侧，OAuth 版）。
 *
 * 设计目标：
 *   1. 正常模式：会话默认由 DeepSeek 模型（V4.1）处理，不触碰 Codex；
 *   2. 会话级授权：用户必须手动在输入框左侧「Codex」按钮授权该会话；
 *   3. 自主调用：已授权会话里，DeepSeek 按任务强度自行决定是否调用 `codex`；
 *   4. OpenAI 登录：与 Codex CLI 相同的 OAuth 授权（浏览器跳 OpenAI 官网），不手填 API Key；
 *   5. 模型列表：从 OpenAI 的 codex/models 接口实时拉取，用户在设置页选择；
 *   6. 额度走 ChatGPT 订阅：调用 chatgpt.com/backend-api/codex/responses，不产生 API 计费。
 *
 * 组成：`codex` 工具 + 每会话提示策略段 + `/dsh-codex-api` 状态/登录路由 + 本地 OAuth 回调。
 */
import z from '@deepseek-ai/schemastery'
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { callCodexBackend, fetchCodexModels, fetchResetCredits, consumeResetCredit } from './codex.js'
import { getCodexUsage, __resetUsageCache } from './usage.js'
import { checkConnectivity } from './network.js'
import { createAuthStore, ensureAccessToken, beginLogin, cancelLogin, describeCredential } from './oauth.js'
import { createCodexGptAdapter } from './llm-adapter.js'

export const name = 'dsh-codex-gpt'

/** profile 条目 id：cordis.patch.yml 里 `- id: dsh-codex-gpt` 必须与此一致。 */
export const ENTRY_ID = 'dsh-codex-gpt'

/** Host 依赖：工具注册、提示组装、状态路由（与 dsh-meme 一致），外加 LLM 适配器注册。 */
export const inject = ['tools', 'systemPrompt', 'webServer', 'llm']

export const ROUTE = '/dsh-codex-api'
/** 单次 Codex 调用超时（毫秒）。 */
const CODEX_TIMEOUT_MS = 240_000
/** 会话状态文件里最多保留的会话条数。 */
const MAX_SESSIONS = 400
/** 提示策略段的 order：紧跟人格段之后。 */
const POLICY_ORDER = 10310
/** 模型列表缓存时长。 */
const MODELS_TTL_MS = 5 * 60 * 1000
const DEFAULT_MODEL = 'gpt-5-codex'

/** 订阅计划展示名。 */
const PLAN_LABELS = {
  free: 'Free',
  plus: 'Plus',
  pro: 'Pro',
  prolite: 'Pro 100',
  promax: 'Pro 200',
  team: 'Team',
  business: 'Business',
  enterprise: 'Enterprise',
  edu: 'Edu',
}

export const Config = z.object({
  defaultModel: z
    .string()
    .default(DEFAULT_MODEL)
    .description('默认使用的 Codex 模型（候选从 OpenAI 实时拉取）。')
    .volatile(),
  autoConsult: z
    .boolean()
    .default(true)
    .description('允许 DeepSeek 在已授权会话里根据任务强度自主调用 Codex；关闭后只在用户明确要求时调用。')
    .volatile(),
  allowLanAccess: z
    .boolean()
    .default(false)
    .description('允许局域网设备通过 Web UI 读写本插件状态；默认仅本机回环地址。')
    .volatile(),
})

// ────────────────────────────── 通用小工具 ──────────────────────────────

/** 读取 Config 字段（volatile 引用逐层解包）。 */
function readField(holder) {
  let current = holder
  for (let depth = 0; depth < 8; depth += 1) {
    if (current === undefined || current === null) return current
    if (typeof current.get !== 'function') return current
    current = current.get()
  }
  return current
}

function warn(message, error) {
  try {
    console.warn(`[dsh-codex] ${message}`, error ?? '')
  } catch {
    // 日志失败不影响功能
  }
}

function normalizeSessionId(value) {
  if (typeof value !== 'string') return ''
  const id = value.trim()
  if (!id || id.length > 200) return ''
  if (!/^[A-Za-z0-9_.:-]+$/.test(id)) return ''
  return id
}

/** 规范展示名。 */
function planLabel(plan) {
  if (typeof plan !== 'string' || !plan) return undefined
  return PLAN_LABELS[plan.toLowerCase()] || plan
}

/** 是否本机回环请求。 */
function isLoopback(req) {
  const address = (req && req.socket && req.socket.remoteAddress) || ''
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(Buffer.byteLength(body)),
    'Cache-Control': 'no-store',
  })
  res.end(body)
}

async function readJsonBody(req, limit = 128 * 1024) {
  let size = 0
  const chunks = []
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim()
  if (!raw) return {}
  const parsed = JSON.parse(raw)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('请求体必须是 JSON 对象')
  return parsed
}

// ────────────────────────────── 会话授权存储 ──────────────────────────────

/**
 * 会话授权状态：$DSH_HOME/dsh-codex.json
 *   { version: 1, sessions: { [sessionId]: { enabled, model, updatedAt } } }
 */
function createSessionStore(options) {
  const { env, homeDir } = options
  const filePath = () => join(env.DSH_HOME || homeDir(), 'dsh-codex.json')
  let cache = null

  const load = () => {
    if (cache) return cache
    let parsed
    try {
      parsed = JSON.parse(readFileSync(filePath(), 'utf8'))
    } catch {
      parsed = undefined
    }
    const sessions = {}
    const source = parsed && typeof parsed === 'object' && parsed.sessions ? parsed.sessions : {}
    if (source && typeof source === 'object') {
      for (const [sessionId, record] of Object.entries(source)) {
        if (!record || typeof record !== 'object') continue
        sessions[sessionId] = {
          enabled: record.enabled === true,
          model: typeof record.model === 'string' ? record.model.slice(0, 200) : '',
          updatedAt: Number.isFinite(record.updatedAt) ? Number(record.updatedAt) : 0,
        }
      }
    }
    cache = { version: 1, sessions }
    return cache
  }

  const save = (next) => {
    const sessions = Object.entries(next.sessions)
      .sort((a, b) => (b[1].updatedAt || 0) - (a[1].updatedAt || 0))
      .slice(0, MAX_SESSIONS)
    const payload = { version: 1, sessions: Object.fromEntries(sessions) }
    const file = filePath()
    try {
      mkdirSync(dirname(file), { recursive: true })
      const tmp = `${file}.${process.pid}.tmp`
      writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8')
      renameSync(tmp, file)
      cache = payload
    } catch (error) {
      warn('会话授权状态写入失败（本进程内仍生效）', error)
      cache = payload
    }
    return cache
  }

  return {
    path: filePath,
    get(sessionId) {
      const record = load().sessions[sessionId]
      return {
        sessionId,
        enabled: record ? record.enabled === true : false,
        model: record ? record.model : '',
      }
    },
    set(sessionId, patch) {
      const current = load()
      const previous = current.sessions[sessionId]
      const next = {
        enabled: typeof patch.enabled === 'boolean' ? patch.enabled : previous ? previous.enabled : false,
        model: typeof patch.model === 'string' ? patch.model.slice(0, 200) : previous ? previous.model : '',
        updatedAt: Date.now(),
      }
      save({ version: 1, sessions: { ...current.sessions, [sessionId]: next } })
      return { sessionId, enabled: next.enabled, model: next.model }
    },
  }
}

// ────────────────────────────── 提示策略 ──────────────────────────────

/** 渲染给当前会话模型的 Codex 使用策略（每次模型步骤求值）。 */
function renderPolicy(state, settings) {
  if (!state.loggedIn) {
    return [
      '## Codex 专业分析通道（dsh-codex）',
      '本机尚未登录 OpenAI 账号，Codex 当前不可用。',
      '- 常规任务全部用你自身的 DeepSeek 能力完成，不要调用 `codex` 工具。',
      '- 若用户需要 GPT/Codex 参与，提示用户打开 设置 →「Codex」页，点击「登录 OpenAI 账号」完成授权。',
    ].join('\n')
  }
  if (!state.enabled) {
    return [
      '## Codex 专业分析通道（dsh-codex）',
      `本机已登录 OpenAI（${state.planLabel || '未知计划'}），但本会话【未授权】使用 Codex。`,
      '- 常规任务全部用你自身的 DeepSeek 能力完成，不要调用 `codex` 工具。',
      '- 若判断任务强度很高、确实需要第二模型做专业分析或构建，先向用户说明理由，',
      '  并提示用户点击输入框左侧的「Codex」按钮授权本会话。',
      '- 授权后本段会自动变成已授权版本，下一轮即可使用。',
    ].join('\n')
  }
  const lines = [
    '## Codex 专业分析通道（dsh-codex）',
    `本会话已由用户【授权】使用 Codex，默认模型：\`${settings.model}\`（订阅：${state.planLabel || '未知'}）。`,
    '- 常规任务（日常问答、简单改动、轻量检索、一般代码编辑）仍由你直接完成，不要调用 codex。',
    settings.autoConsult
      ? '- 出现下列情况时，你应主动调用 `codex` 工具获取独立专业分析或构建结果，再结合环境事实给出最终答案：'
      : '- 用户设置已关闭自主调用；只有用户在本轮明确要求「用 GPT / Codex 分析或构建」时才调用 `codex`；否则一律自己完成。以下情况可提醒用户可以调用：',
    '  · 任务强度高：跨文件架构改动、复杂并发/性能/协议设计、疑难 bug 根因定位；',
    '  · 需要专业判断：安全审计、方案选型、代码评审、算法正确性验证、迁移风险评估；',
    '  · 需要第二模型交叉验证，或用户明确要求 GPT 参与。',
    '- 调用时把目标、验收标准、约束、相关代码与错误信息完整放进 `task`/`context`；',
    '  `mode` 用 `analyze` 做分析评审，用 `build` 让它直接产出可落地代码。',
    '- Codex 输出是专业参考：你负责核对真实环境、执行改动、向用户解释差异与取舍。',
  ]
  return lines.join('\n')
}

// ────────────────────────────── 插件入口 ──────────────────────────────

export function apply(ctx, config) {
  const localOverrides = {}
  const readValue = (key) =>
    Object.prototype.hasOwnProperty.call(localOverrides, key) ? localOverrides[key] : readField(config[key])

  const settingsService = () => {
    try {
      const direct = ctx.get && ctx.get('settings')
      return direct && typeof direct.update === 'function' ? direct : undefined
    } catch {
      return undefined
    }
  }

  const writeConfig = async (patch) => {
    const settings = settingsService()
    if (settings) {
      await settings.update(ENTRY_ID, patch)
      return
    }
    Object.assign(localOverrides, patch)
  }

  const defaultModel = () => {
    const raw = readValue('defaultModel')
    const model = typeof raw === 'string' ? raw.trim() : ''
    return model || DEFAULT_MODEL
  }
  const autoConsult = () => readValue('autoConsult') !== false
  const allowLanAccess = () => readValue('allowLanAccess') === true

  const authStore = createAuthStore({
    env: (typeof process !== 'undefined' && process.env) || {},
    homeDir: () => join(homedir(), '.dsh'),
  })
  const store = createSessionStore({
    env: (typeof process !== 'undefined' && process.env) || {},
    homeDir: () => join(homedir(), '.dsh'),
  })

  /** 模型列表缓存（OAuth 登录后从 OpenAI 拉取）。 */
  let modelsCache = { at: 0, models: [], error: '' }
  /** LLM 适配器注册状态（诊断用，展示在状态路由里）。 */
  let llmAdapterStatus = { registered: false, error: '尚未注册' }

  const getModels = async (credential, force = false) => {
    if (!credential) return { models: [], error: '' }
    if (!force && modelsCache.at > 0 && Date.now() - modelsCache.at < MODELS_TTL_MS) {
      return { models: modelsCache.models, error: modelsCache.error }
    }
    try {
      const models = await fetchCodexModels({
        accessToken: credential.accessToken,
        accountId: credential.accountId,
      })
      modelsCache = { at: Date.now(), models, error: '' }
      return { models, error: '' }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      modelsCache = { at: Date.now(), models: modelsCache.models, error: message }
      return { models: modelsCache.models, error: message }
    }
  }

  /** 当前登录状态（不返回任何 token）。 */
  const authSnapshot = (credential) => {
    const current = credential === undefined ? describeCredential(authStore.read()) : credential
    return current
      ? {
          loggedIn: true,
          email: current.email || '',
          name: current.name || '',
          plan: current.plan || '',
          planLabel: planLabel(current.plan) || '',
          activeStart: current.activeStart || '',
          activeUntil: current.activeUntil || '',
        }
      : { loggedIn: false, email: '', name: '', plan: '', planLabel: '', activeStart: '', activeUntil: '' }
  }

  const effectiveModel = (sessionId) => {
    const state = store.get(sessionId)
    return state.model || defaultModel()
  }

  // ── 1. codex 工具：唯一真正消耗订阅额度的入口 ─────────────────────────────
  const textOutput = {
    schema: { type: 'string' },
    render(_args, value) {
      return [{ type: 'text', text: String(value) }]
    },
  }

  ctx.tools.register({
    name: 'codex',
    description:
      '把高难度任务交给 OpenAI Codex/GPT 做独立的专业分析或代码构建（走用户 ChatGPT 订阅额度，需先登录并授权本会话）。仅当本会话已被用户手动授权后可用；用于复杂架构/疑难 bug/安全审计/方案评审，或用户明确要求 GPT 参与时。普通任务不要调用。',
    parameters: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description: '交给 Codex 的任务或问题。写清目标、验收标准、关键约束；它看不到本会话上下文，必须自包含。',
        },
        mode: {
          type: 'string',
          enum: ['analyze', 'build'],
          description: 'analyze=只做分析/评审/定位（默认）；build=直接产出可落地代码与补丁。',
        },
        context: {
          type: 'string',
          description: '附加上下文：相关代码片段、报错日志、目录结构、已尝试方案与约束。建议尽量完整。',
        },
        model: {
          type: 'string',
          description: '可选：指定本次使用的模型 slug；省略则用会话/全局默认。',
        },
      },
      required: ['task'],
      additionalProperties: false,
    },
    output: textOutput,
    timeoutMs: CODEX_TIMEOUT_MS + 30_000,
    async execute(args, exec) {
      const sessionId = exec && exec.agent && exec.agent.id ? String(exec.agent.id) : ''
      if (!sessionId) return '无法确定当前会话，已拒绝调用 Codex。请在正常会话中重试。'

      const credential = await ensureAccessToken(authStore)
      if (!credential) {
        return [
          'Codex 不可用：本机尚未登录 OpenAI 账号。',
          '请让用户打开 设置 →「Codex」页，点击「登录 OpenAI 账号」完成浏览器授权后重试。',
        ].join('\n')
      }

      const state = store.get(sessionId)
      if (!state.enabled) {
        return [
          '本会话未授权使用 Codex，调用已被拒绝。',
          '请让用户点击输入框左侧的「Codex」按钮授权本会话（或在设置页打开），授权后重试。',
          '在授权前继续用你自身的 DeepSeek 能力完成任务；不要重复尝试调用。',
        ].join('\n')
      }

      const task = typeof args?.task === 'string' ? args.task.trim() : ''
      if (!task) return 'codex 调用缺少 task：请把要分析/构建的任务写进 task 参数。'
      const context = typeof args?.context === 'string' ? args.context.trim() : ''
      const mode = args?.mode === 'build' ? 'build' : 'analyze'
      const requested = typeof args?.model === 'string' ? args.model.trim() : ''
      const model = requested || effectiveModel(sessionId)

      const timeout = AbortSignal.timeout(CODEX_TIMEOUT_MS)
      const signal =
        exec && exec.signal && typeof AbortSignal.any === 'function'
          ? AbortSignal.any([exec.signal, timeout])
          : timeout

      const startedAt = Date.now()
      try {
        const result = await callCodexBackend({
          accessToken: credential.accessToken,
          accountId: credential.accountId,
          model,
          mode,
          task,
          context,
          signal,
        })
        const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1)
        return [`[Codex · ${result.model} · ${mode}] 耗时 ${elapsed}s（${result.endpoint}）`, '', result.text].join('\n')
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error))
        if (failure.name === 'AbortError' || failure.name === 'TimeoutError') {
          return `Codex 调用超时或被取消（${Math.round(CODEX_TIMEOUT_MS / 1000)}s 上限）。可以缩小任务后重试。`
        }
        const message = failure.message || String(failure)
        if (/HTTP 401|HTTP 403|unauthorized|forbidden/i.test(message)) {
          return [
            'Codex 调用失败：OpenAI 登录凭证被拒绝（可能已过期或账号未开通 Codex）。',
            '请让用户在 设置 →「Codex」页重新登录后再试。',
            message,
          ].join('\n')
        }
        return `Codex 调用失败：${message}\n可检查设置里的外网连通性后重试。`
      }
    },
  })

  // ── 2. 每会话提示策略：随组装上下文求值，开关切换后下一轮即生效 ─────────────
  const scopeSessionId = (context) => {
    if (!context || typeof context !== 'object') return ''
    const candidates = [
      context.agent && context.agent.id,
      context.agent && context.agent.session && context.agent.session.id,
      context.scope && context.scope.id,
      context.scope && context.scope.agent && context.scope.agent.id,
      context.session && context.session.id,
    ]
    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate) return candidate
    }
    return ''
  }

  const policyFor = (sessionId) => {
    const credential = describeCredential(authStore.read())
    const state = store.get(sessionId)
    return renderPolicy(
      {
        loggedIn: Boolean(credential),
        enabled: state.enabled,
        planLabel: planLabel(credential && credential.plan) || '',
      },
      { model: effectiveModel(sessionId), autoConsult: autoConsult() },
    )
  }

  ctx.systemPrompt.section({
    name: 'dsh-codex-policy',
    order: POLICY_ORDER,
    text: (context) => {
      const sessionId = scopeSessionId(context)
      if (!sessionId) return ''
      return policyFor(sessionId)
    },
  })

  // ── 3. 设置页：关闭自动生成表单（本插件自带 Codex 设置页） ─────────────────
  try {
    ctx.inject(['settings'], (child) => {
      try {
        child.effect(() => child.settings.configure({ auto: false }, ctx.fiber), 'dsh-codex: 关闭自动表单')
      } catch (error) {
        warn('关闭自动设置表单失败', error)
      }
    })
  } catch (error) {
    warn('settings 服务不可用，保留默认设置表单', error)
  }

  // ── 4. 浏览器 UI 的状态通道（同源 HTTP；Origin/Content-Type 校验防 CSRF） ───
  const expectedOrigin = () => {
    try {
      return ctx.webServer && typeof ctx.webServer.getOrigin === 'function' ? ctx.webServer.getOrigin() : ''
    } catch {
      return ''
    }
  }

  /** 请求守卫：回环 / Origin / Sec-Fetch-Site / Host / Content-Type。 */
  const rejectReason = (req) => {
    if (!isLoopback(req) && !allowLanAccess()) return '仅允许本机访问；如需局域网访问请在设置中开启 allowLanAccess。'
    const origin = req.headers.origin
    const expected = expectedOrigin()
    if (origin && expected && origin !== expected) return '跨站请求被拒绝。'
    const site = req.headers['sec-fetch-site']
    if (site && site !== 'same-origin' && site !== 'none') return '跨站请求被拒绝。'
    if (!allowLanAccess() && expected) {
      try {
        const expectedHost = new URL(expected).host
        if (req.headers.host && String(req.headers.host) !== expectedHost) return 'Host 不匹配。'
      } catch {
        // expected 不是合法 URL 时跳过 Host 校验
      }
    }
    if (req.method === 'POST' && !/^application\/json\b/i.test(String(req.headers['content-type'] || ''))) {
      return 'POST 需要 application/json。'
    }
    return ''
  }

  const snapshot = (sessionId, credential) => {
    const auth = authSnapshot(credential)
    let llmProviders = []
    try {
      llmProviders = ctx.llm.listProviders().map((provider) => ({ id: provider.id, name: provider.name }))
    } catch {
      llmProviders = []
    }
    return {
      ok: true,
      auth,
      llm: { providers: llmProviders, adapter: llmAdapterStatus },
      global: {
        defaultModel: defaultModel(),
        autoConsult: autoConsult(),
        allowLanAccess: allowLanAccess(),
      },
      session: sessionId ? { ...store.get(sessionId), model: effectiveModel(sessionId) } : null,
    }
  }

  const applyOp = async (body) => {
    const op = typeof body.op === 'string' ? body.op : ''
    const sessionId = normalizeSessionId(body.sessionId)

    if (op === 'setSessionEnabled') {
      if (!sessionId) throw new Error('缺少或非法的 sessionId')
      store.set(sessionId, { enabled: body.enabled === true })
      return
    }
    if (op === 'setSessionModel') {
      if (!sessionId) throw new Error('缺少或非法的 sessionId')
      const model = typeof body.model === 'string' ? body.model.trim().slice(0, 200) : ''
      store.set(sessionId, { model })
      return
    }
    if (op === 'setGlobal') {
      const patch = body.patch && typeof body.patch === 'object' ? body.patch : {}
      const next = {}
      if (typeof patch.defaultModel === 'string' && patch.defaultModel.trim()) {
        next.defaultModel = patch.defaultModel.trim()
      }
      if (typeof patch.autoConsult === 'boolean') next.autoConsult = patch.autoConsult
      if (typeof patch.allowLanAccess === 'boolean') next.allowLanAccess = patch.allowLanAccess
      if (Object.keys(next).length > 0) await writeConfig(next)
      return
    }
    if (op === 'login') {
      const { url } = await beginLogin({ store: authStore })
      return { url }
    }
    if (op === 'logout') {
      await cancelLogin()
      authStore.clear()
      modelsCache = { at: 0, models: [], error: '' }
      return
    }
    if (op === 'listModels') {
      const credential = await ensureAccessToken(authStore)
      if (!credential) throw new Error('尚未登录 OpenAI 账号')
      return await getModels(credential, true)
    }
    if (op === 'testCodex') {
      const credential = await ensureAccessToken(authStore)
      if (!credential) throw new Error('尚未登录 OpenAI 账号')
      const startedAt = Date.now()
      const { models, error } = await getModels(credential, true)
      if (error && models.length === 0) throw new Error(error)
      return { latencyMs: Date.now() - startedAt, count: models.length }
    }
    if (op === 'resetCredits') {
      const credential = await ensureAccessToken(authStore)
      if (!credential) throw new Error('尚未登录 OpenAI 账号')
      return await fetchResetCredits({
        accessToken: credential.accessToken,
        accountId: credential.accountId,
      })
    }
    if (op === 'consumeReset') {
      const credential = await ensureAccessToken(authStore)
      if (!credential) throw new Error('尚未登录 OpenAI 账号')
      // 未指定 creditId 时先取最早过期的一张；列表不可用时交给服务端自选。
      let creditId = typeof body.creditId === 'string' && body.creditId.trim() ? body.creditId.trim() : ''
      if (!creditId) {
        try {
          const list = await fetchResetCredits({
            accessToken: credential.accessToken,
            accountId: credential.accountId,
          })
          creditId = list.credits[0]?.id || ''
        } catch {
          creditId = ''
        }
      }
      const result = await consumeResetCredit({
        accessToken: credential.accessToken,
        accountId: credential.accountId,
        creditId,
      })
      // 兑换后旧用量缓存必须失效，否则卡片还要等 60 秒才更新。
      __resetUsageCache()
      return result
    }
    if (op === 'testNetwork') {
      return await checkConnectivity({ timeoutMs: 8_000 })
    }
    throw new Error(`未知操作：${op || '(空)'}`)
  }

  const handler = async (req, res) => {
    try {
      const rejection = rejectReason(req)
      if (rejection) {
        sendJson(res, 403, { ok: false, error: rejection })
        return
      }
      const url = new URL(String(req.url || '/'), 'http://localhost')
      const pathname = url.pathname.replace(/\/+$/, '')
      if (pathname !== ROUTE) {
        sendJson(res, 404, { ok: false, error: 'not found' })
        return
      }
      if (req.method === 'GET') {
        if (url.searchParams.get('usage') === '1') {
          const credential = describeCredential(authStore.read())
          const usage = await getCodexUsage({
            env: (typeof process !== 'undefined' && process.env) || {},
            credential,
          })
          sendJson(res, 200, { ok: true, usage })
          return
        }
        if (url.searchParams.get('auth') === '1') {
          sendJson(res, 200, { ok: true, auth: authSnapshot() })
          return
        }
        if (url.searchParams.get('models') === '1') {
          const credential = await ensureAccessToken(authStore)
          if (!credential) {
            sendJson(res, 200, { ok: true, models: [], error: '尚未登录 OpenAI 账号' })
            return
          }
          const { models, error } = await getModels(credential, false)
          sendJson(res, 200, { ok: true, models, error })
          return
        }
        if (url.searchParams.get('resets') === '1') {
          const credential = await ensureAccessToken(authStore)
          if (!credential) {
            sendJson(res, 200, { ok: true, result: { availableCount: 0, credits: [] }, error: '尚未登录 OpenAI 账号' })
            return
          }
          const credits = await fetchResetCredits({
            accessToken: credential.accessToken,
            accountId: credential.accountId,
          })
          sendJson(res, 200, { ok: true, result: credits })
          return
        }
        const sessionId = normalizeSessionId(url.searchParams.get('sessionId') || '')
        sendJson(res, 200, snapshot(sessionId))
        return
      }
      if (req.method === 'POST') {
        const body = await readJsonBody(req)
        const extra = await applyOp(body)
        const sessionId = normalizeSessionId(body.sessionId)
        const credential = describeCredential(authStore.read())
        sendJson(res, 200, { ...snapshot(sessionId, credential), result: extra })
        return
      }
      sendJson(res, 405, { ok: false, error: 'method not allowed' })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      sendJson(res, 400, { ok: false, error: message })
    }
  }

  try {
    ctx.effect(
      () => ctx.webServer.register({ kind: 'prefix', path: ROUTE, handler }),
      'dsh-codex-gpt: /dsh-codex-api 状态路由',
    )
  } catch (error) {
    warn('状态路由注册失败', error)
  }

  // ── 5. LLM 适配器：把 ChatGPT (Codex) 接进模型选择器 ───────────────────────
  // 选中该 provider 的模型后，对话直接由 GPT 处理（读上下文、流式回复、工具调用）。
  try {
    ctx.effect(() => {
      try {
        const handle = ctx.llm.registerAdapter(
          ['chatgpt-codex'],
          createCodexGptAdapter({
            getCredential: async () => {
              const credential = await ensureAccessToken(authStore)
              return credential
                ? { accessToken: credential.accessToken, accountId: credential.accountId }
                : undefined
            },
            fetchModels: (credential) =>
              fetchCodexModels({ accessToken: credential.accessToken, accountId: credential.accountId }),
          }),
        )
        llmAdapterStatus = { registered: true, error: '' }
        return () => {
          try {
            handle()
          } catch {
            // 已释放
          }
        }
      } catch (error) {
        llmAdapterStatus = {
          registered: false,
          error: error instanceof Error ? error.message : String(error),
        }
        throw error
      }
    }, 'dsh-codex-gpt: ChatGPT LLM 适配器')
  } catch (error) {
    warn('LLM 适配器注册失败（模型列表里不会出现 ChatGPT）', error)
  }

  console.log(`[dsh-codex-gpt] activated (entry=${ENTRY_ID}, oauth, llm=chatgpt-codex, route=${ROUTE})`)
}
