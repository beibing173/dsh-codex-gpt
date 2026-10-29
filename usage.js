/**
 * dsh-codex / Codex（ChatGPT 订阅）用量读取层。
 *
 * 用户要的是侧边栏卡片上的「5 小时限额 / 每周限额 / 当前订阅状态 / 到期日」。
 * 这些不是 OpenAI API（api.openai.com）能提供的：它们来自 Codex CLI 登录的
 * ChatGPT 订阅，只能通过 Agent 本机已有的 OAuth 凭证访问：
 *
 *   GET https://chatgpt.com/backend-api/wham/usage
 *       Authorization: Bearer <access_token>
 *       ChatGPT-Account-Id: <account_id>
 *
 * 凭证来源与 Codex CLI 一致（按顺序找）：
 *   $CODEX_HOME/auth.json → ~/.codex/auth.json → ~/.config/codex/auth.json
 *
 * access_token 过期或服务端 401 时，用 refresh_token 换新 token，并**写回**
 * auth.json（与 Codex CLI 自身行为一致，避免两处凭证轮换后互相失效）。
 * 任何一步拿不到数据都返回 `{ available: false }`，UI 据此不渲染卡片。
 */
import { readFileSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage'
const TOKEN_URL = 'https://auth.openai.com/oauth/token'
/** Codex CLI 的公开 OAuth client id（官方公开值，用于刷新 token）。 */
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'

const USAGE_TTL_MS = 60_000
const FAILURE_TTL_MS = 30_000
const REQUEST_TIMEOUT_MS = 12_000

/** 计划类型的中文展示名；未知计划原样显示。 */
const PLAN_LABELS = {
  free: 'Free',
  plus: 'Plus',
  pro: 'Pro',
  prolite: 'Pro 100',
  promax: 'Pro 200',
  promax_500: 'Pro 500',
  team: 'Team',
  business: 'Business',
  enterprise: 'Enterprise',
  edu: 'Edu',
}

/**
 * 解码 JWT 的 payload（不校验签名：只读取本机凭证里的展示信息）。
 * @param {string} token JWT。
 * @returns {object | undefined} payload。
 */
export function decodeJwtPayload(token) {
  if (typeof token !== 'string') return undefined
  const parts = token.split('.')
  if (parts.length < 2) return undefined
  try {
    const json = Buffer.from(parts[1], 'base64url').toString('utf8')
    const payload = JSON.parse(json)
    return payload && typeof payload === 'object' ? payload : undefined
  } catch {
    return undefined
  }
}

/**
 * 从 id_token / access_token 读取订阅信息。
 * @param {string} token JWT。
 * @returns {{ plan?: string, activeStart?: string, activeUntil?: string } | undefined}
 */
export function subscriptionFromToken(token) {
  const payload = decodeJwtPayload(token)
  if (!payload) return undefined
  const auth = payload['https://api.openai.com/auth']
  if (!auth || typeof auth !== 'object') return undefined
  const read = (key) => (typeof auth[key] === 'string' && auth[key] ? auth[key] : undefined)
  return {
    plan: read('chatgpt_plan_type'),
    activeStart: read('chatgpt_subscription_active_start'),
    activeUntil: read('chatgpt_subscription_active_until'),
  }
}

/** JWT 的过期时间（毫秒时间戳）；解析不到返回 0。 */
export function tokenExpiresAt(token) {
  const payload = decodeJwtPayload(token)
  const exp = payload ? Number(payload.exp) : NaN
  return Number.isFinite(exp) ? exp * 1000 : 0
}

/**
 * 凭证候选路径，按 Codex CLI 的查找顺序。
 * @param {Record<string, string | undefined>} env 进程环境。
 * @param {string} [homeDir] 主目录覆盖（测试用）。
 */
export function authCandidates(env, homeDir) {
  const home = homeDir || homedir()
  const list = []
  if (env.CODEX_HOME) list.push(join(env.CODEX_HOME, 'auth.json'))
  list.push(join(home, '.codex', 'auth.json'))
  list.push(join(home, '.config', 'codex', 'auth.json'))
  return [...new Set(list)]
}

/**
 * 读取本机 Codex 登录凭证。
 * @param {Record<string, string | undefined>} env 进程环境。
 * @param {string} [homeDir] 主目录覆盖（测试用）。
 * @returns {{ path: string, tokens: { access_token: string, refresh_token?: string, id_token?: string, account_id?: string }, last_refresh?: string } | undefined}
 */
export function readCodexAuth(env, homeDir) {
  for (const path of authCandidates(env, homeDir)) {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8'))
      if (parsed && typeof parsed === 'object' && parsed.tokens && typeof parsed.tokens.access_token === 'string') {
        return { ...parsed, path }
      }
    } catch {
      // 文件不存在或不是合法 JSON：继续找下一个位置
    }
  }
  return undefined
}

