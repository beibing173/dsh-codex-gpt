/**
 * dsh-codex / OpenAI OAuth 登录。
 *
 * 与官方 Codex CLI 使用同一个公开 OAuth 客户端（PKCE 授权码流程）：
 *   1. 生成 PKCE + state，在本机 1455 端口起回调服务器；
 *   2. 浏览器打开 https://auth.openai.com/oauth/authorize（用户在 OpenAI 官网登录并同意）；
 *   3. 回调 http://localhost:1455/auth/callback 拿到 code，换 access/refresh/id token；
 *   4. 凭证存到 $DSH_HOME/dsh-codex-auth.json（与 Codex CLI 的 auth.json 分开，互不覆盖）。
 *
 * access_token 是短命 JWT，过期前用 refresh_token 自动续期并写回。
 * 浏览器侧只需要：拿授权 URL、打开它、轮询登录状态。
 */
import { randomBytes, createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { readFileSync, writeFileSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'

export const ISSUER = 'https://auth.openai.com'
/** Codex CLI 的公开 OAuth client id（官方公开值，服务端按 originator 白名单校验）。 */
export const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
export const REDIRECT_PORT = 1455
export const REDIRECT_PATH = '/auth/callback'
export const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}${REDIRECT_PATH}`
/** Codex 后端要求的 originator 头（与官方 CLI 一致）。 */
export const ORIGINATOR = 'codex_cli_rs'
const SCOPE = 'openid profile email offline_access'
const REQUEST_TIMEOUT_MS = 30_000
const LOGIN_TTL_MS = 5 * 60 * 1000

/** 解码 JWT payload（不校验签名，只读展示信息）。 */
export function decodeJwtPayload(token) {
  if (typeof token !== 'string') return undefined
  const parts = token.split('.')
  if (parts.length < 2) return undefined
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
    return payload && typeof payload === 'object' ? payload : undefined
  } catch {
    return undefined
  }
}

/** token 的过期时间（毫秒），解析不到返回 0。 */
export function tokenExpiresAt(token) {
  const payload = decodeJwtPayload(token)
  const exp = payload ? Number(payload.exp) : NaN
  return Number.isFinite(exp) ? exp * 1000 : 0
}

/** 从 token 里读 OpenAI 账号与订阅信息。 */
export function claimsFromToken(token) {
  const payload = decodeJwtPayload(token)
  if (!payload) return {}
  const auth = payload['https://api.openai.com/auth']
  const authValue = auth && typeof auth === 'object' ? auth : {}
  return {
    accountId:
      typeof authValue.chatgpt_account_id === 'string' ? authValue.chatgpt_account_id : undefined,
    userId: typeof authValue.chatgpt_user_id === 'string' ? authValue.chatgpt_user_id : undefined,
    plan: typeof authValue.chatgpt_plan_type === 'string' ? authValue.chatgpt_plan_type : undefined,
    activeStart:
      typeof authValue.chatgpt_subscription_active_start === 'string'
        ? authValue.chatgpt_subscription_active_start
        : undefined,
    activeUntil:
      typeof authValue.chatgpt_subscription_active_until === 'string'
        ? authValue.chatgpt_subscription_active_until
        : undefined,
    email: typeof payload.email === 'string' ? payload.email : undefined,
    name: typeof payload.name === 'string' ? payload.name : undefined,
  }
}

/** 生成 PKCE 对（S256）。 */
export function generatePkce() {
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

/** 构造授权页 URL。 */
export function buildAuthorizeUrl({ challenge, state }) {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: SCOPE,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
  })
  return `${ISSUER}/oauth/authorize?${params.toString()}`
}

/** 凭证存储：$DSH_HOME/dsh-codex-auth.json。 */
export function createAuthStore({ env = {}, homeDir = () => homedir() } = {}) {
  const filePath = () => join(env.DSH_HOME || homeDir(), 'dsh-codex-auth.json')
  let cache = null

  const read = () => {
    if (cache) return cache
    try {
      const parsed = JSON.parse(readFileSync(filePath(), 'utf8'))
      cache = parsed && typeof parsed === 'object' ? parsed : undefined
    } catch {
      cache = undefined
    }
    return cache
  }

  const save = (record) => {
    const file = filePath()
    try {
      mkdirSync(dirname(file), { recursive: true })
      const tmp = `${file}.${process.pid}.tmp`
      writeFileSync(tmp, JSON.stringify(record, null, 2), { encoding: 'utf8', mode: 0o600 })
      renameSync(tmp, file)
    } catch {
      // 写盘失败不影响本进程使用内存凭证
    }
    cache = record
    return record
  }

  const clear = () => {
    cache = undefined
    // 登出必须真正删掉磁盘凭证：只覆盖写会被读回，导致 UI 显示已登出但工具仍可用。
    try {
      rmSync(filePath(), { force: true })
    } catch (error) {
      throw new Error(`登出失败：无法删除凭证文件（${error instanceof Error ? error.message : String(error)}）`)
    }
    if (read()) throw new Error('登出失败：凭证文件仍可读取')
  }

  return { path: filePath, read, save, clear }
}

/** 把一次 token 响应整理成落盘记录（保留已有账号信息）。 */
export function buildAuthRecord(tokens, previous) {
  const idClaims = claimsFromToken(tokens.id_token)
  const atClaims = claimsFromToken(tokens.access_token)
  const claims = { ...atClaims, ...idClaims }
  return {
    version: 1,
    tokens: {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token || previous?.tokens?.refresh_token,
      id_token: tokens.id_token || previous?.tokens?.id_token,
      account_id: claims.accountId || previous?.tokens?.account_id,
    },
    email: claims.email || previous?.email,
    name: claims.name || previous?.name,
    plan: claims.plan || previous?.plan,
    active_start: claims.activeStart || previous?.active_start,
    active_until: claims.activeUntil || previous?.active_until,
    last_refresh: new Date().toISOString(),
  }
}

/** 从落盘记录得到调用所需的凭证描述。 */
export function describeCredential(record) {
  if (!record || !record.tokens || typeof record.tokens.access_token !== 'string') return undefined
  const idClaims = claimsFromToken(record.tokens.id_token)
  const atClaims = claimsFromToken(record.tokens.access_token)
  const claims = { ...atClaims, ...idClaims }
  return {
    accessToken: record.tokens.access_token,
    refreshToken: record.tokens.refresh_token,
    idToken: record.tokens.id_token,
    accountId: record.tokens.account_id || claims.accountId,
    email: record.email || claims.email,
    name: record.name || claims.name,
    plan: record.plan || claims.plan,
    activeStart: record.active_start || claims.activeStart,
    activeUntil: record.active_until || claims.activeUntil,
    expiresAt: tokenExpiresAt(record.tokens.access_token),
  }
}

/** 用授权码换 token。 */
async function exchangeCode({ code, verifier }) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    code_verifier: verifier,
  })
  const response = await fetch(`${ISSUER}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: body.toString(),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  const raw = await response.text()
  let json
  try {
    json = raw ? JSON.parse(raw) : undefined
  } catch {
    json = undefined
  }
  if (!response.ok || !json || typeof json.access_token !== 'string') {
    const detail = (json && (json.error_description || json.error)) || raw.slice(0, 300) || response.statusText
    throw new Error(`登录换 token 失败（HTTP ${response.status}）：${detail}`)
  }
  return json
}

