/**
 * dsh-codex / Codex 后端调用层（OAuth 版）。
 *
 * 使用与官方 Codex CLI 相同的 ChatGPT 后端（不是 api.openai.com API Key）：
 *   - 推理：POST https://chatgpt.com/backend-api/codex/responses（SSE）
 *   - 模型：GET  https://chatgpt.com/backend-api/codex/models?client_version=1.0.0
 * 两者都需要 OAuth access_token，并带 `originator: codex_cli_rs` 头（服务端白名单）。
 *
 * 额度走 ChatGPT 订阅（侧边栏卡片的 5 小时 / 每周限额），不产生 API 计费。
 */
import { randomUUID } from 'node:crypto'

const BACKEND = 'https://chatgpt.com/backend-api/codex'
const WHAM_BASE = 'https://chatgpt.com/backend-api/wham'
const ORIGINATOR = 'codex_cli_rs'
const MODELS_TIMEOUT_MS = 15_000

/** analyze 模式：只做分析、评审、定位，不改代码。 */
export const ANALYZE_INSTRUCTIONS = [
  '你是 OpenAI Codex 推理模型，作为独立专家为另一个编码 Agent 提供专业分析。',
  '目标：给出可验证、可执行的判断，而不是泛泛而谈。',
  '要求：',
  '1. 先复述你理解的问题与关键约束（简短），再给结论。',
  '2. 结论必须落到具体文件/函数/行为/命令上；缺少信息时明确列出需要补充什么。',
  '3. 涉及代码时给出最小充分片段与修改位置，说明为什么这样改。',
  '4. 指出风险、边界条件与验证方法。',
  '5. 不要写与任务无关的客套话；不要声称你执行了未实际执行的操作。',
].join('\n')

/** build 模式：直接产出可落地的代码与补丁。 */
export const BUILD_INSTRUCTIONS = [
  '你是 OpenAI Codex 编码模型，为另一个编码 Agent 产出可直接落地的实现方案。',
  '要求：',
  '1. 先给实现要点（数据结构、接口、控制流），再给完整代码或精确补丁。',
  '2. 代码按目标项目现有风格书写；标注每个片段应放入的文件路径。',
  '3. 列出需要新增/修改的依赖与命令，并给出验证步骤。',
  '4. 显式说明不确定之处与假设，不要编造不存在的 API。',
  '5. 输出使用 Markdown，代码块标注语言。',
].join('\n')

/** 组装用户输入：任务 + 可选上下文。 */
export function composeUserInput(task, context) {
  const head = String(task ?? '').trim()
  const tail = String(context ?? '').trim()
  if (!tail) return head
  return `${head}\n\n---\n\n附加上下文：\n${tail}`
}

/** Responses API 的文本提取。 */
export function extractResponsesText(json) {
  if (!json || typeof json !== 'object') return ''
  if (typeof json.output_text === 'string' && json.output_text.trim()) {
    return json.output_text.trim()
  }
  const chunks = []
  if (Array.isArray(json.output)) {
    for (const item of json.output) {
      if (!item || typeof item !== 'object') {
        if (typeof item === 'string') chunks.push(item)
        continue
      }
      if (item.type === 'reasoning') continue
      if (typeof item.text === 'string') {
        chunks.push(item.text)
        continue
      }
      if (!Array.isArray(item.content)) continue
      for (const part of item.content) {
        if (!part) continue
        if (typeof part === 'string') {
          chunks.push(part)
          continue
        }
        if (part.type === 'reasoning_text') continue
        if (typeof part.text === 'string') chunks.push(part.text)
      }
    }
  }
  return chunks.join('\n\n').trim()
}

/**
 * 解析 Codex 后端的 SSE 文本。
 * 优先拼接 `response.output_text.delta`；没有 delta 时退回 `response.completed` 的完整输出。
 * @param {string} sseText 原始 SSE 响应体。
 * @returns {string} 回答文本。
 */
export function parseCodexSse(sseText) {
  const deltas = []
  let completedText = ''
  let failure = ''
  for (const line of String(sseText ?? '').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('data:')) continue
    const payload = trimmed.slice(5).trim()
    if (!payload || payload === '[DONE]') continue
    let event
    try {
      event = JSON.parse(payload)
    } catch {
      continue
    }
    if (!event || typeof event !== 'object') continue
    const type = event.type
    if (type === 'response.output_text.delta' && typeof event.delta === 'string') {
      deltas.push(event.delta)
      continue
    }
    if (type === 'response.completed' || type === 'response.done') {
      const response = event.response && typeof event.response === 'object' ? event.response : undefined
      const text = response ? extractResponsesText(response) : ''
      if (text) completedText = text
      continue
    }
    if (type === 'response.failed' || type === 'response.error' || type === 'error') {
      const response = event.response && typeof event.response === 'object' ? event.response : undefined
      failure =
        (response && response.error && (response.error.message || response.error.code)) ||
        (event.error && (event.error.message || event.error.code)) ||
        event.message ||
        type
      continue
    }
    if (event.object === 'response' && !completedText) {
      const text = extractResponsesText(event)
      if (text) completedText = text
    }
  }
  if (failure) throw new Error(String(failure))
  return (deltas.join('') || completedText).trim()
}

