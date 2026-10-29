const fs = require('fs')
let src = fs.readFileSync('client.js', 'utf8')

// 1) 扩展宿主文本映射：精确 + 前缀规则
const anchor = "    function translateHostText(text, lang) {"
const oldFn = `    function translateHostText(text, lang) {
      const raw = String(text == null ? '' : text)
      if (lang !== 'en') return raw
      if (HOST_TEXT_EN[raw]) return HOST_TEXT_EN[raw]
      const http = /^余额接口 HTTP (\\S+)$/.exec(raw)
      if (http) return \`Balance endpoint returned HTTP \${http[1]}\`
      return raw
    }`
const newFn = `    /** 宿主错误消息的英文前缀映射（含 HTTP 状态等后缀原样保留）。 */
    const HOST_PREFIX_EN = {
      '请求体过大': 'Request body too large',
      '请求体必须是 JSON 对象': 'Request body must be a JSON object',
      '会话授权状态写入失败': 'Failed to persist session authorization (still active in this process)',
      '尚未登录 OpenAI 账号': 'Not signed in to OpenAI',
      '尚未注册': 'Not registered',
      'Codex 返回为空': 'Codex returned an empty response',
      '模型列表返回了无法解析的 JSON': 'Model list returned unparsable JSON',
      '模型列表': 'Model list',
      '重置卡列表返回了无法解析的 JSON': 'Reset-credit list returned unparsable JSON',
      '重置卡列表': 'Reset-credit list',
      '兑换重置卡返回了无法解析的 JSON': 'Redeeming reset credit returned unparsable JSON',
      '兑换重置卡': 'Redeem reset credit',
      'Codex 限流重置': 'Codex rate-limit reset',
      '未配置 DEEPSEEK_API_KEY': 'DEEPSEEK_API_KEY is not configured',
      '余额接口返回无法解析': 'Balance endpoint returned unparsable data',
      '余额接口': 'Balance endpoint',
      'lan-redacted': 'Hidden on LAN',
    }
    function translateHostText(text, lang) {
      const raw = String(text == null ? '' : text)
      if (lang !== 'en') return raw
      if (HOST_TEXT_EN[raw]) return HOST_TEXT_EN[raw]
      for (const zh of Object.keys(HOST_PREFIX_EN)) {
        if (raw === zh) return HOST_PREFIX_EN[zh]
        if (raw.startsWith(zh + ' ')) return HOST_PREFIX_EN[zh] + raw.slice(zh.length)
        if (raw.startsWith(zh + '：')) return HOST_PREFIX_EN[zh] + ': ' + raw.slice(zh.length + 1)
        if (raw.startsWith(zh + '，')) return HOST_PREFIX_EN[zh] + ', ' + raw.slice(zh.length + 1)
      }
      return raw
    }`
if (!src.includes(oldFn)) throw new Error('translateHostText 未找到')
src = src.replace(oldFn, newFn)

// 2) 设置页所有展示宿主文本的地方都过一遍
const pairs = [
  ["L('模型列表不可用：', 'Model list unavailable: ') + modelsError", "L('模型列表不可用：', 'Model list unavailable: ') + translateHostText(modelsError, lang)"],
  ["? h('option', { value: '__none__', disabled: true }, deepseekModelsError || L('加载中…', 'Loading…'))", "? h('option', { value: '__none__', disabled: true }, deepseekModelsError ? translateHostText(deepseekModelsError, lang) : L('加载中…', 'Loading…'))"],
  ["notice ? h('div', { style: styles.notice }, notice) : null,", "notice ? h('div', { style: styles.notice }, translateHostText(notice, lang)) : null,"],
  ["error ? h('div', { style: styles.error }, error) : null,", "error ? h('div', { style: styles.error }, translateHostText(error, lang)) : null,"],
  ["`· ${credit.title}", "`· ${translateHostText(credit.title, lang)}"],
]
let hits = 0
for (const [from, to] of pairs) {
  if (src.includes(from)) { src = src.split(from).join(to); hits += 1 }
  else console.log('MISS:', from.slice(0, 50))
}
fs.writeFileSync('client.js', src)
console.log('映射函数替换:', src.includes('HOST_PREFIX_EN'), '| 展示点替换:', hits, '/', pairs.length)
