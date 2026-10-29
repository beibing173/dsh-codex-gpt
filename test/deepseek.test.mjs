import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fetchDeepseekBalance, parseDeepseekBalance, peakState } from '../deepseek.js'

/** 北京时间转时间戳（UTC+8）。 */
function beijing(year, month, day, hour, minute) {
  return Date.UTC(year, month - 1, day, hour - 8, minute, 0, 0)
}

test('peakState: 00:30–08:30 是空闲（折扣）时段', () => {
  const at0030 = peakState(beijing(2026, 10, 29, 0, 30))
  assert.equal(at0030.isPeak, false)
  assert.match(at0030.label, /空闲/)

  const at0500 = peakState(beijing(2026, 10, 29, 5, 0))
  assert.equal(at0500.isPeak, false)

  const at0829 = peakState(beijing(2026, 10, 29, 8, 29))
  assert.equal(at0829.isPeak, false)
})

test('peakState: 其余时间都是高峰（标准价）', () => {
  for (const [hour, minute] of [
    [0, 29],
    [8, 30],
    [12, 0],
    [23, 59],
  ]) {
    const state = peakState(beijing(2026, 10, 29, hour, minute))
    assert.equal(state.isPeak, true, `${hour}:${minute} 应为高峰`)
    assert.match(state.label, /高峰/)
  }
})

test('peakState: 下一次切换时间点算得对', () => {
  // 空闲中 07:30 → 60 分钟后恢复标准价
  const nearEnd = peakState(beijing(2026, 10, 29, 7, 30))
  assert.equal(nearEnd.isPeak, false)
  assert.equal(nearEnd.nextChangeAt, beijing(2026, 10, 29, 8, 30))
  assert.match(nearEnd.nextLabel, /恢复标准价/)

  // 高峰中 00:00 → 30 分钟后进入折扣价
  const nearStart = peakState(beijing(2026, 10, 29, 0, 0))
  assert.equal(nearStart.isPeak, true)
  assert.equal(nearStart.nextChangeAt, beijing(2026, 10, 29, 0, 30))
  assert.match(nearStart.nextLabel, /折扣价/)

  // 高峰中 12:00 → 次日 00:30
  const noon = peakState(beijing(2026, 10, 29, 12, 0))
  assert.equal(noon.nextChangeAt, beijing(2026, 10, 30, 0, 30))
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