/** Codex 后端的请求头。 */
function codexHeaders(accessToken, accountId, { stream }) {
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    originator: ORIGINATOR,
    Accept: stream ? 'text/event-stream' : 'application/json',
  }
  if (typeof accountId === 'string' && accountId) headers['chatgpt-account-id'] = accountId
  if (stream) headers['Content-Type'] = 'application/json'
  return headers
}

/**
 * 调用 Codex 后端做一次分析/构建。
 * @param {object} options
 * @param {string} options.accessToken OAuth access_token。
 * @param {string} [options.accountId] ChatGPT account id。
 * @param {string} options.model 模型 slug。
 * @param {'analyze' | 'build'} options.mode 任务模式。
 * @param {string} options.task 任务正文。
 * @param {string} [options.context] 附加上下文。
 * @param {AbortSignal} [options.signal] 取消/超时信号。
 * @returns {Promise<{ text: string, model: string, endpoint: string }>}
 */
export async function callCodexBackend(options) {
  const { accessToken, accountId, model, mode, task, context, signal, timeoutMs = 240_000 } = options
  const instructions = mode === 'build' ? BUILD_INSTRUCTIONS : ANALYZE_INSTRUCTIONS
  const userText = composeUserInput(task, context)
  const body = {
    model,
    instructions,
    input: [{ role: 'user', content: [{ type: 'input_text', text: userText }] }],
    stream: true,
    store: false,
  }
  const timeout = AbortSignal.timeout(timeoutMs)
  const composed =
    signal && typeof AbortSignal.any === 'function' ? AbortSignal.any([signal, timeout]) : timeout
  const response = await fetch(`${BACKEND}/responses`, {
    method: 'POST',
    headers: codexHeaders(accessToken, accountId, { stream: true }),
    body: JSON.stringify(body),
    signal: composed,
  })
  const raw = await response.text()
  if (!response.ok) {
    let detail = raw.slice(0, 800)
    try {
      const json = JSON.parse(raw)
      detail = (json.error && (json.error.message || json.error.code)) || json.message || detail
    } catch {
      // 保留原始文本
    }
    const error = new Error(`Codex HTTP ${response.status}: ${detail || response.statusText}`)
    error.status = response.status
    throw error
  }
  const contentType = response.headers.get('content-type') || ''
  if (contentType.includes('application/json')) {
    let json
    try {
      json = JSON.parse(raw)
    } catch {
      json = undefined
    }
    const text = extractResponsesText(json)
    if (!text) throw new Error('Codex 返回为空')
    return { text, model, endpoint: 'codex/responses' }
  }
  const text = parseCodexSse(raw)
  if (!text) throw new Error('Codex 返回为空')
  return { text, model, endpoint: 'codex/responses' }
}

/**
 * 从 OpenAI 实时拉取当前账号可用的 Codex 模型列表。
 * @param {{ accessToken: string, accountId?: string, signal?: AbortSignal }} options
 * @returns {Promise<Array<{ slug: string, displayName: string, contextWindow?: number }>>}
 */
export async function fetchCodexModels(options) {
  const { accessToken, accountId, signal } = options
  const timeout = AbortSignal.timeout(MODELS_TIMEOUT_MS)
  const composed =
    signal && typeof AbortSignal.any === 'function' ? AbortSignal.any([signal, timeout]) : timeout
  const response = await fetch(`${BACKEND}/models?client_version=1.0.0`, {
    method: 'GET',
    headers: codexHeaders(accessToken, accountId, { stream: false }),
    signal: composed,
  })
  const raw = await response.text()
  if (!response.ok) {
    const error = new Error(`模型列表 HTTP ${response.status}: ${raw.slice(0, 300) || response.statusText}`)
    error.status = response.status
    throw error
  }
  let json
  try {
    json = JSON.parse(raw)
  } catch {
    throw new Error('模型列表返回了无法解析的 JSON')
  }
  const entries = Array.isArray(json && json.models) ? json.models : []
  const models = []
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue
    const slug = typeof entry.slug === 'string' ? entry.slug.trim() : ''
    if (!slug) continue
    models.push({
      slug,
      displayName:
        (typeof entry.display_name === 'string' && entry.display_name.trim()) ||
        (typeof entry.name === 'string' && entry.name.trim()) ||
        slug,
      contextWindow: Number.isFinite(Number(entry.context_window))
        ? Math.round(Number(entry.context_window))
        : undefined,
    })
  }
  return models
}