/**
 * 计算窗口标签：优先按官方窗口时长，其次用默认标签。
 * @param {unknown} seconds limit_window_seconds。
 * @param {string} fallback 默认标签。
 */
function windowLabel(seconds, fallback) {
  const value = Number(seconds)
  if (!Number.isFinite(value) || value <= 0) return fallback
  if (Math.abs(value - 18_000) <= 300) return '5 小时'
  if (Math.abs(value - 604_800) <= 3600) return '每周'
  if (value < 86_400) return `${Math.round(value / 3600)} 小时`
  return `${Math.round(value / 86_400)} 天`
}

/**
 * 解析 wham/usage 响应，只保留卡片需要的字段。
 * @param {unknown} json 响应体。
 * @returns {{ plan?: string, windows: object[], credits?: object, resetCredits?: number } | undefined}
 */
export function parseUsage(json) {
  if (!json || typeof json !== 'object') return undefined
  const rate = json.rate_limit && typeof json.rate_limit === 'object' ? json.rate_limit : {}
  const windows = []
  const pushWindow = (id, fallbackLabel, window) => {
    if (!window || typeof window !== 'object') return
    const used = Number(window.used_percent)
    if (!Number.isFinite(used)) return
    const resetAt = Number(window.reset_at)
    windows.push({
      id,
      label: windowLabel(window.limit_window_seconds, fallbackLabel),
      usedPercent: Math.max(0, Math.min(100, Math.round(used))),
      resetAt: Number.isFinite(resetAt) && resetAt > 0 ? resetAt : 0,
      windowSeconds: Number.isFinite(Number(window.limit_window_seconds))
        ? Math.round(Number(window.limit_window_seconds))
        : 0,
    })
  }
  pushWindow('primary', '5 小时', rate.primary_window)
  pushWindow('secondary', '每周', rate.secondary_window)
  if (windows.length === 0) return undefined

  const rawCredits = json.credits
  const credits =
    rawCredits && typeof rawCredits === 'object'
      ? {
          hasCredits: rawCredits.has_credits === true,
          unlimited: rawCredits.unlimited === true,
          balance: Number(rawCredits.balance),
        }
      : undefined

  const reset = json.rate_limit_reset_credits
  const resetCredits =
    reset && typeof reset === 'object' && Number.isFinite(Number(reset.available_count))
      ? Math.max(0, Math.round(Number(reset.available_count)))
      : undefined

  const planType = typeof json.plan_type === 'string' ? json.plan_type : ''

  return {
    plan: planType || undefined,
    windows,
    credits,
    resetCredits,
  }
}

/** 把计划 id 转成展示名。 */
export function planLabel(plan) {
  if (typeof plan !== 'string' || !plan) return undefined
  return PLAN_LABELS[plan.toLowerCase()] || plan
}

/** 带超时的 fetch。 */
async function timedFetch(url, init, signal, timeoutMs = REQUEST_TIMEOUT_MS) {
  const timeout = AbortSignal.timeout(timeoutMs)
  const composed = signal && typeof AbortSignal.any === 'function' ? AbortSignal.any([signal, timeout]) : timeout
  return fetch(url, { ...init, signal: composed })
}

/** 请求用量接口；非 2xx 抛错（错误带 status）。 */
async function requestUsage(accessToken, accountId, signal) {
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    Accept: 'application/json',
  }
  if (typeof accountId === 'string' && accountId) headers['ChatGPT-Account-Id'] = accountId
  const response = await timedFetch(USAGE_URL, { method: 'GET', headers }, signal)
  const raw = await response.text()
  let json
  try {
    json = raw ? JSON.parse(raw) : undefined
  } catch {
    json = undefined
  }
  if (!response.ok) {
    const detail =
      (json && json.error && (json.error.message || json.error.code)) || (raw ? raw.slice(0, 300) : '') || response.statusText
    const error = new Error(`usage HTTP ${response.status}: ${detail}`)
    error.status = response.status
    throw error
  }
  return json
}

/**
 * 用 refresh_token 换新 token。
 * 默认**不写回** Codex CLI 的 auth.json：插件只读 CLI 凭证，避免与 CLI 的
 * refresh_token 轮换互相作废或覆盖未知字段。写回仅作为显式 opt-in 保留给
 * 未来的共享凭证模式（writeBack: true）。
 * @returns {Promise<string | undefined>} 新 access_token，失败返回 undefined。
 */
