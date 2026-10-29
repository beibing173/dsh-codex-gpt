/**
 * dsh-codex-gpt / DeepSeek 余额与峰谷时段（宿主侧）。
 *
 * 侧边栏用量卡要能同时展示：
 *   1. ChatGPT 订阅的 5 小时 / 每周限额（usage.js，读 ChatGPT 后端）；
 *   2. DeepSeek 账户余额 + 当前是高峰价还是空闲价（本文件）。
 *
 * 峰谷规则（DeepSeek 官方定价说明）：北京时间 00:30–08:30 为空闲时段（折扣价），
 * 其余时间为高峰时段（标准价）。这里只做本地时间换算，不联网。
 */

const BEIJING_OFFSET_MINUTES = 8 * 60
/** 空闲时段：00:30 开始，08:30 结束（北京时间）。 */
const OFF_PEAK_START_MINUTES = 30
const OFF_PEAK_END_MINUTES = 8 * 60 + 30

const BALANCE_URL = 'https://api.deepseek.com/user/balance'
const REQUEST_TIMEOUT_MS = 8000

/** 当前时刻在北京时间里的「当天第几分钟」。 */
function beijingMinuteOfDay(nowMs) {
  const shifted = new Date(nowMs + BEIJING_OFFSET_MINUTES * 60_000)
  return shifted.getUTCHours() * 60 + shifted.getUTCMinutes()
}

/**
 * 当前是否处于空闲（折扣）时段，以及下一次切换的时间点。
 *
 * @param {number} nowMs - 当前毫秒时间戳。
 * @returns {{ isPeak: boolean, label: string, nextChangeAt: number, nextLabel: string }}
 */
export function peakState(nowMs = Date.now()) {
  const minute = beijingMinuteOfDay(nowMs)
  const isOffPeak = minute >= OFF_PEAK_START_MINUTES && minute < OFF_PEAK_END_MINUTES

  // 距离下一次切换还有多少分钟。
  let minutesToChange
  if (isOffPeak) {
    minutesToChange = OFF_PEAK_END_MINUTES - minute
  } else if (minute < OFF_PEAK_START_MINUTES) {
    minutesToChange = OFF_PEAK_START_MINUTES - minute
  } else {
    minutesToChange = 24 * 60 - minute + OFF_PEAK_START_MINUTES
  }

  return {
    isPeak: !isOffPeak,
    label: isOffPeak ? '空闲时段（折扣价）' : '高峰时段（标准价）',
    nextChangeAt: nowMs + minutesToChange * 60_000,
    nextLabel: isOffPeak ? '恢复标准价' : '进入折扣价',
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
 * @param {{ apiKey: string, fetchImpl?: typeof fetch }} options
 * @returns {Promise<{ available: boolean, total: number|null, currency: string, granted: number|null, toppedUp: number|null, error?: string }>}
 */
export async function fetchDeepseekBalance(options = {}) {
  const { apiKey } = options
  if (!apiKey) {
    return { available: false, total: null, currency: '', granted: null, toppedUp: null, error: '未配置 DEEPSEEK_API_KEY' }
  }
  const doFetch = typeof options.fetchImpl === 'function' ? options.fetchImpl : timedFetch
  try {
    const response = await doFetch(BALANCE_URL, {
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
