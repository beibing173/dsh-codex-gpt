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
import { readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir, networkInterfaces } from 'node:os'
import { randomBytes, createHash } from 'node:crypto'
import { callCodexBackend, fetchCodexModels, fetchResetCredits, consumeResetCredit } from './codex.js'
import { getCodexUsage, __resetUsageCache } from './usage.js'
import { fetchDeepseekBalance, peakState } from './deepseek.js'
import { checkConnectivity } from './network.js'
import { createAuthStore, ensureAccessToken, beginLogin, cancelLogin, describeCredential } from './oauth.js'
import { createCodexGptAdapter, LEGACY_PROVIDER_IDS, PROVIDER_ID } from './llm-adapter.js'

export const name = 'dsh-codex-gpt'

/** 插件版本：直接读同目录 package.json，避免两处手写导致版本号对不上。 */
export const PLUGIN_VERSION = (() => {
  try {
    const parsed = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))
    return typeof parsed.version === 'string' ? parsed.version : ''
  } catch {
    return ''
  }
})()

/** profile 条目 id：cordis.patch.yml 里 `- id: dsh-codex-gpt` 必须与此一致。 */
export const ENTRY_ID = 'dsh-codex-gpt'

/** Host 依赖：工具注册、提示组装、状态路由（与 dsh-meme 一致），外加 LLM 适配器注册与图片读取。 */
export const inject = ['tools', 'systemPrompt', 'webServer', 'llm', 'attachments']

export const ROUTE = '/dsh-codex-api'
/**
 * 写操作令牌：进程级随机值，只通过同源 GET 快照发给本机页面。
 * 跨站页面能发出请求但读不到响应体，因此拿不到令牌，写操作无法伪造——
 * 这也是反向代理场景下 socket 地址失去意义后的兜底防线。
 */
const WRITE_TOKEN = randomBytes(16).toString('hex')
/** 单次 Codex 调用超时（毫秒）。 */
const CODEX_TIMEOUT_MS = 240_000
/** codex 工具入参上限：防止超大文本导致上游费用与内存问题。 */
const MAX_TASK_CHARS = 100_000
const MAX_CONTEXT_CHARS = 400_000
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
    .description('默认使用的 ChatGPT 模型（候选从 OpenAI 实时拉取）。')
    .volatile(),
  autoConsult: z
    .boolean()
    .default(true)
    .description('允许 DeepSeek 在已授权会话里根据任务强度自主调用 ChatGPT；关闭后只在用户明确要求时调用。')
    .volatile(),
  allowLanAccess: z
    .boolean()
    .default(false)
    .description('允许局域网设备通过 Web UI 只读查看本插件状态；写操作始终仅限本机。')
    .volatile(),
  delegateLightTasks: z
    .boolean()
    .default(false)
    .description('GPT（ChatGPT）模式下，允许把轻量任务交给 DeepSeek V4.1 协作完成并收尾；独立开关，可随时关闭。')
    .volatile(),
  deepseekModel: z
    .string()
    .default('')
    .description('轻任务委派使用的 DeepSeek 模型 id；留空则自动选择当前可用模型。')
    .volatile(),
  gptNameDetect: z
    .boolean()
    .default(false)
    .description(
      '保险开关：开启后，若其他 provider 提供的模型 id 也形如 gpt-* / o3-*，输入框胶囊同样按「GPT」识别（显示 DeepSeek）。默认关闭，只认本插件的 ChatGPT provider。',
    )
    .volatile(),
  dashboardOnly: z
    .boolean()
    .default(false)
    .description(
      '仅看板模式：开启后不注册 ChatGPT 模型、codex 工具、会话授权策略与用量凭证同步，只保留侧边栏看板。切换后需禁用→启用插件才完全生效。',
    )
    .volatile(),
  defaultUsageTab: z
    .string()
    .default('auto')
    .description('侧边栏用量卡默认展示哪一家：auto（跟随当前在用的模型）、chatgpt、deepseek，或其它 AI 的 provider id。点卡片可临时切换。')
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