async function refreshAuth(auth, signal, { writeBack = false } = {}) {
  const refreshToken = auth.tokens && auth.tokens.refresh_token
  if (typeof refreshToken !== 'string' || !refreshToken) return undefined
  try {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: CLIENT_ID,
      refresh_token: refreshToken,
    })
    const response = await timedFetch(
      TOKEN_URL,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: body.toString(),
      },
      signal,
    )
    const raw = await response.text()
    let json
    try {
      json = raw ? JSON.parse(raw) : undefined
    } catch {
      json = undefined
    }
    if (!response.ok || !json || typeof json.access_token !== 'string') return undefined
    const next = {
      ...auth,
      tokens: {
        ...auth.tokens,
        access_token: json.access_token,
        refresh_token: typeof json.refresh_token === 'string' ? json.refresh_token : auth.tokens.refresh_token,
        id_token: typeof json.id_token === 'string' ? json.id_token : auth.tokens.id_token,
      },
      last_refresh: new Date().toISOString(),
    }
    delete next.path
    if (writeBack && typeof auth.path === 'string' && auth.path) {
      try {
        const tmp = `${auth.path}.dsh-codex.tmp`
        writeFileSync(tmp, JSON.stringify(next, null, 2), { encoding: 'utf8', mode: 0o600 })
        renameSync(tmp, auth.path)
      } catch {
        // 写回失败：本进程继续用新 token
      }
    }
    return json.access_token
  } catch {
    return undefined
  }
}

/** 用量缓存（进程级；60 秒内复用，失败 30 秒内复用）。 */
let cache
/** 测试用：清空缓存。 */
export function __resetUsageCache() {
  cache = undefined
}

/**
 * 读取 Codex 订阅用量。
 * @param {object} [options]
 * @param {Record<string, string | undefined>} [options.env] 进程环境。
 * @param {string} [options.homeDir] 主目录覆盖（测试用）。
 * @param {object} [options.credential] 插件自己的 OAuth 凭证（登录后传入，优先）。
 * @param {AbortSignal} [options.signal] 取消信号。
 * @returns {Promise<object>} 卡片数据；不可用时 `{ available: false, reason }`。
 */
export async function getCodexUsage(options = {}) {
  const now = Date.now()
  if (cache && cache.expiresAt > now) return cache.value
  const env = options.env || {}
  const signal = options.signal
  const injected = options.credential
  // 优先用插件自己的 OAuth 登录；没有时回退 Codex CLI 的 auth.json。
  const injectedAuth =
    injected && typeof injected.accessToken === 'string' && injected.accessToken
      ? {
          __injected: true,
          tokens: {
            access_token: injected.accessToken,
            id_token: injected.idToken,
            account_id: injected.accountId,
          },
        }
      : undefined

  let value
  try {
    const auth = injectedAuth || readCodexAuth(env, options.homeDir)
    if (!auth) {
      value = { available: false, reason: 'no-auth' }
    } else {
      const tokens = auth.tokens || {}
      let accessToken = tokens.access_token
      // access_token 是短命 JWT；快过期时直接刷新，省一次 401 往返。
      if (accessToken && tokenExpiresAt(accessToken) - now < 60_000) {
        accessToken = (await refreshAuth(auth, signal)) || accessToken
      }
      let json
      try {
        json = await requestUsage(accessToken, tokens.account_id, signal)
      } catch (error) {
        if (error && (error.status === 401 || error.status === 403)) {
          const refreshed = await refreshAuth(auth, signal)
          if (!refreshed) throw error
          accessToken = refreshed
          json = await requestUsage(accessToken, tokens.account_id, signal)
        } else {
          throw error
        }
      }
      const parsed = parseUsage(json)
      if (!parsed) {
        value = { available: false, reason: 'no-rate-limit' }
      } else {
        // 订阅状态优先用 id_token（含有效期）；拿不到时退回 usage 的 plan_type。
        const subscription = injectedAuth
          ? { activeStart: injected.activeStart, activeUntil: injected.activeUntil }
          : subscriptionFromToken(tokens.id_token) || subscriptionFromToken(accessToken) || {}
        const plan = parsed.plan || (injectedAuth ? injected.plan : subscription.plan)
        value = {
          available: true,
          plan,
          planLabel: planLabel(plan),
          windows: parsed.windows,
          credits: parsed.credits,
          resetCredits: parsed.resetCredits,
          subscription: {
            activeStart: subscription.activeStart,
            activeUntil: subscription.activeUntil,
          },
          fetchedAt: now,
          source: 'chatgpt-usage',
        }
      }
    }
  } catch (error) {
    value = {
      available: false,
      reason: 'request-failed',
      error: error instanceof Error ? error.message : String(error),
    }
  }

  cache = { value, expiresAt: now + (value.available ? USAGE_TTL_MS : FAILURE_TTL_MS) }
  return value
}
