/**
 * dsh-codex / Codex 订阅用量读取层测试。
 *
 * 所有用例都在临时目录构造 auth.json，并通过 homeDir 覆盖凭证搜索路径，
 * 不会读取本机真实 `~/.codex/auth.json`，也不访问真实网络。
 */
import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  decodeJwtPayload,
  subscriptionFromToken,
  subscriptionFromTokens,
  laterDate,
  earlierDate,
  tokenExpiresAt,
  planLabel,
  parseUsage,
  authCandidates,
  readCodexAuth,
  getCodexUsage,
  __resetUsageCache,
} from '../usage.js'

const fakeHome = join(tmpdir(), `dsh-codex-usage-${process.pid}`)

beforeEach(() => {
  __resetUsageCache()
})

after(() => {
  rmSync(fakeHome, { recursive: true, force: true })
})

/** 构造一个 payload 可读的 JWT（不校验签名）。 */
function makeJwt(payload) {
  const enc = (value) => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${enc({ alg: 'none' })}.${enc(payload)}.sig`
}

function writeAuth(auth) {
  mkdirSync(join(fakeHome, '.codex'), { recursive: true })
  writeFileSync(join(fakeHome, '.codex', 'auth.json'), JSON.stringify(auth, null, 2))
}

const future = Math.floor(Date.now() / 1000) + 3600

test('decodeJwtPayload: 解析 payload，非法输入返回 undefined', () => {
  const token = makeJwt({ exp: future, name: 'x' })
  assert.equal(decodeJwtPayload(token).name, 'x')
  assert.equal(decodeJwtPayload('not-a-jwt'), undefined)
  assert.equal(decodeJwtPayload('a.%%%.c'), undefined)
})

test('subscriptionFromToken: 提取计划与订阅有效期', () => {
  const token = makeJwt({
    'https://api.openai.com/auth': {
      chatgpt_plan_type: 'plus',
      chatgpt_subscription_active_start: '2026-08-03T06:54:41+00:00',
      chatgpt_subscription_active_until: '2026-10-03T06:54:41+00:00',
    },
  })
  assert.deepEqual(subscriptionFromToken(token), {
    plan: 'plus',
    activeStart: '2026-08-03T06:54:41+00:00',
    activeUntil: '2026-10-03T06:54:41+00:00',
  })
  assert.equal(subscriptionFromToken('bad'), undefined)
})

test('tokenExpiresAt: 返回毫秒时间戳', () => {
  const token = makeJwt({ exp: 1793168808 })
  assert.equal(tokenExpiresAt(token), 1793168808000)
  assert.equal(tokenExpiresAt('bad'), 0)
})

test('planLabel: 已知计划映射，未知原样', () => {
  assert.equal(planLabel('plus'), 'Plus')
  assert.equal(planLabel('pro'), 'Pro')
  assert.equal(planLabel('team'), 'Team')
  assert.equal(planLabel('weird-plan'), 'weird-plan')
  assert.equal(planLabel(''), undefined)
})

test('parseUsage: 解析 5 小时 / 每周窗口、credits 与重置次数', () => {
  const parsed = parseUsage({
    plan_type: 'plus',
    rate_limit: {
      primary_window: { used_percent: 6, reset_at: 1738300000, limit_window_seconds: 18000 },
      secondary_window: { used_percent: 24.6, reset_at: 1738900000, limit_window_seconds: 604800 },
    },
    credits: { has_credits: true, unlimited: false, balance: 820.69 },
    rate_limit_reset_credits: { available_count: 1 },
  })
  assert.equal(parsed.plan, 'plus')
  assert.equal(parsed.windows.length, 2)
  assert.deepEqual(parsed.windows[0], {
    id: 'primary',
    label: '5 小时',
    usedPercent: 6,
    resetAt: 1738300000,
    windowSeconds: 18000,
  })
  assert.equal(parsed.windows[1].label, '每周')
  assert.equal(parsed.windows[1].usedPercent, 25)
  assert.equal(parsed.credits.balance, 820.69)
  assert.equal(parsed.resetCredits, 1)
})

test('parseUsage: 没有可识别窗口时返回 undefined', () => {
  assert.equal(parseUsage({}), undefined)
  assert.equal(parseUsage({ rate_limit: { primary_window: { foo: 1 } } }), undefined)
  assert.equal(parseUsage(null), undefined)
})

test('parseUsage: 非标准窗口时长生成对应标签', () => {
  const parsed = parseUsage({
    rate_limit: { primary_window: { used_percent: 10, limit_window_seconds: 3600 } },
  })
  assert.equal(parsed.windows[0].label, '1 小时')
})

test('authCandidates: CODEX_HOME 优先，其次两处默认位置', () => {
  const list = authCandidates({ CODEX_HOME: 'C:/tmp/codex' }, 'C:/Users/x')
  assert.equal(list[0], join('C:/tmp/codex', 'auth.json'))
  assert.equal(list[1], join('C:/Users/x', '.codex', 'auth.json'))
  assert.equal(list[2], join('C:/Users/x', '.config', 'codex', 'auth.json'))
})

test('readCodexAuth: 读取临时 home 下的 auth.json', () => {
  const access = makeJwt({ exp: future })
  writeAuth({
    auth_mode: 'chatgpt',
    OPENAI_API_KEY: null,
    tokens: { access_token: access, refresh_token: 'r1', id_token: makeJwt({}), account_id: 'acc-1' },
    last_refresh: '2026-10-28T05:26:49Z',
  })
  const auth = readCodexAuth({}, fakeHome)
  assert.equal(auth.path, join(fakeHome, '.codex', 'auth.json'))
  assert.equal(auth.tokens.access_token, access)
  assert.equal(auth.tokens.account_id, 'acc-1')
})

test('readCodexAuth: 凭据缺失返回 undefined', () => {
  rmSync(join(fakeHome, '.codex', 'auth.json'), { force: true })
  assert.equal(readCodexAuth({}, fakeHome), undefined)
})

test('getCodexUsage: 正常读取计划、窗口与订阅到期日', async (t) => {
  const original = globalThis.fetch
  t.after(() => {
    globalThis.fetch = original
  })
  const access = makeJwt({ exp: future })
  const idToken = makeJwt({
    'https://api.openai.com/auth': {
      chatgpt_plan_type: 'plus',
      chatgpt_subscription_active_until: '2026-10-03T06:54:41+00:00',
    },
  })
  writeAuth({
    tokens: { access_token: access, refresh_token: 'r1', id_token: idToken, account_id: 'acc-1' },
  })
  const seen = []
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), authorization: init.headers.Authorization, account: init.headers['ChatGPT-Account-Id'] })
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          plan_type: 'plus',
          rate_limit: {
            primary_window: { used_percent: 6, reset_at: 1738300000, limit_window_seconds: 18000 },
            secondary_window: { used_percent: 24, reset_at: 1738900000, limit_window_seconds: 604800 },
          },
        }),
    }
  }
  const usage = await getCodexUsage({ env: {}, homeDir: fakeHome })
  assert.equal(usage.available, true)
  assert.equal(usage.plan, 'plus')
  assert.equal(usage.planLabel, 'Plus')
  assert.equal(usage.windows.length, 2)
  assert.equal(usage.subscription.activeUntil, '2026-10-03T06:54:41+00:00')
  assert.equal(usage.source, 'chatgpt-usage')
  assert.equal(seen.length, 1)
  assert.equal(seen[0].url, 'https://chatgpt.com/backend-api/wham/usage')
  assert.equal(seen[0].authorization, `Bearer ${access}`)
  assert.equal(seen[0].account, 'acc-1')
})

test('getCodexUsage: 结果缓存 60 秒', async (t) => {
  const original = globalThis.fetch
  t.after(() => {
    globalThis.fetch = original
  })
  writeAuth({ tokens: { access_token: makeJwt({ exp: future }), account_id: 'acc-1' } })
  let count = 0
  globalThis.fetch = async () => {
    count += 1
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          plan_type: 'plus',
          rate_limit: { primary_window: { used_percent: 1, limit_window_seconds: 18000 } },
        }),
    }
  }
  await getCodexUsage({ env: {}, homeDir: fakeHome })
  await getCodexUsage({ env: {}, homeDir: fakeHome })
  assert.equal(count, 1)
})

test('getCodexUsage: 无凭证时 available=false', async () => {
  rmSync(join(fakeHome, '.codex'), { recursive: true, force: true })
  const usage = await getCodexUsage({ env: {}, homeDir: fakeHome })
  assert.equal(usage.available, false)
  assert.equal(usage.reason, 'no-auth')
})

test('getCodexUsage: 401 时刷新 token，但默认不写回 CLI auth.json', async (t) => {
  const original = globalThis.fetch
  t.after(() => {
    globalThis.fetch = original
  })
  const oldAccess = makeJwt({ exp: future })
  writeAuth({
    tokens: { access_token: oldAccess, refresh_token: 'old-refresh', id_token: makeJwt({}), account_id: 'acc-1' },
  })
  const calls = []
  globalThis.fetch = async (url, init) => {
    const target = String(url)
    calls.push({ url: target, authorization: init.headers.Authorization })
    if (target.includes('/oauth/token')) {
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            access_token: 'new-access',
            refresh_token: 'new-refresh',
            id_token: makeJwt({ exp: future }),
          }),
      }
    }
    if (init.headers.Authorization === `Bearer ${oldAccess}`) {
      return { ok: false, status: 401, statusText: 'Unauthorized', text: async () => '{"error":{"message":"expired"}}' }
    }
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          plan_type: 'plus',
          rate_limit: { primary_window: { used_percent: 3, limit_window_seconds: 18000 } },
        }),
    }
  }

  const usage = await getCodexUsage({ env: {}, homeDir: fakeHome })
  assert.equal(usage.available, true)
  assert.equal(usage.windows[0].usedPercent, 3)
  assert.equal(calls[0].url, 'https://chatgpt.com/backend-api/wham/usage')
  assert.equal(calls[1].url, 'https://auth.openai.com/oauth/token')
  assert.equal(calls[2].authorization, 'Bearer new-access')

  // 安全策略：插件只读 CLI 凭证，不替其他应用轮换 token（写回需显式 opt-in）。
  const written = JSON.parse(readFileSync(join(fakeHome, '.codex', 'auth.json'), 'utf8'))
  assert.equal(written.tokens.access_token, oldAccess)
  assert.equal(written.tokens.refresh_token, 'old-refresh')
})

test('getCodexUsage: 网络异常时 available=false 且带原因', async (t) => {
  const original = globalThis.fetch
  t.after(() => {
    globalThis.fetch = original
  })
  writeAuth({ tokens: { access_token: makeJwt({ exp: future }), account_id: 'acc-1' } })
  globalThis.fetch = async () => {
    throw new Error('offline')
  }
  const usage = await getCodexUsage({ env: {}, homeDir: fakeHome })
  assert.equal(usage.available, false)
  assert.equal(usage.reason, 'request-failed')
  assert.match(usage.error, /offline/)
})

test('getCodexUsage: 插件 OAuth 凭证优先于 Codex CLI 的 auth.json', async (t) => {
  const original = globalThis.fetch
  t.after(() => {
    globalThis.fetch = original
  })
  // 删掉 Codex CLI 凭证，确保结果只可能来自注入的插件凭证
  rmSync(join(fakeHome, '.codex'), { recursive: true, force: true })
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    text: async () =>
      JSON.stringify({
        rate_limit: { primary_window: { used_percent: 5, limit_window_seconds: 18000 } },
      }),
  })
  const usage = await getCodexUsage({
    env: {},
    homeDir: fakeHome,
    credential: {
      accessToken: makeJwt({ exp: future }),
      accountId: 'acc-plugin',
      plan: 'plus',
      activeStart: '2026-08-03T06:54:41+00:00',
      activeUntil: '2026-10-03T06:54:41+00:00',
    },
  })
  assert.equal(usage.available, true)
  assert.equal(usage.plan, 'plus')
  assert.equal(usage.planLabel, 'Plus')
  assert.equal(usage.subscription.activeStart, '2026-08-03T06:54:41+00:00')
  assert.equal(usage.subscription.activeUntil, '2026-10-03T06:54:41+00:00')
  assert.equal(usage.windows.length, 1)
})

// ── 订阅到期日不同步（续费后卡片仍显示旧日期）的回归 ────────────────────────

test('subscriptionFromToken: 没有任何订阅字段时返回 undefined（空壳会吃掉后面的兜底来源）', () => {
  // 只有 sub/plan 之外的 claim：旧实现返回 { plan: undefined, ... } 这个真值空壳，
  // 于是 `subscriptionFromToken(id) || subscriptionFromToken(at)` 永远停在 id_token 上。
  assert.equal(subscriptionFromToken(makeJwt({ email: 'a@b.c' })), undefined)
  assert.equal(subscriptionFromToken(makeJwt({ 'https://api.openai.com/auth': {} })), undefined)
  // 有任何一个字段就要正常返回。
  assert.deepEqual(
    subscriptionFromToken(makeJwt({ 'https://api.openai.com/auth': { chatgpt_plan_type: 'plus' } })),
    { plan: 'plus', activeStart: undefined, activeUntil: undefined },
  )
})

test('subscriptionFromTokens: 续费后取新签发的 token，而不是最旧的 id_token', () => {
  const now = Date.now()
  const staleId = makeJwt({
    exp: Math.floor(now / 1000) + 3600,
    'https://api.openai.com/auth': {
      chatgpt_plan_type: 'plus',
      chatgpt_subscription_active_until: '2026-10-03T06:54:41+00:00',
    },
  })
  // 续费后新签发的 access_token 带上了新日期，exp 也更晚。
  const renewedAccess = makeJwt({
    exp: Math.floor(now / 1000) + 7200,
    'https://api.openai.com/auth': {
      chatgpt_plan_type: 'plus',
      chatgpt_subscription_active_until: '2026-11-03T06:54:41+00:00',
    },
  })
  assert.equal(subscriptionFromTokens([staleId, renewedAccess], now).activeUntil, '2026-11-03T06:54:41+00:00')
  // 顺序无关：谁新用谁。
  assert.equal(subscriptionFromTokens([renewedAccess, staleId], now).activeUntil, '2026-11-03T06:54:41+00:00')
})

test('subscriptionFromTokens: 已过期的 token 不作为权威来源', () => {
  const now = Date.now()
  const expired = makeJwt({
    exp: Math.floor(now / 1000) - 60,
    'https://api.openai.com/auth': { chatgpt_subscription_active_until: '2030-01-01T00:00:00+00:00' },
  })
  const alive = makeJwt({
    exp: Math.floor(now / 1000) + 3600,
    'https://api.openai.com/auth': { chatgpt_subscription_active_until: '2026-10-03T06:54:41+00:00' },
  })
  assert.equal(subscriptionFromTokens([expired, alive], now).activeUntil, '2026-10-03T06:54:41+00:00')
  assert.deepEqual(subscriptionFromTokens([expired], now), {})
})

test('laterDate / earlierDate: 日期比较跨时区与空值都稳定', () => {
  assert.equal(laterDate('2026-10-03T06:54:41+00:00', '2026-11-03T06:54:41+00:00'), '2026-11-03T06:54:41+00:00')
  assert.equal(laterDate('2026-11-03T06:54:41+00:00', '2026-10-03T06:54:41+00:00'), '2026-11-03T06:54:41+00:00')
  // 带时区偏移的等价时刻：+08:00 的 14:54:41 就是 UTC 06:54:41，不算更晚。
  assert.equal(laterDate('2026-10-03T06:54:41Z', '2026-10-03T14:54:41+08:00'), '2026-10-03T06:54:41Z')
  assert.equal(laterDate('', '2026-11-03T00:00:00Z'), '2026-11-03T00:00:00Z')
  assert.equal(laterDate('2026-11-03T00:00:00Z', undefined), '2026-11-03T00:00:00Z')
  assert.equal(laterDate(undefined, undefined), undefined)
  assert.equal(earlierDate('2026-10-03T00:00:00Z', '2026-08-03T00:00:00Z'), '2026-08-03T00:00:00Z')
})

test('getCodexUsage: 刷新后服务端重签 id_token 时，到期日跟着更新', async (t) => {
  const original = globalThis.fetch
  t.after(() => {
    globalThis.fetch = original
  })
  __resetUsageCache()
  const oldAccess = makeJwt({ exp: future })
  const oldId = makeJwt({
    exp: future,
    'https://api.openai.com/auth': {
      chatgpt_plan_type: 'plus',
      chatgpt_subscription_active_until: '2026-10-03T06:54:41+00:00',
    },
  })
  writeAuth({
    tokens: { access_token: oldAccess, refresh_token: 'r1', id_token: oldId, account_id: 'acc-1' },
  })
  const newId = makeJwt({
    exp: future,
    'https://api.openai.com/auth': {
      chatgpt_plan_type: 'plus',
      chatgpt_subscription_active_until: '2026-11-03T06:54:41+00:00',
    },
  })
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('/oauth/token')) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ access_token: 'new-access', id_token: newId }),
      }
    }
    if (init.headers.Authorization === `Bearer ${oldAccess}`) {
      return { ok: false, status: 401, statusText: 'Unauthorized', text: async () => '{"error":{"message":"expired"}}' }
    }
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({ rate_limit: { primary_window: { used_percent: 3, limit_window_seconds: 18000 } } }),
    }
  }
  const usage = await getCodexUsage({ env: {}, homeDir: fakeHome })
  assert.equal(usage.available, true)
  assert.equal(usage.subscription.activeUntil, '2026-11-03T06:54:41+00:00')
})

test('getCodexUsage: 刷新只换 access_token 时，回退到落盘快照里的新日期（不被旧 token 压住）', async (t) => {
  const original = globalThis.fetch
  t.after(() => {
    globalThis.fetch = original
  })
  __resetUsageCache()
  const oldAccess = makeJwt({ exp: future })
  // 旧 id_token 里还是续费前的日期；落盘记录 / 注入凭证里已是续费后的新日期。
  const oldId = makeJwt({
    exp: future,
    'https://api.openai.com/auth': {
      chatgpt_plan_type: 'plus',
      chatgpt_subscription_active_until: '2026-10-03T06:54:41+00:00',
    },
  })
  writeAuth({
    tokens: { access_token: oldAccess, refresh_token: 'r1', id_token: oldId, account_id: 'acc-1' },
    active_until: '2026-11-03T06:54:41+00:00',
  })
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('/oauth/token')) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ access_token: 'new-access' }) }
    }
    if (init.headers.Authorization === `Bearer ${oldAccess}`) {
      return { ok: false, status: 401, statusText: 'Unauthorized', text: async () => '{"error":{"message":"expired"}}' }
    }
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({ rate_limit: { primary_window: { used_percent: 3, limit_window_seconds: 18000 } } }),
    }
  }
  // CLI 路径（没有注入凭证）下，只能靠 token 推断，不应臆造新日期。
  const usage = await getCodexUsage({ env: {}, homeDir: fakeHome })
  assert.equal(usage.available, true)
  assert.equal(usage.subscription.activeUntil, '2026-10-03T06:54:41+00:00')
})

test('getCodexUsage: 注入凭证的续费日期不会被旧 token claim 覆盖', async (t) => {
  const original = globalThis.fetch
  t.after(() => {
    globalThis.fetch = original
  })
  __resetUsageCache()
  rmSync(join(fakeHome, '.codex'), { recursive: true, force: true })
  const staleAccess = makeJwt({
    exp: future,
    'https://api.openai.com/auth': { chatgpt_subscription_active_until: '2026-10-03T06:54:41+00:00' },
  })
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    text: async () =>
      JSON.stringify({ rate_limit: { primary_window: { used_percent: 5, limit_window_seconds: 18000 } } }),
  })
  const usage = await getCodexUsage({
    env: {},
    homeDir: fakeHome,
    credential: {
      accessToken: staleAccess,
      accountId: 'acc-plugin',
      plan: 'plus',
      activeUntil: '2026-11-03T06:54:41+00:00',
    },
  })
  assert.equal(usage.subscription.activeUntil, '2026-11-03T06:54:41+00:00')
})

test('getCodexUsage: 续费后缓存立刻失效（不会在 TTL 内继续显示旧到期日）', async (t) => {
  const original = globalThis.fetch
  t.after(() => {
    globalThis.fetch = original
  })
  __resetUsageCache()
  rmSync(join(fakeHome, '.codex'), { recursive: true, force: true })
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    text: async () =>
      JSON.stringify({ rate_limit: { primary_window: { used_percent: 5, limit_window_seconds: 18000 } } }),
  })
  const first = await getCodexUsage({
    env: {},
    homeDir: fakeHome,
    credential: {
      accessToken: makeJwt({ exp: future }),
      accountId: 'acc-plugin',
      activeUntil: '2026-10-03T06:54:41+00:00',
    },
  })
  assert.equal(first.subscription.activeUntil, '2026-10-03T06:54:41+00:00')
  // 同一账号、同一个 access_token，只续费（到期日变了）：必须重新算。
  const second = await getCodexUsage({
    env: {},
    homeDir: fakeHome,
    credential: {
      accessToken: makeJwt({ exp: future }),
      accountId: 'acc-plugin',
      activeUntil: '2026-11-03T06:54:41+00:00',
    },
  })
  assert.equal(second.subscription.activeUntil, '2026-11-03T06:54:41+00:00')
})
