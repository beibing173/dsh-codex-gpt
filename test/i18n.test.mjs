import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = readFileSync(join(root, 'client.js'), 'utf8')

/** 抠出 I18N 里的 zh / en 两个字典块。 */
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

test('i18n: 英文词典覆盖中文词典的每一个键（漏翻会显示中文而不是 undefined）', () => {
  const zh = keysOf(dictBlock('zh'))
  const en = keysOf(dictBlock('en'))
  assert.ok(zh.length >= 15, `中文词典键太少：${zh.length}`)
  const missing = zh.filter((key) => !en.includes(key))
  assert.deepEqual(missing, [], `英文缺少这些键：${missing.join(', ')}`)
})

test('i18n: 卡片文案走 t()，不再硬编码中文', () => {
  const cardStart = source.indexOf('function CodexUsageCard(')
  const cardEnd = source.indexOf("    /** 设置 →「ChatGPT」页。 */", cardStart)
  assert.ok(cardStart > 0 && cardEnd > cardStart, '定位不到用量卡组件')
  const card = source.slice(cardStart, cardEnd)
  // 这些是曾经写死在卡片里的用户可见文案，现在必须来自 t('...')。
  for (const literal of ['余额', '按量计费', '折扣价时段', '标准价时段', '时段未知', '暂无余额数据', '暂无用量数据', '刷新中…']) {
    assert.equal(card.includes(`'${literal}'`) || card.includes(`\`${literal}`), false, `卡片里仍有硬编码文案：${literal}`)
  }
  assert.ok(card.includes("t('balance')"), '余额文案应走 t()')
  assert.ok(card.includes("t('paygo')"), '按量计费文案应走 t()')
})
