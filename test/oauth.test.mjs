import { test } from 'node:test'
import assert from 'node:assert/strict'
import { escapeHtml, buildAuthorizeUrl, REDIRECT_URI, CLIENT_ID, decodeJwtPayload, tokenExpiresAt } from '../oauth.js'

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
