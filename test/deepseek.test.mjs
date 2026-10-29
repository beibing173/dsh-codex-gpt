import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fetchDeepseekBalance, parseDeepseekBalance, peakState, balanceUrl, PUBLIC_BASE_URL } from '../deepseek.js'

/**
 * 官方规则（api-docs.deepseek.com/quick_start/pricing，2026-10 核对）：
 * 高峰 = UTC 01:00–04:00 与 06:00–10:00，周一至周五；其余（含周末、节假日全天）半价。
 * 北京时间 = UTC + 8，所以工作日 09:00–12:00、14:00–18:00 是高峰。
 */
function utc(year, month, day, hour, minute = 0) {
  return Date.UTC(year, month - 1, day, hour, minute, 0, 0)
}

test('peakState: 工作日 UTC 01–04 / 06–10 是高峰，其余空闲', () => {
  // 2026-11-02 是周一
  const cases = [
    [1, 0, true],
    [3, 59, true],
    [4, 0, false],
    [5, 30, false],
    [6, 0, true],
    [9, 59, true],
    [10, 0, false],
    [0, 30, false],
  ]
  for (const [hour, minute, expected] of cases) {
    const state = peakState(utc(2026, 11, 2, hour, minute))
    assert.equal(state.isPeak, expected, '周一 UTC ' + hour + ':' + minute + ' 判定错误')
    assert.equal(state.halfPriceOffPeak, true, '官方：空闲价是高峰价的一半')
  }
})

test('peakState: 周末全天都是空闲（半价）', () => {
  // 2026-11-07 周六、2026-11-08 周日
  for (const hour of [1, 2, 6, 9]) {
    for (const day of [7, 8]) {
      const state = peakState(utc(2026, 11, day, hour, 0))
      assert.equal(state.isPeak, false, '周末 UTC ' + hour + ':00 应为空闲')
      assert.match(state.label, /空闲/)
    }
  }
})

test('peakState: 下一次切换时间点算得对', () => {
  // 周一 00:30 空闲 → 01:00 进入高峰
  const beforePeak = peakState(utc(2026, 11, 2, 0, 30))
  assert.equal(beforePeak.isPeak, false)
  assert.equal(beforePeak.nextChangeAt, utc(2026, 11, 2, 1, 0))
  assert.match(beforePeak.nextLabel, /进入高峰/)

  // 周一 02:00 高峰 → 04:00 进空闲
  const inPeak = peakState(utc(2026, 11, 2, 2, 0))
  assert.equal(inPeak.nextChangeAt, utc(2026, 11, 2, 4, 0))
  assert.match(inPeak.nextLabel, /进入空闲/)

  // 周一 10:00 空闲 → 次日（周二）01:00 进高峰
  const afterPeak = peakState(utc(2026, 11, 2, 10, 0))
  assert.equal(afterPeak.nextChangeAt, utc(2026, 11, 3, 1, 0))

  // 周六 02:00 空闲 → 下周一 01:00
  const weekend = peakState(utc(2026, 11, 7, 2, 0))
  assert.equal(weekend.nextChangeAt, utc(2026, 11, 9, 1, 0))
})

test('parseDeepseekBalance: 取 CNY 账户的总额', () => {
  const parsed = parseDeepseekBalance({
    is_available: true,
    balance_infos: [
      { currency: 'USD', total_balance: '3.00', granted_balance: '0.00', topped_up_balance: '3.00' },
      { currency: 'CNY', total_balance: '21.30', granted_balance: '1.30', topped_up_balance: '20.00' },
    ],
  })
  assert.equal(parsed.available, true)
  assert.equal(parsed.total, 21.3)
  assert.equal(parsed.currency, 'CNY')
  assert.equal(parsed.toppedUp, 20)
})

test('parseDeepseekBalance: 字段缺失不崩，也不编数字', () => {
  assert.equal(parseDeepseekBalance(null).total, null)
  assert.equal(parseDeepseekBalance({}).available, false)
  assert.equal(parseDeepseekBalance({ balance_infos: [] }).total, null)
  assert.equal(parseDeepseekBalance({ balance_infos: [{ currency: 'CNY', total_balance: 'oops' }] }).total, null)
})

test('balanceUrl: 默认官方端点，DEEPSEEK_BASE_URL 可覆盖（与适配器同口径）', () => {
  assert.equal(balanceUrl(), `${PUBLIC_BASE_URL}/user/balance`)
  assert.equal(balanceUrl(''), `${PUBLIC_BASE_URL}/user/balance`)
  assert.equal(balanceUrl('https://gateway.example.com/'), 'https://gateway.example.com/user/balance')
  assert.equal(balanceUrl('https://gw.example.com/v1'), 'https://gw.example.com/v1/user/balance')
})

test('fetchDeepseekBalance: 传 baseUrl 时打到覆盖后的端点', async () => {
  let seen = ''
  await fetchDeepseekBalance({
    apiKey: 'sk-test',
    baseUrl: 'https://gw.example.com/',
    fetchImpl: async (url) => {
      seen = url
      return { ok: true, status: 200, text: async () => JSON.stringify({ balance_infos: [{ currency: 'CNY', total_balance: '1.00' }] }) }
    },
  })
  assert.equal(seen, 'https://gw.example.com/user/balance')
})

test('fetchDeepseekBalance: 没配 Key 不打网络', async () => {
  let called = 0
  const result = await fetchDeepseekBalance({
    apiKey: '',
    fetchImpl: async () => {
      called += 1
      throw new Error('should not fetch')
    },
  })
  assert.equal(called, 0)
  assert.equal(result.total, null)
  assert.match(result.error, /DEEPSEEK_API_KEY/)
})

test('fetchDeepseekBalance: 正常返回 / HTTP 失败 / 网络异常都不抛', async () => {
  const ok = await fetchDeepseekBalance({
    apiKey: 'sk-test',
    fetchImpl: async (url, init) => {
      assert.match(url, /api\.deepseek\.com\/user\/balance/)
      assert.equal(init.headers.Authorization, 'Bearer sk-test')
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '8.88' }] }),
      }
    },
  })
  assert.equal(ok.total, 8.88)

  const httpFail = await fetchDeepseekBalance({
    apiKey: 'sk-test',
    fetchImpl: async () => ({ ok: false, status: 401, text: async () => '' }),
  })
  assert.equal(httpFail.total, null)
  assert.match(httpFail.error, /401/)

  const networkFail = await fetchDeepseekBalance({
    apiKey: 'sk-test',
    fetchImpl: async () => {
      throw new Error('ENOTFOUND')
    },
  })
  assert.equal(networkFail.total, null)
  assert.match(networkFail.error, /ENOTFOUND/)
})
