import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  escapeHtml,
  buildAuthorizeUrl,
  REDIRECT_URI,
  CLIENT_ID,
  decodeJwtPayload,
  tokenExpiresAt,
  claimsFromToken,
  buildAuthRecord,
  describeCredential,
} from '../oauth.js'

test('escapeHtml: 回调页回显参数必须转义（防反射型 XSS）', () => {
  assert.equal(
    escapeHtml('<script>alert(1)</script>'),
    '&lt;script&gt;alert(1)&lt;/script&gt;',
  )
  assert.equal(escapeHtml('a"b\'c&d'), 'a&quot;b&#39;c&amp;d')
  assert.equal(escapeHtml('<img src=x onerror=alert(1)>'), '&lt;img src=x onerror=alert(1)&gt;')
})

test('buildAuthorizeUrl: 使用官方授权端点与固定回调', () => {
  const url = new URL(buildAuthorizeUrl({ challenge: 'chal', state: 'st' }))
  assert.equal(url.origin + url.pathname, 'https://auth.openai.com/oauth/authorize')
  assert.equal(url.searchParams.get('client_id'), CLIENT_ID)
  assert.equal(url.searchParams.get('redirect_uri'), REDIRECT_URI)
  assert.equal(url.searchParams.get('code_challenge'), 'chal')
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256')
  assert.equal(url.searchParams.get('state'), 'st')
})

test('decodeJwtPayload / tokenExpiresAt: 只解码展示信息', () => {
  const enc = (value) => Buffer.from(JSON.stringify(value)).toString('base64url')
  const token = `${enc({ alg: 'none' })}.${enc({ exp: 1900000000, email: 'a@b.c' })}.sig`
  assert.equal(decodeJwtPayload(token).email, 'a@b.c')
  assert.equal(tokenExpiresAt(token), 1900000000 * 1000)
  assert.equal(decodeJwtPayload('not-a-jwt'), undefined)
  assert.equal(tokenExpiresAt('not-a-jwt'), 0)
})

// ── 订阅到期日不同步：落盘记录 / 凭证描述两条链路的回归 ────────────────────

const jwt = (payload) => {
  const enc = (value) => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${enc({ alg: 'none' })}.${enc(payload)}.sig`
}

const AUTH_CLAIMS = (until, plan = 'plus') => ({
  chatgpt_plan_type: plan,
  chatgpt_account_id: 'acc-1',
  chatgpt_subscription_active_start: '2026-08-03T06:54:41+00:00',
  chatgpt_subscription_active_until: until,
})

test('claimsFromToken: 缺字段时给空串，不会在合并时把另一份 token 的有效值抹掉', () => {
  const claims = claimsFromToken(jwt({ email: 'a@b.c' }))
  assert.equal(claims.activeUntil, '')
  // 旧实现给 undefined，`{...at, ...id}` 会把 access_token 里的日期覆盖成 undefined。
  const merged = { ...claimsFromToken(jwt({ 'https://api.openai.com/auth': AUTH_CLAIMS('2026-11-03T00:00:00Z') })), ...claims }
  assert.equal(merged.activeUntil, '')
  assert.equal(Object.values(claimsFromToken('bad')).length, 0)
})

test('buildAuthRecord: 刷新拿到续费后的新日期时写入新值', () => {
  const previous = {
    tokens: { access_token: 'old', refresh_token: 'r' },
    active_until: '2026-10-03T06:54:41+00:00',
  }
  const next = buildAuthRecord(
    { access_token: jwt({ exp: 2e9, 'https://api.openai.com/auth': AUTH_CLAIMS('2026-11-03T06:54:41+00:00') }) },
    previous,
  )
  assert.equal(next.active_until, '2026-11-03T06:54:41+00:00')
})

test('buildAuthRecord: 刷新只换 access_token、id_token 仍是旧快照时，不把新日期改回旧值', () => {
  const previous = {
    tokens: {},
    active_until: '2026-11-03T06:54:41+00:00',
  }
  // 服务端没有重签 id_token：本次响应不带任何订阅日期。
  const next = buildAuthRecord(
    { access_token: jwt({ exp: 2e9 }), id_token: jwt({ exp: 2e9, 'https://api.openai.com/auth': AUTH_CLAIMS('2026-10-03T06:54:41+00:00') }) },
    previous,
  )
  // 旧 id_token 的日期比记录里的晚/早都不能把续费结果压回去：取较晚值。
  assert.equal(next.active_until, '2026-11-03T06:54:41+00:00')
})

test('describeCredential: token claim 比落盘快照新时以 token 为准（重新登录后日期要更新）', () => {
  const record = {
    tokens: {
      access_token: jwt({ exp: Math.floor(Date.now() / 1000) + 3600, 'https://api.openai.com/auth': AUTH_CLAIMS('2026-11-03T06:54:41+00:00') }),
    },
    active_until: '2026-10-03T06:54:41+00:00',
  }
  // 旧实现是「记录优先」，会让重新登录拿到的 11-03 被旧快照 10-03 压住。
  assert.equal(describeCredential(record).activeUntil, '2026-11-03T06:54:41+00:00')
})

test('describeCredential: 落盘快照比旧 token 新时以快照为准（续费但 token 未重签）', () => {
  const record = {
    tokens: {
      access_token: jwt({ exp: Math.floor(Date.now() / 1000) + 3600, 'https://api.openai.com/auth': AUTH_CLAIMS('2026-10-03T06:54:41+00:00') }),
    },
    active_until: '2026-11-03T06:54:41+00:00',
  }
  assert.equal(describeCredential(record).activeUntil, '2026-11-03T06:54:41+00:00')
})
