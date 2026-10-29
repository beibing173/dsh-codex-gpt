/**
 * dsh-codex — DeepSeek Harness 的 Codex 桥接插件（Host 侧）。
 *
 * 设计目标（与用户需求一一对应）：
 *   1. 正常模式：会话默认由 DeepSeek 模型（如 deepseek-flash / V4.1）处理，不触碰 Codex；
 *   2. 会话级授权：用户必须手动在输入框左侧「Codex」按钮或设置页授权该会话，
 *      Host 才会允许该会话的模型调用 `codex` 工具；
 *   3. 自主调用：已授权会话里，DeepSeek 按任务强度/专业度自行决定是否调用
 *      `codex` 工具，把高难度任务交给 OpenAI Codex/GPT 分析或构建；
 *   4. 可配置：API Key、Base URL、模型列表、默认模型、是否允许自主调用；
 *   5. 状态持久化：会话授权写入 $DSH_HOME/dsh-codex.json，重启后保留。
 *
 * 组成：`codex` 工具 + 每会话提示策略段 + `/dsh-codex-api` 状态路由（供浏览器 UI）。
 */
import z from '@deepseek-ai/schemastery'
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { callCodex } from './codex.js'
import { getCodexUsage } from './usage.js'
import { checkConnectivity } from './network.js'

export const name = 'dsh-codex'

/** profile 条目 id：cordis.patch.yml 里 `- id: dsh-codex` 必须与此一致。 */
export const ENTRY_ID = 'dsh-codex'

/** Host 硬依赖：工具注册与提示组装。 */
export const inject = ['tools', 'systemPrompt']

export const DEFAULT_MODELS = ['gpt-5-codex', 'gpt-5', 'gpt-5-mini', 'gpt-4.1', 'o4-mini']
const DEFAULT_BASE_URL = 'https://api.openai.com/v1'
/** 状态路由（同源 fetch 使用）。 */
export const ROUTE = '/dsh-codex-api'
/** 单次 Codex 调用超时（毫秒）。 */
const CODEX_TIMEOUT_MS = 240_000
/** 会话状态文件里最多保留的会话条数。 */
const MAX_SESSIONS = 400
/** 提示策略段的 order：紧跟在人格段之后，不参与工具/上下文排序。 */
const POLICY_ORDER = 10310

export const Config = z.object({
  apiKey: z
    .string()
    .default('')
    .description('OpenAI API Key（留空时回退环境变量 OPENAI_API_KEY）。也可用兼容代理的 key。')
    .volatile(),
  baseUrl: z
    .string()
    .default(DEFAULT_BASE_URL)
    .description('OpenAI API 基址；使用第三方兼容代理时改成对应地址（通常以 /v1 结尾）。')
    .volatile(),
  models: z
    .array(z.string())
    .default(DEFAULT_MODELS)
    .description('可选模型列表；会话按钮与设置页从这里取候选。')
    .volatile(),
  defaultModel: z
    .string()
    .default(DEFAULT_MODELS[0])
    .description('未指定模型时使用的默认模型。')
    .volatile(),
  autoConsult: z
    .boolean()
    .default(true)
    .description('允许 DeepSeek 在已授权会话里根据任务强度自主调用 Codex；关闭后只在用户明确要求时调用。')
    .volatile(),
  maxOutputTokens: z
    .number()
    .default(0)
    .description('单次 Codex 调用的最大输出 token；0 表示不设置。')
    .volatile(),
  allowLanAccess: z
    .boolean()
    .default(false)
    .description('允许局域网设备通过 Web UI 读写本插件状态；默认仅本机回环地址。')
    .volatile(),
})

// ────────────────────────────── 通用小工具 ──────────────────────────────

/**
 * 读取 Config 字段：0.2.x 把每个 volatile 字段包成带 `.get()` 的引用，
 * 桩测试 / 普通对象下退化为普通值，因此逐层解包直到拿到普通值。
 * @param holder Config 对象或字段值。
 * @returns {unknown} 当前值。
 */
