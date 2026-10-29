/**
 * dsh-codex-gpt / DeepSeek 余额与峰谷时段（宿主侧）。
 *
 * 侧边栏用量卡要能同时展示：
 *   1. ChatGPT 订阅的 5 小时 / 每周限额（usage.js，读 ChatGPT 后端）；
 *   2. DeepSeek 账户余额 + 当前是高峰价还是空闲价（本文件）。
 *
 * 峰谷规则（官方定价页 api-docs.deepseek.com/quick_start/pricing，2026-10 核对）：
 *   - **高峰**：UTC 01:00–04:00 与 06:00–10:00，**周一至周五**（对应北京时间 09:00–12:00、14:00–18:00）；
 *   - **空闲（半价）**：其余所有时间，含周末与中国法定节假日全天；
 *   - 空闲价是高峰价的**一半**。
 * 法定节假日没有通用日历，这里只按「周一至周五」计算（节假日当天官方按半价，这里会显示成高峰，
 * 属于已知近似；节假日当天请以官方计费为准）。
 */

/** 高峰时段：UTC 小时区间（左闭右开），仅周一至周五生效。 */
const PEAK_WINDOWS_UTC = [
  [1, 4],
  [6, 10],
]
const HOUR_MS = 60 * 60 * 1000

const BALANCE_PATH = '/user/balance'
/** 官方端点；可用 DEEPSEEK_BASE_URL 覆盖（与 llm-deepseek 适配器一致）。 */
export const PUBLIC_BASE_URL = 'https://api.deepseek.com'
const REQUEST_TIMEOUT_MS = 8000

/** 余额端点：与 DeepSeek 适配器共用同一个 base URL 环境变量。 */
export function balanceUrl(baseUrl) {
  const base = typeof baseUrl === 'string' && baseUrl.trim() !== '' ? baseUrl.trim() : PUBLIC_BASE_URL
  return `${base.replace(/\/+$/, '')}${BALANCE_PATH}`
}

/** 某个时刻是否处在高峰时段（UTC 工作日 + 高峰窗口）。 */
export function isPeakAt(nowMs) {
  const date = new Date(nowMs)
  const day = date.getUTCDay()
  // 0 = 周日，6 = 周六：周末全天半价
  if (day === 0 || day === 6) return false
  const hour = date.getUTCHours()
  return PEAK_WINDOWS_UTC.some(([start, end]) => hour >= start && hour < end)
}

/** 下一个「状态翻转」的整点时刻（边界都在整点，按小时推进足够）。 */
function nextChangeAt(fromMs, currentPeak) {
  let cursor = Math.floor(fromMs / HOUR_MS) * HOUR_MS + HOUR_MS
  for (let i = 0; i < 24 * 10; i += 1) {
    if (isPeakAt(cursor) !== currentPeak) return cursor
    cursor += HOUR_MS
  }
  return 0
}

/**
 * 当前是否处于高峰时段，以及下一次切换的时间点。
 *
 * @param {number} nowMs - 当前毫秒时间戳。
 * @returns {{ isPeak: boolean, label: string, nextChangeAt: number, nextLabel: string, halfPriceOffPeak: boolean, excludesHolidays: boolean }}
 */
export function peakState(nowMs = Date.now()) {
  const isPeak = isPeakAt(nowMs)
  return {
    isPeak,
    label: isPeak ? '高峰时段（标准价）' : '空闲时段（半价）',
    nextChangeAt: nextChangeAt(nowMs, isPeak),
    nextLabel: isPeak ? '进入空闲时段' : '进入高峰时段',
    /** 空闲价是高峰价的一半（官方定价页脚注）。 */
    halfPriceOffPeak: true,
    /** 法定节假日没有通用日历：这里按「周一至周五」近似，节假日当天官方实际按半价。 */
    excludesHolidays: false,
  }
}

/**
 * 解析 DeepSeek 余额接口。
 * 接口形状：{ is_available, balance_infos: [{ currency, total_balance, granted_balance, topped_up_balance }] }
 */
export function parseDeepseekBalance(json) {
  const infos = Array.isArray(json && json.balance_infos) ? json.balance_infos : []
  const preferred = infos.find((item) => item && item.currency === 'CNY') || infos[0]
  if (!preferred) {
    return { available: json ? json.is_available === true : false, total: null, currency: '', granted: null, toppedUp: null }
  }
  const toNumber = (value) => {
    const n = Number(value)
    return Number.isFinite(n) ? n : null
  }
  return {
    available: json ? json.is_available === true : true,
    total: toNumber(preferred.total_balance),
    currency: typeof preferred.currency === 'string' ? preferred.currency : '',
    granted: toNumber(preferred.granted_balance),
    toppedUp: toNumber(preferred.topped_up_balance),
  }
}

/** 兼容测试替换 fetch 的小工具（超时后返回失败，不阻塞界面）。 */
async function timedFetch(url, init, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 查一次 DeepSeek 余额。
 *
 * @param {{ apiKey: string, baseUrl?: string, fetchImpl?: typeof fetch }} options
 * @returns {Promise<{ available: boolean, total: number|null, currency: string, granted: number|null, toppedUp: number|null, error?: string }>}
 */
export async function fetchDeepseekBalance(options = {}) {
  const { apiKey } = options
  if (!apiKey) {
    return { available: false, total: null, currency: '', granted: null, toppedUp: null, error: '未配置 DEEPSEEK_API_KEY' }
  }
  const doFetch = typeof options.fetchImpl === 'function' ? options.fetchImpl : timedFetch
  try {
    const response = await doFetch(balanceUrl(options.baseUrl), {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
      },
    })
    if (!response || response.ok === false) {
      return {
        available: false,
        total: null,
        currency: '',
        granted: null,
        toppedUp: null,
        error: `余额接口 HTTP ${response && response.status ? response.status : '未知'}`,
      }
    }
    const text = typeof response.text === 'function' ? await response.text() : ''
    let json = null
    try {
      json = text ? JSON.parse(text) : null
    } catch {
      json = null
    }
    if (!json) {
      return { available: false, total: null, currency: '', granted: null, toppedUp: null, error: '余额接口返回无法解析' }
    }
    return parseDeepseekBalance(json)
  } catch (error) {
    return {
      available: false,
      total: null,
      currency: '',
      granted: null,
      toppedUp: null,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}