/** WHAM 接口的通用鉴权头。 */
function whamHeaders(accessToken, accountId) {
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    originator: ORIGINATOR,
    Accept: 'application/json',
  }
  if (typeof accountId === 'string' && accountId) headers['chatgpt-account-id'] = accountId
  return headers
}

/**
 * 读取「重置卡」（banked rate-limit reset）明细。
 * 只有 status === 'available' 的条目可被兑换；available_count 是权威数量
 * （后端可能限制返回条数，所以两者都可能存在差异）。
 * @param {{ accessToken: string, accountId?: string, signal?: AbortSignal }} options
 * @returns {Promise<{ availableCount: number, credits: Array<{ id: string, title: string, expiresAt: string | null }> }>}
 */
export async function fetchResetCredits(options) {
  const { accessToken, accountId, signal } = options
  const timeout = AbortSignal.timeout(MODELS_TIMEOUT_MS)
  const composed =
    signal && typeof AbortSignal.any === 'function' ? AbortSignal.any([signal, timeout]) : timeout
  const response = await fetch(`${WHAM_BASE}/rate-limit-reset-credits`, {
    method: 'GET',
    headers: whamHeaders(accessToken, accountId),
    signal: composed,
  })
  const raw = await response.text()
  if (!response.ok) {
    const error = new Error(`重置卡列表 HTTP ${response.status}: ${raw.slice(0, 300) || response.statusText}`)
    error.status = response.status
    throw error
  }
  let json
  try {
    json = JSON.parse(raw)
  } catch {
    throw new Error('重置卡列表返回了无法解析的 JSON')
  }
  const entries = Array.isArray(json && json.credits) ? json.credits : []
  const credits = entries
    .filter((entry) => entry && typeof entry === 'object' && entry.status === 'available' && entry.id)
    .map((entry) => ({
      id: String(entry.id),
      title:
        (typeof entry.title === 'string' && entry.title.trim()) ||
        (typeof entry.description === 'string' && entry.description.trim()) ||
        'Codex 限流重置',
      expiresAt: typeof entry.expires_at === 'string' ? entry.expires_at : null,
    }))
    // 最早过期的排前面，兑换时优先用掉快过期的。
    .sort((a, b) => String(a.expiresAt || '9999').localeCompare(String(b.expiresAt || '9999')))
  const availableCount = Number(json && json.available_count)
  return {
    availableCount: Number.isFinite(availableCount) && availableCount >= 0 ? Math.round(availableCount) : credits.length,
    credits,
  }
}

/**
 * 兑换一张重置卡（不可撤销）。
 * @param {{ accessToken: string, accountId?: string, creditId?: string, signal?: AbortSignal }} options
 * @returns {Promise<{ code: string, windowsReset: number, creditId?: string }>}
 *   code: reset | nothing_to_reset | no_credit | already_redeemed
 */
export async function consumeResetCredit(options) {
  const { accessToken, accountId, creditId, signal } = options
  const body = { redeem_request_id: randomUUID() }
  if (typeof creditId === 'string' && creditId) body.credit_id = creditId
  const timeout = AbortSignal.timeout(30_000)
  const composed =
    signal && typeof AbortSignal.any === 'function' ? AbortSignal.any([signal, timeout]) : timeout
  const response = await fetch(`${WHAM_BASE}/rate-limit-reset-credits/consume`, {
    method: 'POST',
    headers: { ...whamHeaders(accessToken, accountId), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: composed,
  })
  const raw = await response.text()
  if (!response.ok) {
    const error = new Error(`兑换重置卡 HTTP ${response.status}: ${raw.slice(0, 300) || response.statusText}`)
    error.status = response.status
    throw error
  }
  let json
  try {
    json = JSON.parse(raw)
  } catch {
    throw new Error('兑换重置卡返回了无法解析的 JSON')
  }
  return {
    code: typeof json.code === 'string' ? json.code : 'unknown',
    windowsReset: Number.isFinite(Number(json.windows_reset)) ? Math.round(Number(json.windows_reset)) : 0,
    creditId: json.credit && typeof json.credit.id === 'string' ? json.credit.id : undefined,
  }
}