function readField(holder) {
  let current = holder
  for (let depth = 0; depth < 8; depth += 1) {
    if (current === undefined || current === null) return current
    if (typeof current.get !== 'function') return current
    current = current.get()
  }
  return current
}

/** 追加内容到日志（不抛错）。 */
function warn(message, error) {
  try {
    console.warn(`[dsh-codex] ${message}`, error ?? '')
  } catch {
    // 忽略：日志失败不影响功能
  }
}

/** 规范化从 HTTP 传入的 sessionId。 */
function normalizeSessionId(value) {
  if (typeof value !== 'string') return ''
  const id = value.trim()
  if (!id || id.length > 200) return ''
  if (!/^[A-Za-z0-9_.:-]+$/.test(id)) return ''
  return id
}

/** 是否本机回环请求。 */
function isLoopback(req) {
  const address = (req && req.socket && req.socket.remoteAddress) || ''
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/** 发送 JSON 响应。 */
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(Buffer.byteLength(body)),
    'Cache-Control': 'no-store',
  })
  res.end(body)
}

/** 读取并解析 JSON 请求体（限制大小）。 */
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
 * 会话授权状态。写入 $DSH_HOME/dsh-codex.json：
 *   { version: 1, sessions: { [sessionId]: { enabled, model, updatedAt } } }
 * 与 Session 日志解耦：授权是插件自己的策略数据，不污染会话事件流。
 * @param {{ env: Record<string, string | undefined>, homeDir: () => string }} options
 */
function createSessionStore(options) {
  const { env, homeDir } = options
  const filePath = () => join(env.DSH_HOME || homeDir(), 'dsh-codex.json')
  let cache = null

  /** 读取并规范化落盘状态。 */
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

  /** 原子写盘（先写临时文件再 rename）。 */
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
    /** 取一个会话的授权状态；没有记录时返回未授权。 */
    get(sessionId) {
      const record = load().sessions[sessionId]
      return {
        sessionId,
        enabled: record ? record.enabled === true : false,
        model: record ? record.model : '',
      }
    },
    /** 合并写入一个会话的授权状态，返回写入后的状态。 */
    set(sessionId, patch) {
      const current = load()
      const previous = current.sessions[sessionId]
      const next = {
        enabled: typeof patch.enabled === 'boolean' ? patch.enabled : previous ? previous.enabled : false,
        model: typeof patch.model === 'string' ? patch.model.slice(0, 200) : previous ? previous.model : '',
        updatedAt: Date.now(),
      }
      const sessions = { ...current.sessions, [sessionId]: next }
      save({ version: 1, sessions })
      return { sessionId, enabled: next.enabled, model: next.model }
    },
  }
}

// ────────────────────────────── 提示策略 ──────────────────────────────

/** 渲染给当前会话模型的 Codex 使用策略。每次模型步骤重新求值，开关即时生效。 */
function renderPolicy(sessionState, settings) {
  if (!sessionState.enabled) {
    return [
      '## Codex 专业分析通道（dsh-codex）',
      '本会话当前【未授权】使用 Codex（OpenAI GPT）。',
      '- 常规任务全部用你自身的 DeepSeek 能力完成，不要调用 `codex` 工具。',
      '- 若判断任务强度很高、确实需要第二模型做专业分析或构建，先向用户说明理由，',
      '  并提示用户点击输入框左侧的「Codex」按钮授权本会话（或让用户在设置页打开）。',
      '- 授权后本段会自动变成已授权版本，下一轮即可使用。',
    ].join('\n')
  }
  const lines = [
    '## Codex 专业分析通道（dsh-codex）',
    `本会话已由用户【授权】使用 Codex，默认模型：\`${settings.model}\`。`,
    '- 常规任务（日常问答、简单改动、轻量检索、一般代码编辑）仍由你直接完成，不要调用 codex。',
    settings.autoConsult
      ? '- 出现下列情况时，你应主动调用 `codex` 工具获取独立专业分析或构建结果，再结合环境事实给出最终答案：'
      : '- 用户设置已关闭自主调用；只有用户在本轮明确要求「用 GPT / Codex 分析或构建」时才调用 `codex`；否则一律自己完成。以下情况可提醒用户可以调用：',
    '  · 任务强度高：跨文件架构改动、复杂并发/性能/协议设计、疑难 bug 根因定位；',
    '  · 需要专业判断：安全审计、方案选型、代码评审、算法正确性验证、迁移风险评估；',
    '  · 需要第二模型交叉验证，或用户明确要求 GPT 参与。',
    '- 调用时把目标、验收标准、约束、相关代码与错误信息完整放进 `task`/`context`，让 Codex 能独立判断；',
    '  `mode` 用 `analyze` 做分析评审，用 `build` 让它直接产出可落地代码。',
    '- Codex 输出是专业参考：你负责核对真实环境、执行改动、向用户解释差异与取舍。',
  ]
  return lines.join('\n')
}