/** 是否本机回环请求。经过代理/隧道（带转发头）时一律视为远程，避免 LAN 隔离被绕过。 */
function isLoopback(req) {
  const headers = (req && req.headers) || {}
  if (headers['x-forwarded-for'] || headers['x-real-ip'] || headers['forwarded'] || headers['cf-connecting-ip']) {
    return false
  }
  const address = (req && req.socket && req.socket.remoteAddress) || ''
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/** 站点默认端口（同源比较时补全）。 */
function defaultPort(protocol) {
  return protocol === 'https:' ? '443' : '80'
}

/**
 * 同源判断：协议 + 端口一致，且主机名属于本机白名单。
 * 127.0.0.1 / localhost / [::1] 指向同一进程，互相访问都算同源；外部域名即使伪造 Origin 也会被拒。
 */
function isSameOrigin(originValue, expectedValue) {
  try {
    const incoming = new URL(String(originValue))
    const expected = new URL(String(expectedValue))
    if (incoming.protocol !== expected.protocol) return false
    if ((incoming.port || defaultPort(incoming.protocol)) !== (expected.port || defaultPort(expected.protocol))) {
      return false
    }
    return isAllowedHost(incoming.hostname.toLowerCase())
  } catch {
    return String(originValue) === String(expectedValue)
  }
}

/** 本机允许的 Host 名（回环 + 本机网卡地址）。LAN 模式也用它挡 DNS rebinding。 */
function isAllowedHost(hostname) {
  if (!hostname) return true
  const allowed = new Set(['127.0.0.1', 'localhost', '::1', '0.0.0.0'])
  try {
    for (const list of Object.values(networkInterfaces())) {
      for (const info of list || []) {
        if (info && typeof info.address === 'string') allowed.add(info.address.toLowerCase())
      }
    }
  } catch {
    // 读取网卡失败时只保留回环名
  }
  return allowed.has(hostname)
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
      '## ChatGPT 专业分析通道（dsh-codex）',
      '本机尚未登录 OpenAI 账号，ChatGPT 当前不可用。',
      '- 常规任务全部用你自身的 DeepSeek 能力完成，不要调用 `codex` 工具。',
      '- 若用户需要 GPT/Codex 参与，提示用户打开 设置 →「ChatGPT」页，点击「登录 OpenAI 账号」完成授权。',
    ].join('\n')
  }
  if (!state.enabled) {
    return [
      '## ChatGPT 专业分析通道（dsh-codex）',
      `本机已登录 OpenAI（${state.planLabel || '未知计划'}），但本会话【未授权】使用 ChatGPT。`,
      '- 常规任务全部用你自身的 DeepSeek 能力完成，不要调用 `codex` 工具。',
      '- 若判断任务强度很高、确实需要第二模型做专业分析或构建，先向用户说明理由，',
      '  并提示用户点击输入框左侧的「ChatGPT」按钮授权本会话。',
      '- 授权后本段会自动变成已授权版本，下一轮即可使用。',
    ].join('\n')
  }
  const lines = [
    '## ChatGPT 专业分析通道（dsh-codex）',
    `本会话已由用户【授权】使用 ChatGPT，默认模型：\`${settings.model === 'auto' ? '自动选择' : settings.model}\`（订阅：${state.planLabel || '未知'}）。`,
    '- 常规任务（日常问答、简单改动、轻量检索、一般代码编辑）仍由你直接完成，不要调用 codex。',
    settings.autoConsult
      ? '- 出现下列情况时，你应主动调用 `codex` 工具获取独立专业分析或构建结果，再结合环境事实给出最终答案：'
      : '- 用户设置已关闭自主调用；只有用户在本轮明确要求「用 GPT / Codex 分析或构建」时才调用 `codex`；否则一律自己完成。以下情况可提醒用户可以调用：',
    '  · 任务强度高：跨文件架构改动、复杂并发/性能/协议设计、疑难 bug 根因定位；',
    '  · 需要专业判断：安全审计、方案选型、代码评审、算法正确性验证、迁移风险评估；',
    '  · 需要第二模型交叉验证，或用户明确要求 GPT 参与。',
    '- 调用时把目标、验收标准、约束、相关代码与错误信息完整放进 `task`/`context`；',
    '  `mode` 用 `analyze` 做分析评审，用 `build` 让它直接产出可落地代码。',
    '- ChatGPT 输出是专业参考：你负责核对真实环境、执行改动、向用户解释差异与取舍。',
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

  /** 自动选择的模型 id：最近一次拉取的可用列表第一个（用户没显式选模型时用它）。 */
  /** 用户显式选择的 GPT 模型（空字符串 = 自动选择）。 */
  const configuredModel = () => {
    const raw = readValue('defaultModel')
    return typeof raw === 'string' ? raw.trim() : ''
  }
  /** 自动选择 GPT 模型：长上下文/复杂任务用强模型，否则用轻模型。 */
  const autoGptModel = (text) => {
    const models = modelsCache.models || []
    if (models.length === 0) return DEFAULT_MODEL
    const strong = models.find((model) => /6\.1|6-|sol|terra/i.test(model.slug))
    const light = models.find((model) => /5\.6|flash|luna/i.test(model.slug)) || models[0]
    return (String(text || '').length > 12_000 && strong ? strong : light).slug
  }
  const defaultModel = () => {
    const configured = configuredModel()
    if (configured && configured !== 'auto') return configured
    return 'auto'
  }
  const autoConsult = () => readValue('autoConsult') !== false
  const allowLanAccess = () => readValue('allowLanAccess') === true
  const delegateLightTasks = () => readValue('delegateLightTasks') === true
  /** 保险开关：是否按模型名把其他 provider 的 GPT 模型也算作 GPT（默认关闭）。 */
  const gptNameDetect = () => readValue('gptNameDetect') === true
  /** 仅看板模式：关闭所有 GPT/Codex 功能，只留用量看板（默认关闭）。 */
  const dashboardOnly = () => readValue('dashboardOnly') === true
  /** 侧边栏用量卡默认展示哪一家：'auto'（跟随当前模型）或具体 provider id。 */
  const defaultUsageTab = () => {
    const raw = readValue('defaultUsageTab')
    const value = typeof raw === 'string' ? raw.trim() : ''
    return value || 'auto'
  }

  /**
   * 当前「在用」的模型选择（DSH 的 agentDefaultModel）。
   * 用量卡的 auto 模式据此决定先显示 ChatGPT 还是 DeepSeek。
   */
  const currentModelSelection = () => {
    try {
      const service = ctx.get('agentDefaultModel')
      const selection = service && typeof service.currentSelection === 'function' ? service.currentSelection() : null
      if (!selection) return null
      return {
        provider: typeof selection.provider === 'string' ? selection.provider : '',
        model: typeof selection.model === 'string' ? selection.model : '',
      }
    } catch {
      return null
    }
  }
  const delegateModel = () => {
    const raw = readValue('deepseekModel')
    return typeof raw === 'string' ? raw.trim() : ''
  }

  const authStore = createAuthStore({
    env: (typeof process !== 'undefined' && process.env) || {},
    homeDir: () => join(homedir(), '.dsh'),
  })
  const store = createSessionStore({
    env: (typeof process !== 'undefined' && process.env) || {},
    homeDir: () => join(homedir(), '.dsh'),
  })

  /**
   * 模型目录的落盘缓存（$DSH_HOME/dsh-codex-models.json）。
   * 目的是让插件刚启动、上游还没返回时，模型选择器也能拿到上次的完整目录——
   * 否则只给兜底模型，用户选中的模型会"消失"，必须手动重选一次。
   */
  const modelsCacheStore = (() => {
    const env = (typeof process !== 'undefined' && process.env) || {}
    const file = () => join(env.DSH_HOME || join(homedir(), '.dsh'), 'dsh-codex-models.json')
    /** 缓存属于哪个账号（只存不可逆指纹，避免把账号标识明文落盘）。 */
    const accountKeyOf = (accountId) => {
      const raw = typeof accountId === 'string' ? accountId.trim() : ''
      if (!raw) return ''
      return createHash('sha256').update(raw).digest('hex').slice(0, 32)
    }
    const readPayload = () => {
      try {
        const parsed = JSON.parse(readFileSync(file(), 'utf8'))
        return parsed && typeof parsed === 'object' ? parsed : null
      } catch {
        return null
      }
    }
    return {
      accountKeyOf,
      /** 落盘缓存记录的账号指纹（没有就是旧格式/未知）。 */
      storedAccountKey() {
        const parsed = readPayload()
        return parsed && typeof parsed.accountKey === 'string' ? parsed.accountKey : ''
      },
      load() {
        try {
          const parsed = readPayload()
          const models = parsed && Array.isArray(parsed.models) ? parsed.models : []
          return models.filter((model) => model && typeof model.slug === 'string' && model.slug)
        } catch {
          return []
        }
      },
      save(models, accountId) {
        const target = file()
        const payload = { version: 2, at: Date.now(), accountKey: accountKeyOf(accountId), models }
        try {
          mkdirSync(dirname(target), { recursive: true })
          const tmp = `${target}.${process.pid}.tmp`
          writeFileSync(tmp, JSON.stringify(payload), 'utf8')
          renameSync(tmp, target)
        } catch (error) {
          warn('模型目录缓存写入失败（不影响本次使用）', error)
        }
      },
      /** 换账号/登出时清掉，避免把上一账号的模型目录带过来。 */
      clear() {
        try {
          unlinkSync(file())
        } catch {
          // 没有文件也算清干净了
        }
      },
    }
  })()

  /**
   * 读 DSH 的界面语言（`profiles/<name>/cordis.patch.yml` 里 `- id: locale` 的 preference）。
   * 这是配置里的真实值，比在浏览器端猜 `<html lang>` 可靠：客户端卡片用它决定中/英。
   */
  const readUiLocale = () => {
    const env = (typeof process !== 'undefined' && process.env) || {}
    const root = env.DSH_HOME || join(homedir(), '.dsh')
    const profiles = join(root, 'profiles')
    const parse = (text) => {
      const block = /- id: locale[\s\S]{0,400}?preference:\s*['"]?([A-Za-z-]+)/.exec(text || '')
      return block ? block[1].toLowerCase() : ''
    }
    try {
      for (const name of readdirSync(profiles)) {
        try {
          const value = parse(readFileSync(join(profiles, name, 'cordis.patch.yml'), 'utf8'))
          if (value) return value
        } catch {
          // 该 profile 没有配置文件就跳过
        }
      }
    } catch {
      // 读不到 profiles 目录就当未知
    }
    return ''
  }

  /** 模型列表缓存（OAuth 登录后从 OpenAI 拉取）。 */
  let modelsCache = { at: 0, models: [], error: '' }

  /** DeepSeek 余额缓存：30 秒内复用，避免看板频繁请求上游。 */
  let deepseekBalanceCache = { at: 0, value: null, key: '' }

  /** 读 DeepSeek API Key：先环境变量，再 DSH 的 credentials 服务。 */
  const readDeepseekApiKey = async () => {
    const env = (typeof process !== 'undefined' && process.env) || {}
    for (const name of ['DEEPSEEK_API_KEY', 'DEEPSEEK_OFFICIAL_API_KEY', 'DEEPSEEK_ACCOUNT_API_KEY']) {
      const value = env[name]
      if (typeof value === 'string' && value.trim()) return { key: value.trim(), source: name }
    }
    try {
      const credentials = ctx.get('credentials')
      if (credentials && typeof credentials.resolve === 'function') {
        for (const name of ['DEEPSEEK_API_KEY', 'DEEPSEEK_OFFICIAL_API_KEY']) {
          const hit = await credentials.resolve(name)
          const value = hit && typeof hit.value === 'string' ? hit.value.trim() : ''
          if (value) return { key: value, source: name }
        }
      }
    } catch {
      // 读不到就当作没配
    }
    return { key: '', source: '' }
  }

  /** 余额（10 秒缓存；force 时绕过缓存立即查上游；没配 Key 时直接返回未配置）。 */
  const readDeepseekBalanceCached = async (force = false) => {
    const { key, source } = await readDeepseekApiKey()
    if (!key) return { available: false, total: null, currency: '', error: '未配置 DEEPSEEK_API_KEY', source: '' }
    const env = (typeof process !== 'undefined' && process.env) || {}
    const baseUrl = typeof env.DEEPSEEK_BASE_URL === 'string' ? env.DEEPSEEK_BASE_URL : ''
    // 缓存键必须带上 Key 指纹与端点：同一来源换了 Key（换账号）不能复用上一账号的余额。
    const cacheKey = `${source}\u0000${baseUrl}\u0000${createHash('sha256').update(key).digest('hex').slice(0, 32)}`
    const at = Date.now()
    if (!force && deepseekBalanceCache.value && deepseekBalanceCache.key === cacheKey && at - deepseekBalanceCache.at < 10_000) {
      return deepseekBalanceCache.value
    }
    const value = { ...(await fetchDeepseekBalance({ apiKey: key, baseUrl })), source }
    // 失败不覆盖上一次成功的缓存，避免一次网络抖动就把金额清空。
    if (value.total !== null || !deepseekBalanceCache.value || deepseekBalanceCache.key !== cacheKey) {
      deepseekBalanceCache = { at, value, key: cacheKey }
    }
    return value
  }
  /** 模型列表单飞：并发刷新共用一次上游请求。 */
  let inflightModels = null
  /** LLM 适配器注册状态（诊断用，展示在状态路由里）。 */
  let llmAdapterStatus = { registered: false, error: '尚未注册', directory: { registered: false, error: '尚未注册' } }

  /**
   * 把 ChatGPT 的 OAuth 令牌同步到「用量类插件」读的那两个凭证引用。
   *
   * @dougen/dsh-deepseek-usage 这类插件按 provider id `openai-codex` 找账户接口，
   * 令牌只从自己的引用 `DSH_USAGE_CODEX_OAUTH_TOKEN` / `..._ACCOUNT_ID` 读。
   * 本插件的令牌存在自己的 $DSH_HOME/dsh-codex-auth.json 里，两边不通，于是它只能
   * 显示「尚未填写该提供商的 OAuth 令牌」。这里在登录/刷新后写一次同一个引用，
   * 让那张用量卡自己就能读到（写入经 DSH 的 credentials 服务，格式与它自己写入的一致）。
   *
   * 失败一律静默：同步不上只是那张卡不显示数字，绝不影响对话。
   */
  const USAGE_TOKEN_REF = 'DSH_USAGE_CODEX_OAUTH_TOKEN'
  const USAGE_ACCOUNT_REF = 'DSH_USAGE_CODEX_ACCOUNT_ID'
  /** 同步节流：写凭证会让 DSH 视为「凭证变了」而重拉模型目录，太频繁会一直闪。 */
  const USAGE_SYNC_THROTTLE_MS = 60_000
  let usageSyncStatus = { ok: null, at: 0, error: '', attempts: 0 }
  let lastSyncedUsageKey = ''
  let usageSyncTriedAt = 0

  /** 凭证写入串行化：并发写会重复广播变更事件，登出也可能被在途同步覆盖。 */
  let credentialQueue = Promise.resolve()
  const enqueueCredentialMutation = (task) => {
    const run = credentialQueue.then(task, task)
    credentialQueue = run.then(
      () => {},
      () => {},
    )
    return run
  }

  /** 只有值真的变了才写，避免无谓的 credentials 变更事件（会触发模型目录重拉）。 */
  const setCredentialIfChanged = async (credentials, ref, value) => {
    try {
      if (typeof credentials.resolve === 'function') {
        const current = await credentials.resolve(ref)
        const existing = current && typeof current.value === 'string' ? current.value : ''
        if (existing === value) return false
      }
    } catch {
      // 读不到就当需要写
    }
    await credentials.set(ref, value)
    return true
  }

  const unsetCredentialIfPresent = async (credentials, ref) => {
    if (!credentials || typeof credentials.unset !== 'function') return false
    try {
      if (typeof credentials.resolve === 'function') {
        const current = await credentials.resolve(ref)
        const existing = current && typeof current.value === 'string' ? current.value : ''
        if (!existing) return false
      }
    } catch {
      // 读不到就按「可能需要清」处理
    }
    await credentials.unset(ref)
    return true
  }

  /** 错误信息落盘/回显前脱敏：去掉形似凭证的长串。 */
  const redactMessage = (error) => {
    const raw = error instanceof Error ? error.message : String(error)
    return raw.replace(/[A-Za-z0-9_\-.]{24,}/g, '[redacted]').slice(0, 160)
  }

  const syncUsageCredential = async (credential) =>
    enqueueCredentialMutation(async () => {
      try {
        const accessToken = credential && credential.accessToken
        if (!accessToken) return
        const key = `${accessToken}\u0000${credential.accountId || ''}`
        if (key === lastSyncedUsageKey) return
        const credentials = ctx.get('credentials')
        if (!credentials || typeof credentials.set !== 'function') return
        usageSyncStatus = { ...usageSyncStatus, attempts: usageSyncStatus.attempts + 1 }
        await setCredentialIfChanged(credentials, USAGE_TOKEN_REF, accessToken)
        if (credential.accountId) {
          await setCredentialIfChanged(credentials, USAGE_ACCOUNT_REF, credential.accountId)
        } else {
          // 新凭证没有 accountId 时必须清旧值，否则消费者会拿上一个账号的 id 去查。
          await unsetCredentialIfPresent(credentials, USAGE_ACCOUNT_REF)
        }
        lastSyncedUsageKey = key
        usageSyncStatus = { ok: true, at: Date.now(), error: '', attempts: usageSyncStatus.attempts }
      } catch (error) {
        usageSyncStatus = {
          ok: false,
          at: Date.now(),
          error: redactMessage(error),
          attempts: usageSyncStatus.attempts,
        }
      }
    })

  /**
   * 节流版同步：只在读取快照/激活时偶尔试一次。
   * 绝不在模型列表这种高频路径上写凭证——那会触发 DSH 的凭证变更事件，
   * 进而重拉模型目录，形成「一闪一闪」的刷新风暴。
   */
  const maybeSyncUsage = async () => {
    const at = Date.now()
    if (at - usageSyncTriedAt < USAGE_SYNC_THROTTLE_MS) return
    usageSyncTriedAt = at
    try {
      const credential = await ensureAccessToken(authStore, { noRefresh: true })
      if (credential && credential.accessToken) await syncUsageCredential(credential)
    } catch {
      // 同步失败只影响用量卡
    }
  }


  /** 拉一次模型目录（单飞）；并发调用共用同一次上游请求。 */
  const refreshModels = async (credential) => {
    if (inflightModels) return inflightModels
    inflightModels = (async () => {
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
    })()
    try {
      return await inflightModels
    } finally {
      inflightModels = null
    }
  }

  const getModels = async (credential, force = false) => {
    if (!credential) return { models: [], error: '' }
    const fresh = modelsCache.at > 0 && Date.now() - modelsCache.at < MODELS_TTL_MS
    if (!force && fresh) {
      return { models: modelsCache.models, error: modelsCache.error }
    }
    // 过期但还有旧目录：先给旧的，后台续期，别让设置页/下拉框等网络。
    if (!force && modelsCache.models.length > 0) {
      void refreshModels(credential)
      return { models: modelsCache.models, error: modelsCache.error }
    }
    return refreshModels(credential)
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

  if (!dashboardOnly()) {
  ctx.tools.register({
    name: 'codex',
    description:
      '把高难度任务交给 OpenAI ChatGPT 做独立的专业分析或代码构建（走用户 ChatGPT 订阅额度，需先登录并授权本会话）。仅当本会话已被用户手动授权后可用；用于复杂架构/疑难 bug/安全审计/方案评审，或用户明确要求 GPT 参与时。普通任务不要调用。',
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
      if (!sessionId) return '无法确定当前会话，已拒绝调用 ChatGPT。请在正常会话中重试。'

      // 先用内存/磁盘里的凭证判断登录态（不触发网络），再判会话授权。
      const loggedIn = Boolean(describeCredential(authStore.read()))
      if (!loggedIn) {
        return [
          'ChatGPT 不可用：本机尚未登录 OpenAI 账号。',
          '请让用户打开 设置 →「ChatGPT」页，点击「登录 OpenAI 账号」完成浏览器授权后重试。',
        ].join('\n')
      }

      const state = store.get(sessionId)
      if (!state.enabled) {
        return [
          '本会话未授权使用 ChatGPT，调用已被拒绝。',
          '请让用户点击输入框左侧的「ChatGPT」按钮授权本会话（或在设置页打开），授权后重试。',
          '在授权前继续用你自身的 DeepSeek 能力完成任务；不要重复尝试调用。',
        ].join('\n')
      }

      const credential = await ensureAccessToken(authStore)
      if (!credential) {
        return [
          'ChatGPT 不可用：本机尚未登录 OpenAI 账号。',
          '请让用户打开 设置 →「ChatGPT」页，点击「登录 OpenAI 账号」完成浏览器授权后重试。',
        ].join('\n')
      }

      const task = typeof args?.task === 'string' ? args.task.trim().slice(0, MAX_TASK_CHARS) : ''
      if (!task) return 'codex 调用缺少 task：请把要分析/构建的任务写进 task 参数。'
      const context = typeof args?.context === 'string' ? args.context.trim().slice(0, MAX_CONTEXT_CHARS) : ''
      const mode = args?.mode === 'build' ? 'build' : 'analyze'
      const requested = typeof args?.model === 'string' ? args.model.trim() : ''
      const configured = configuredModel()
      // 会话里存的模型若是「自动选择」，要按任务现算，不能把 'auto' 当 slug 发给后端。
      const sessionModel = state.model && state.model !== 'auto' ? state.model : ''
      const model =
        requested ||
        sessionModel ||
        (configured && configured !== 'auto' ? configured : autoGptModel(`${task}\n${context}`))

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
        return [
          `[Codex · ${result.model} · ${mode}] 该部分内容已交由 ChatGPT（${result.model}）处理，耗时 ${elapsed}s（${result.endpoint}）`,
          '',
          result.text,
        ].join('\n')
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
  }

  // ── 1b. DeepSeek 轻任务委派（GPT 模式下把轻任务交 DeepSeek V4.1 收尾） ──────
  const deepseekProvider = () => {
    try {
      // 绝不允许把委派目标落在本插件自己的 ChatGPT provider 上，否则会自我调用、额度翻倍。
      const ids = ctx.llm
        .listProviders()
        .map((provider) => provider.id)
        .filter((id) => id !== PROVIDER_ID && !LEGACY_PROVIDER_IDS.includes(id))
      if (ids.includes('deepseek-account')) return 'deepseek-account'
      if (ids.includes('deepseek-official')) return 'deepseek-official'
      return ids[0] || 'deepseek-official'
    } catch {
      return 'deepseek-official'
    }
  }
  let deepseekModelCache = { at: 0, id: '' }
  const resolveDeepseekModel = async (provider, text) => {
    const configured = delegateModel()
    if (configured && configured !== 'auto') return configured
    try {
      const models = await ctx.llm.listModels(provider)
      const wantsStrong = String(text || '').length > 3_000
      const strong = models.find((item) => /v4-pro|pro/i.test(item.id))
      const light = models.find((item) => /flash/i.test(item.id)) || models[0]
      const pick = wantsStrong && strong ? strong : light
      if (pick && pick.id) return pick.id
    } catch {
      // 模型目录不可用时用保守默认
    }
    return 'deepseek-chat'
  }
  const runDeepSeek = async (prompt, signal) => {
    const provider = deepseekProvider()
    const model = await resolveDeepseekModel(provider, prompt)
    let text = ''
    for await (const chunk of ctx.llm.stream({
      provider,
      model,
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
      signal,
    })) {
      if (chunk.type === 'text-delta') text += chunk.text
      else if (chunk.type === 'finish' && chunk.reason.kind === 'error') {
        throw new Error(chunk.reason.failure?.message || 'DeepSeek 调用失败')
      }
    }
    return { text: text.trim(), provider, model }
  }

  if (!dashboardOnly()) {
  ctx.tools.register({
    name: 'deepseek_delegate',
    description:
      '把轻量任务交给 DeepSeek V4.1 协作完成并收尾（仅当设置里开启「GPT 模式下轻任务交 DeepSeek 收尾」时可用）。适合简单格式化、纯文本整理、常规检索归纳、收尾润色、机械性改写；复杂架构、疑难 bug、深度推理不要用它。',
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: '交给 DeepSeek 的任务，写清输入与期望输出。' },
        context: { type: 'string', description: '可选：完成任务所需的上下文（原文、约束、格式要求）。' },
      },
      required: ['task'],
      additionalProperties: false,
    },
    output: textOutput,
    timeoutMs: 180_000,
    async execute(args, exec) {
      if (!delegateLightTasks()) {
        return '该功能未开启：请在 设置 → Codex 打开「GPT 模式下轻任务交 DeepSeek 收尾」后再使用。'
      }
      const task = typeof args?.task === 'string' ? args.task.trim().slice(0, MAX_CONTEXT_CHARS) : ''
      if (!task) return 'deepseek_delegate 缺少 task。'
      const context = typeof args?.context === 'string' ? args.context.trim().slice(0, MAX_CONTEXT_CHARS) : ''
      const prompt = context ? `${task}\n\n附加上下文：\n${context}` : task
      const timeout = AbortSignal.timeout(180_000)
      const signal =
        exec && exec.signal && typeof AbortSignal.any === 'function'
          ? AbortSignal.any([exec.signal, timeout])
          : timeout
      try {
        const outcome = await runDeepSeek(prompt, signal)
        const label = `[DeepSeek · ${outcome.model} · 轻任务委派] 该部分内容已交由 DeepSeek ${outcome.model} 处理`
        return outcome.text ? `${label}\n\n${outcome.text}` : `${label}\n\n（DeepSeek 没有返回内容）`
      } catch (error) {
        if (error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
          return 'DeepSeek 调用超时或被取消。'
        }
        return `DeepSeek 调用失败：${error instanceof Error ? error.message : String(error)}`
      }
    },
  })
  }

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

  if (!dashboardOnly()) {
  ctx.systemPrompt.section({
    name: 'dsh-codex-policy',
    order: POLICY_ORDER,
    text: (context) => {
      const sessionId = scopeSessionId(context)
      if (!sessionId) return ''
      return policyFor(sessionId)
    },
  })
  }

  // ── 2b. 轻任务委派策略：仅当开关开启时提示 GPT 把轻任务交给 DeepSeek ──────
  if (!dashboardOnly()) {
  ctx.systemPrompt.section({
    name: 'dsh-codex-delegate',
    order: POLICY_ORDER + 10,
    text: () => {
      if (!delegateLightTasks()) return ''
      return [
        '## 轻任务协作（GPT 模式）',
        '本机已开启「GPT 模式下轻任务交 DeepSeek 收尾」：',
        '- 遇到轻量/机械性任务（简单格式化、纯文本整理、常规检索归纳、收尾润色、机械性改写），优先调用 `deepseek_delegate` 交给 DeepSeek V4.1 完成，再把结果整合进你的最终回答。',
        '- 复杂架构、疑难 bug、需要深度推理或工具链操作的任务仍由你直接完成。',
        '- 调用时把任务写清楚；它看不到本会话上下文，需要自包含。',
      ].join('\n')
    },
  })
  }

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

  /** 请求守卫：回环 / Origin / Sec-Fetch-Site / Host / Content-Type / 局域网只读。 */
  const rejectReason = (req) => {
    const loopback = isLoopback(req)
    if (!loopback && !allowLanAccess()) return '仅允许本机访问；如需局域网访问请在设置中开启 allowLanAccess。'
    const origin = req.headers.origin
    const expected = expectedOrigin()
    // 同源判断：接受 127.0.0.1 / localhost / [::1] 等本机别名，但拒绝外部域名。
    if (origin && (!expected || !isSameOrigin(origin, expected))) return '跨站请求被拒绝。'
    const site = req.headers['sec-fetch-site']
    if (site && site !== 'same-origin' && site !== 'none') return '跨站请求被拒绝。'
    // Host 白名单不随 LAN 模式关闭：回环名或本机网卡地址，否则视为 DNS rebinding。
    const host = String(req.headers.host || '').toLowerCase()
    const hostname = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '')
    if (!hostname) return '缺少 Host，已拒绝。'
    if (!isAllowedHost(hostname)) return 'Host 不匹配。'
    if (!loopback && req.method !== 'GET') {
      return '局域网模式仅允许只读查询；登录/登出/兑换重置卡等操作请在运行 DSH 的本机执行。'
    }
    if (req.method === 'POST') {
      // 桌面外壳（Electron/自定义协议）里的同源 POST 可能不带 Origin，此时不能直接拒绝，
      // 否则开关/保存全部失效；改用「随机令牌 + Host 白名单」兜底，跨站页面拿不到令牌。
      if (String(req.headers['x-dsh-write-token'] || '') !== WRITE_TOKEN) {
        return '写操作缺少本机令牌，已拒绝。'
      }
      if (!/^application\/json\b/i.test(String(req.headers['content-type'] || ''))) {
        return 'POST 需要 application/json。'
      }
    }
    return ''
  }

  const snapshot = (sessionId, credential) => {
    // 读快照是低频动作（设置页/胶囊轮询），在这里节流补一次令牌同步，不额外起定时器。
    if (!dashboardOnly()) void maybeSyncUsage()
    const auth = authSnapshot(credential)
    let llmProviders = []
    try {
      llmProviders = ctx.llm.listProviders().map((provider) => ({ id: provider.id, name: provider.name }))
    } catch {
      llmProviders = []
    }
    return {
      ok: true,
      pluginVersion: PLUGIN_VERSION,
      uiLang: readUiLocale(),
      auth,
      llm: { providers: llmProviders, adapter: llmAdapterStatus },
      global: {
        defaultModel: configuredModel(),
        autoConsult: autoConsult(),
        allowLanAccess: allowLanAccess(),
        delegateLightTasks: delegateLightTasks(),
        deepseekModel: delegateModel(),
        gptNameDetect: gptNameDetect(),
        defaultUsageTab: defaultUsageTab(),
        dashboardOnly: dashboardOnly(),
        currentModel: currentModelSelection(),
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
      if (typeof patch.defaultModel === 'string') {
        // 空字符串 = 「自动选择」：必须允许显式清空，否则选了自动也切不回默认策略。
        next.defaultModel = patch.defaultModel.trim().slice(0, 200)
      }
      if (typeof patch.autoConsult === 'boolean') next.autoConsult = patch.autoConsult
      if (typeof patch.allowLanAccess === 'boolean') next.allowLanAccess = patch.allowLanAccess
      if (typeof patch.delegateLightTasks === 'boolean') next.delegateLightTasks = patch.delegateLightTasks
      if (typeof patch.gptNameDetect === 'boolean') next.gptNameDetect = patch.gptNameDetect
      if (typeof patch.dashboardOnly === 'boolean') next.dashboardOnly = patch.dashboardOnly
      if (typeof patch.defaultUsageTab === 'string') {
        next.defaultUsageTab = patch.defaultUsageTab.trim().slice(0, 100)
      }
      if (typeof patch.deepseekModel === 'string') next.deepseekModel = patch.deepseekModel.trim().slice(0, 200)
      if (Object.keys(next).length > 0) await writeConfig(next)
      return
    }
    if (op === 'login') {
      const { url } = await beginLogin({ store: authStore })
      return { url }
    }
    if (op === 'logout') {
      await cancelLogin()
      // 登出必须连同「镜像给用量插件的凭证」一起清掉，而且要和在途同步串行，
      // 否则刚清完又被旧同步写回去（token 生命周期会比登录还长）。
      await enqueueCredentialMutation(async () => {
        authStore.clear()
        lastSyncedUsageKey = ''
        usageSyncTriedAt = 0
        usageSyncStatus = { ok: null, at: 0, error: '', attempts: 0 }
        const credentials = ctx.get('credentials')
        if (credentials) {
          await unsetCredentialIfPresent(credentials, USAGE_TOKEN_REF)
          await unsetCredentialIfPresent(credentials, USAGE_ACCOUNT_REF)
        }
      })
      modelsCache = { at: 0, models: [], error: '' }
      // 上一账号的模型目录不能留给下一个账号用。
      modelsCacheStore.clear()
      // 用量缓存也必须失效，否则卡片还会显示上一个账号的计划与限额。
      try {
        __resetUsageCache()
      } catch {
        // 缓存清理失败不影响登出
      }
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
        // 局域网来源（非回环）只给脱敏数据：不回邮箱/姓名/订阅起止/用量/模型/重置卡。
        const redacted = allowLanAccess() && !isLoopback(req)
        if (url.searchParams.get('meta') === '1') {
          // 轻量快照：侧边栏「跟随当前模型」每 3 秒轮询用，不含邮箱/套餐/用量/写令牌，
          // 也不触发任何凭证写入副作用。
          sendJson(res, 200, {
            ok: true,
            pluginVersion: PLUGIN_VERSION,
            uiLang: readUiLocale(),
            currentModel: currentModelSelection(),
            defaultUsageTab: redacted ? '' : defaultUsageTab(),
            dashboardOnly: dashboardOnly(),
          })
          return
        }
        if (url.searchParams.get('usage') === '1') {
          if (redacted) {
            sendJson(res, 200, { ok: true, usage: { available: false, reason: 'lan-redacted' } })
            return
          }
          const credential = await ensureAccessToken(authStore)
          const usage = await getCodexUsage({
            env: (typeof process !== 'undefined' && process.env) || {},
            credential,
          })
          sendJson(res, 200, { ok: true, usage })
          return
        }
        if (url.searchParams.get('auth') === '1') {
          if (redacted) {
            const auth = authSnapshot()
            sendJson(res, 200, { ok: true, auth: { loggedIn: auth.loggedIn, plan: auth.plan, planLabel: auth.planLabel } })
            return
          }
          sendJson(res, 200, { ok: true, auth: authSnapshot() })
          return
        }
        if (url.searchParams.get('models') === '1') {
          if (redacted) {
            sendJson(res, 200, { ok: true, models: [], error: 'lan-redacted' })
            return
          }
          const credential = await ensureAccessToken(authStore)
          if (!credential) {
            sendJson(res, 200, { ok: true, models: [], error: '尚未登录 OpenAI 账号' })
            return
          }
          const { models, error } = await getModels(credential, false)
          sendJson(res, 200, { ok: true, models, error })
          return
        }
        if (url.searchParams.get('dashboard') === '1') {
          // 用量看板：DeepSeek 余额 + 当前峰谷时段 + 当前在用的模型（不涉密）。
          const peak = peakState(Date.now())
          const force = url.searchParams.get('force') === '1'
          let deepseek = null
          if (!redacted) {
            deepseek = await readDeepseekBalanceCached(force)
          }
          sendJson(res, 200, { ok: true, peak, deepseek, currentModel: currentModelSelection() })
          return
        }
        if (url.searchParams.get('deepseekModels') === '1') {
          // 局域网只读模式同样不返回模型目录，保持一致脱敏。
          if (redacted) {
            sendJson(res, 200, { ok: true, provider: '', models: [], error: 'lan-redacted' })
            return
          }
          try {
            const provider = deepseekProvider()
            const models = await ctx.llm.listModels(provider)
            sendJson(res, 200, { ok: true, provider, models })
          } catch (error) {
            sendJson(res, 200, {
              ok: true,
              provider: '',
              models: [],
              error: error instanceof Error ? error.message : String(error),
            })
          }
          return
        }
        if (url.searchParams.get('resets') === '1') {
          if (redacted) {
            sendJson(res, 200, { ok: true, result: { availableCount: 0, credits: [] }, error: 'lan-redacted' })
            return
          }
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
        const snap = snapshot(sessionId)
        if (redacted) {
          snap.auth = { loggedIn: snap.auth.loggedIn, plan: snap.auth.plan, planLabel: snap.auth.planLabel }
          snap.session = null
          // 配置细节（默认/委派模型、provider 目录）也不向局域网暴露。
          snap.global = {
            allowLanAccess: snap.global.allowLanAccess === true,
            gptNameDetect: snap.global.gptNameDetect === true,
          }
          snap.llm = { providers: [], adapter: { registered: Boolean(snap.llm && snap.llm.adapter && snap.llm.adapter.registered), error: '' } }
        } else {
          // 本机页面才拿得到写操作令牌；局域网只读与跨站请求都拿不到。
          snap.writeToken = WRITE_TOKEN
          // 诊断：令牌是否已同步给用量类插件（不暴露令牌本身）。
          snap.usageSync = {
            ok: usageSyncStatus.ok,
            at: usageSyncStatus.at,
            error: usageSyncStatus.error,
            attempts: usageSyncStatus.attempts,
          }
        }
        sendJson(res, 200, snap)
        return
      }
      if (req.method !== 'GET' && req.method !== 'POST') {
        // 只支持读与写两种；PUT/PATCH/DELETE 一律拒绝，避免绕过写令牌的路径。
        sendJson(res, 405, { ok: false, error: 'method not allowed' })
        return
      }
      if (req.method === 'POST') {
        const body = await readJsonBody(req)
        const extra = await applyOp(body)
        const sessionId = normalizeSessionId(body.sessionId)
        const credential = describeCredential(authStore.read())
        sendJson(res, 200, { ...snapshot(sessionId, credential), writeToken: WRITE_TOKEN, result: extra })
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
  // 只注册规范 id `openai-codex`：旧 id `chatgpt-codex` 不再出现在模型选择器里
  // （否则会多出一个「ChatGPT（旧 id）」分组）；老会话的选择由下面的迁移改写。
  try {
    ctx.effect(() => {
      try {
        // 仅看板模式：不注册 ChatGPT 模型，模型选择器里就当没有这个插件。
        if (dashboardOnly()) return
        // 迁移：老版本存下的 `chatgpt-codex` 默认选择改写成规范 id，老会话照样能发消息。
        try {
          const adm = ctx.get('agentDefaultModel')
          const selection = adm && typeof adm.currentSelection === 'function' ? adm.currentSelection() : null
          if (selection && LEGACY_PROVIDER_IDS.includes(selection.provider) && typeof adm.saveSelection === 'function') {
            void Promise.resolve(adm.saveSelection({ ...selection, provider: PROVIDER_ID })).catch(() => {})
          }
        } catch {
          // 迁移失败不影响适配器注册
        }
        const handle = ctx.llm.registerAdapter(
          [PROVIDER_ID],
          createCodexGptAdapter({
            getCredential: async (options) => {
              // 注意：这里在模型列表的高频路径上，绝不做凭证写入（会触发刷新风暴）。
              const credential = await ensureAccessToken(authStore, options || {})
              return credential
                ? { accessToken: credential.accessToken, accountId: credential.accountId }
                : undefined
            },
            fetchModels: (credential) =>
              fetchCodexModels({ accessToken: credential.accessToken, accountId: credential.accountId }),
            // 上游目录拿不到时（未登录/429/凭证刷新失败）至少保留一个可路由模型，
            // 避免 DSH 模型选择器变空导致当前会话“点发送没反应”。
            fallbackModel: configuredModel() || DEFAULT_MODEL,
            // 激活后预热一次目录，模型选择器首次打开不再等网络。
            preload: true,
            // 启动即用上次落盘的完整目录，避免「模型先消失、要手动重选」。
            modelsCache: modelsCacheStore,
            readImage: async (attachmentRef) => {
              const stored = await ctx.attachments.readImage(attachmentRef)
              // 以读取结果为准：ref 上不一定带 mediaType，否则会拼出 data:undefined;base64 并被静默丢图。
              const mediaType = (stored && stored.mediaType) || (attachmentRef && attachmentRef.mediaType) || 'image/png'
              return { data: stored.data, mediaType }
            },
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

  // ── 5b. 已登录时把 OAuth 令牌同步给用量类插件（激活后一次，失败静默） ──────
  try {
    ctx.effect(() => {
      const timer = setTimeout(() => {
        if (!dashboardOnly()) void maybeSyncUsage()
      }, 1200)
      if (timer && typeof timer.unref === 'function') timer.unref()
      return () => clearTimeout(timer)
    }, 'dsh-codex-gpt: 同步 ChatGPT 用量令牌')
  } catch (error) {
    warn('用量令牌同步初始化失败（只影响用量卡显示）', error)
  }

  // ── 6. 设置页 provider 目录：让「设置 → 模型」里出现 ChatGPT ──────────────
  try {
    ctx.effect(() => {
      try {
        const handle = ctx.llm.registerConfigurableProviders([
          {
            provider: PROVIDER_ID,
            displayName: 'ChatGPT',
            settingsNs: ENTRY_ID,
            settingsPath: ['models'],
            declared: true,
            nativeAuth: { env: [], oauth: true },
          },
        ])
        llmAdapterStatus.directory = { registered: true, error: '' }
        return () => {
          try {
            handle()
          } catch {
            // 已释放
          }
        }
      } catch (error) {
        llmAdapterStatus.directory = {
          registered: false,
          error: error instanceof Error ? error.message : String(error),
        }
        throw error
      }
    }, 'dsh-codex-gpt: ChatGPT 设置目录')
  } catch (error) {
    warn('设置页 provider 目录注册失败', error)
  }

  console.log(`[dsh-codex-gpt] activated (entry=${ENTRY_ID}, oauth, llm=${PROVIDER_ID}, route=${ROUTE})`)
}