/** 用 refresh_token 换新 token。 */
export async function refreshTokens(refreshToken) {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: CLIENT_ID,
    refresh_token: refreshToken,
  })
  const response = await fetch(`${ISSUER}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: body.toString(),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  const raw = await response.text()
  let json
  try {
    json = raw ? JSON.parse(raw) : undefined
  } catch {
    json = undefined
  }
  if (!response.ok || !json || typeof json.access_token !== 'string') {
    const detail = (json && (json.error_description || json.error)) || raw.slice(0, 300) || response.statusText
    throw new Error(`刷新 token 失败（HTTP ${response.status}）：${detail}`)
  }
  return json
}

/** 刷新单飞：并发调用共用一次 refresh，避免 refresh_token 互相作废。 */
let inflightRefresh = null

/** 确保拿到可用 access_token（过期前 60 秒自动刷新并写回）。 */
export async function ensureAccessToken(store) {
  const record = store.read()
  const credential = describeCredential(record)
  if (!credential) return undefined
  if (credential.expiresAt - Date.now() > 60_000) return credential
  if (!credential.refreshToken) return credential
  try {
    if (!inflightRefresh) {
      inflightRefresh = refreshTokens(credential.refreshToken).finally(() => {
        inflightRefresh = null
      })
    }
    const tokens = await inflightRefresh
    const next = buildAuthRecord(tokens, record)
    store.save(next)
    return describeCredential(next)
  } catch {
    // 刷新失败：继续用旧 token，真正失败会在调用处暴露
    return credential
  }
}

/** HTML 转义：回调页会回显 URL 参数（如 error），必须转义防反射型 XSS。 */
export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case '&':
        return '&amp;'
      case '<':
        return '&lt;'
      case '>':
        return '&gt;'
      case '"':
        return '&quot;'
      default:
        return '&#39;'
    }
  })
}

/** 回调页 HTML。 */
function respondHtml(res, status, title, detail) {
  const safeTitle = escapeHtml(title)
  const safeDetail = escapeHtml(detail)
  const body = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${safeTitle}</title>
<style>body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;background:#0b1b3a;color:#e8f0ff;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
.card{text-align:center;padding:36px 44px;border-radius:18px;background:rgba(255,255,255,.06);border:1px solid rgba(124,199,255,.35)}
h1{margin:0 0 10px;font-size:22px}p{margin:0;opacity:.75;font-size:14px;line-height:1.7}</style></head>
<body><div class="card"><h1>${safeTitle}</h1><p>${safeDetail}</p></div></body></html>`
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': String(Buffer.byteLength(body)),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  res.end(body)
}