// ────────────────────────────── 插件入口 ──────────────────────────────

/**
 * 插件入口。
 * @param ctx Cordis 插件上下文。
 * @param config 本行 Config（0.2.x 下 volatile 字段为引用，普通对象退化）。
 */
export function apply(ctx, config) {
  // 无 settings 服务时的内存覆盖层（正常 profile 用 ctx.settings.update 持久化）。
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

  /** 把配置字段写回本行 Config；settings 不可用时只在本进程内存生效。 */
  const writeConfig = async (patch) => {
    const settings = settingsService()
    if (settings) {
      await settings.update(ENTRY_ID, patch)
      return
    }
    Object.assign(localOverrides, patch)
  }

  const modelsList = () => {
    const raw = readValue('models')
    const list = Array.isArray(raw)
      ? raw.map((item) => String(item).trim()).filter(Boolean)
      : []
    return list.length > 0 ? list.slice(0, 40) : [...DEFAULT_MODELS]
  }

  const defaultModel = () => {
    const raw = readValue('defaultModel')
    const model = typeof raw === 'string' ? raw.trim() : ''
    return model || modelsList()[0]
  }

  const baseUrl = () => {
    const raw = readValue('baseUrl')
    const value = typeof raw === 'string' ? raw.trim() : ''
    return value || DEFAULT_BASE_URL
  }

  const autoConsult = () => readValue('autoConsult') !== false

  const maxOutputTokens = () => {
    const value = Number(readValue('maxOutputTokens'))
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
  }

  const allowLanAccess = () => readValue('allowLanAccess') === true

  /** 解析 API Key：Config 优先，其次环境变量。 */
  const resolveApiKey = () => {
    const fromConfig = readValue('apiKey')
    if (typeof fromConfig === 'string' && fromConfig.trim()) {
      return { key: fromConfig.trim(), source: 'config' }
    }
    const fromEnv = typeof process !== 'undefined' && process.env ? process.env.OPENAI_API_KEY : undefined
    if (typeof fromEnv === 'string' && fromEnv.trim()) return { key: fromEnv.trim(), source: 'env' }
    return { key: '', source: '' }
  }

  const store = createSessionStore({
    env: (typeof process !== 'undefined' && process.env) || {},
    homeDir: () => join(homedir(), '.dsh'),
  })

  /** 某会话当前生效的模型：会话覆盖 > 全局默认。 */
  const effectiveModel = (sessionId) => {
    const state = store.get(sessionId)
    return state.model || defaultModel()
  }

  // ── 1. codex 工具：唯一真正消耗 OpenAI 配额的入口 ──────────────────────────
  const textOutput = {
    schema: { type: 'string' },
    render(_args, value) {
      return [{ type: 'text', text: String(value) }]
    },
  }

  // 直接注册标准 ToolDefinition 对象：不依赖 @deepseek-ai/dsh-tools 的 helper，
  // 这样本地 link 安装（插件根目录在 workspace 内）也能解析全部 import。
  ctx.tools.register({
      name: 'codex',
      description:
        '把高难度任务交给 OpenAI Codex/GPT 做独立的专业分析或代码构建（消耗用户 OpenAI API 配额）。仅当本会话已被用户手动授权后可用；用于复杂架构/疑难 bug/安全审计/方案评审，或用户明确要求 GPT 参与时。普通任务不要调用。',
      // 注意：注册的是完整 JSON Schema（type: object + properties + required）。
      // 只传字段表会让宿主把 parameters 当成 schema 直接发出（type 为空），
      // 模型请求会被 OpenAI 以 INVALID_REQUEST 拒绝。
      parameters: {
        type: 'object',
        properties: {
          task: {
            type: 'string',
            description:
              '交给 Codex 的任务或问题。写清目标、验收标准、关键约束；它看不到本会话上下文，必须自包含。',
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
            description: '可选：指定本次使用的模型；省略则用会话/全局默认。',
          },
        },
        required: ['task'],
        additionalProperties: false,
      },
      output: textOutput,
      timeoutMs: CODEX_TIMEOUT_MS + 30_000,
      async execute(args, exec) {
        const sessionId = exec && exec.agent && exec.agent.id ? String(exec.agent.id) : ''
        if (!sessionId) {
          return '无法确定当前会话，已拒绝调用 Codex。请在正常会话中重试。'
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

        const credentials = resolveApiKey()
        if (!credentials.key) {
          return [
            'Codex 不可用：尚未配置 OpenAI API Key。',
            '请让用户在设置 →「Codex」页填写 API Key，或设置环境变量 OPENAI_API_KEY 后重启 Harness。',
          ].join('\n')
        }

        const timeout = AbortSignal.timeout(CODEX_TIMEOUT_MS)
        const signal =
          exec && exec.signal && typeof AbortSignal.any === 'function'
            ? AbortSignal.any([exec.signal, timeout])
            : timeout

        const startedAt = Date.now()
        try {
          const result = await callCodex({
            apiKey: credentials.key,
            baseUrl: baseUrl(),
            model,
            mode,
            task,
            context,
            maxOutputTokens: maxOutputTokens(),
            signal,
          })
          const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1)
          return [
            `[Codex · ${result.model} · ${mode}] 耗时 ${elapsed}s（${result.endpoint}）`,
            '',
            result.text,
          ].join('\n')
        } catch (error) {
          const failure = error instanceof Error ? error : new Error(String(error))
          if (failure.name === 'AbortError' || failure.name === 'TimeoutError') {
            return `Codex 调用超时或被取消（${Math.round(CODEX_TIMEOUT_MS / 1000)}s 上限）。可以缩小任务后重试。`
          }
          // 鉴权失败时给出可操作指引，避免模型反复重试。
          const message = failure.message || String(failure)
          if (/HTTP 401|HTTP 403|invalid api key|incorrect api key/i.test(message)) {
            return `Codex 调用失败：OpenAI 鉴权被拒绝。请让用户检查设置里的 API Key。\n${message}`
          }
          return `Codex 调用失败：${message}\n可检查设置里的 Base URL、模型名与网络连通性后重试。`
        }
      },
  })

  // ── 2. 每会话提示策略：随组装上下文求值，开关切换后下一轮即生效 ─────────────
  /**
   * 从组装上下文里解析当前会话 id。
   * `AssembleContext` 的类型只声明了 scope/signal，但运行时同时携带 agent
   * （dsh-meme 等既有插件依赖 `context.agent.session`），这里按多种形态兜底。
   * 解析不到时返回空串：策略段静默省略，不影响其它提示。
   */
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

  ctx.systemPrompt.section({
    name: 'dsh-codex-policy',
    order: POLICY_ORDER,
    text: (context) => {
      const sessionId = scopeSessionId(context)
      if (!sessionId) return ''
      return renderPolicy(store.get(sessionId), {
        model: effectiveModel(sessionId),
        autoConsult: autoConsult(),
      })
    },
  })

  // ── 3. 浏览器 UI 的状态通道（同源 HTTP，避免 Typert 描述符耦合） ────────────
  const snapshot = (sessionId) => {
    const credentials = resolveApiKey()
    return {
      ok: true,
      global: {
        baseUrl: baseUrl(),
        models: modelsList(),
        defaultModel: defaultModel(),
        autoConsult: autoConsult(),
        maxOutputTokens: maxOutputTokens(),
        allowLanAccess: allowLanAccess(),
        apiConfigured: Boolean(credentials.key),
        keySource: credentials.source,
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
      if (typeof patch.apiKey === 'string') next.apiKey = patch.apiKey.trim()
      if (typeof patch.baseUrl === 'string' && patch.baseUrl.trim()) next.baseUrl = patch.baseUrl.trim()
      if (typeof patch.defaultModel === 'string' && patch.defaultModel.trim()) {
        next.defaultModel = patch.defaultModel.trim()
      }
      if (Array.isArray(patch.models)) {
        next.models = patch.models
          .map((item) => String(item).trim())
          .filter(Boolean)
          .slice(0, 40)
      }
      if (typeof patch.autoConsult === 'boolean') next.autoConsult = patch.autoConsult
      if (typeof patch.allowLanAccess === 'boolean') next.allowLanAccess = patch.allowLanAccess
      if (patch.maxOutputTokens !== undefined) {
        next.maxOutputTokens = Math.max(0, Math.min(200_000, Number(patch.maxOutputTokens) || 0))
      }
      if (Object.keys(next).length > 0) await writeConfig(next)
      return
    }
    if (op === 'testNetwork') {
      return await checkConnectivity({ timeoutMs: 8_000 })
    }
    if (op === 'testConnection') {
      const credentials = resolveApiKey()
      if (!credentials.key) throw new Error('尚未配置 OpenAI API Key')
      const model = typeof body.model === 'string' && body.model.trim() ? body.model.trim() : defaultModel()
      const startedAt = Date.now()
      const result = await callCodex({
        apiKey: credentials.key,
        baseUrl: baseUrl(),
        model,
        mode: 'analyze',
        task: '连通性测试：请只回复 OK。',
        context: '',
        maxOutputTokens: 16,
        signal: AbortSignal.timeout(60_000),
      })
      return { latencyMs: Date.now() - startedAt, model: result.model, endpoint: result.endpoint }
    }
    throw new Error(`未知操作：${op || '(空)'}`)
  }

  const handler = async (req, res) => {
    try {
      if (!isLoopback(req) && !allowLanAccess()) {
        sendJson(res, 403, { ok: false, error: '仅允许本机访问；如需局域网访问请在设置中开启 allowLanAccess。' })
        return
      }
      const url = new URL(String(req.url || '/'), 'http://localhost')
      const pathname = url.pathname.replace(/\/+$/, '')
      if (pathname !== ROUTE) {
        sendJson(res, 404, { ok: false, error: 'not found' })
        return
      }
      if (req.method === 'GET') {
        // 侧边栏卡片：Codex（ChatGPT 订阅）用量。拿不到时返回 available:false，UI 不渲染卡片。
        if (url.searchParams.get('usage') === '1') {
          const usage = await getCodexUsage({
            env: (typeof process !== 'undefined' && process.env) || {},
          })
          sendJson(res, 200, { ok: true, usage })
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
        sendJson(res, 200, { ...snapshot(sessionId), result: extra })
        return
      }
      sendJson(res, 405, { ok: false, error: 'method not allowed' })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      sendJson(res, 400, { ok: false, error: message })
    }
  }

  try {
    const webServer = (ctx.webServer ?? (ctx.get ? ctx.get('webServer') : undefined)) || undefined
    if (webServer && typeof webServer.register === 'function') {
      ctx.effect(
        () =>
          webServer.register({
            kind: 'prefix',
            path: ROUTE,
            handler,
          }),
        'dsh-codex: /dsh-codex-api 状态路由',
      )
    } else {
      warn('未找到 webServer 服务：Codex 开关 UI 不可用（工具与提示仍可用）')
    }
  } catch (error) {
    warn('状态路由注册失败', error)
  }

  console.log(`[dsh-codex] activated: session-scoped Codex bridge ready (entry=${ENTRY_ID})`)
}