/** 当前挂起的登录流程（同一时间只允许一个）。 */
let pending = null

/** 取消挂起的登录（关闭回调服务器）。 */
export async function cancelLogin() {
  if (!pending) return
  const current = pending
  pending = null
  try {
    current.server.close()
  } catch {
    // 已关闭
  }
  current.settle({ ok: false, reason: 'cancelled' })
}

/**
 * 启动一次登录：起本地回调服务器并返回授权 URL。
 * 浏览器打开该 URL 后，用户在 OpenAI 官网完成登录，回调会保存凭证。
 * @param {{ store: ReturnType<typeof createAuthStore> }} options
 * @returns {Promise<{ url: string, completed: Promise<object> }>}
 */
export async function beginLogin({ store }) {
  await cancelLogin()
  const { verifier, challenge } = generatePkce()
  const state = randomBytes(16).toString('hex')
  const url = buildAuthorizeUrl({ challenge, state })

  let settle
  const completed = new Promise((resolve) => {
    settle = resolve
  })

  let finished = false
  const finish = (result) => {
    if (finished) return
    finished = true
    clearTimeout(timer)
    try {
      server.close()
    } catch {
      // 已关闭
    }
    if (pending && pending.server === server) pending = null
    settle(result)
  }

  const server = createServer(async (req, res) => {
    let requestUrl
    try {
      requestUrl = new URL(String(req.url || '/'), `http://localhost:${REDIRECT_PORT}`)
    } catch {
      respondHtml(res, 400, '请求无效', '无法解析回调地址。')
      return
    }
    if (requestUrl.pathname !== REDIRECT_PATH) {
      respondHtml(res, 404, '页面不存在', '这个地址只用于 OpenAI 登录回调。')
      return
    }
    const error = requestUrl.searchParams.get('error')
    const code = requestUrl.searchParams.get('code')
    const returnedState = requestUrl.searchParams.get('state')
    if (error) {
      respondHtml(res, 400, '登录没有完成', `OpenAI 返回：${error}`)
      finish({ ok: false, reason: error })
      return
    }
    if (!code || returnedState !== state) {
      respondHtml(res, 400, '登录校验失败', 'state 不匹配或缺少授权码，请重新发起登录。')
      finish({ ok: false, reason: 'state-mismatch' })
      return
    }
    try {
      const tokens = await exchangeCode({ code, verifier })
      const record = buildAuthRecord(tokens, store.read())
      store.save(record)
      respondHtml(res, 200, '✅ 登录成功', '可以关闭这个页面，回到 Harness 继续。')
      finish({ ok: true, credential: describeCredential(record) })
    } catch (exchangeError) {
      const message = exchangeError instanceof Error ? exchangeError.message : String(exchangeError)
      respondHtml(res, 500, '登录失败', message)
      finish({ ok: false, reason: message })
    }
  })

  await new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening)
      reject(
        error && error.code === 'EADDRINUSE'
          ? new Error(`端口 ${REDIRECT_PORT} 被占用（可能 Codex CLI 正在登录）。请关闭占用后重试。`)
          : error,
      )
    }
    const onListening = () => {
      server.off('error', onError)
      resolve()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(REDIRECT_PORT, '127.0.0.1')
  })

  const timer = setTimeout(() => finish({ ok: false, reason: 'timeout' }), LOGIN_TTL_MS)
  pending = { server, settle }
  return { url, completed }
}
