const fs = require('fs')
let src = fs.readFileSync('client.js', 'utf8')

// 1) 删掉英文词典块
const enStart = src.indexOf('      en: {')
if (enStart > 0) {
  const tailRe = /\n {6}\},?\r?\n {4}\}\r?\n/
  tailRe.lastIndex = enStart
  const m = tailRe.exec(src)
  if (m) src = src.slice(0, enStart) + src.slice(m.index + 1)
}

// 2) translate 固定中文
const oldTranslate = `    /** 取文案；缺键回退中文，再缺返回 key（永不渲染 undefined）。 */
    function translate(lang, key, ...args) {
      const dict = I18N[lang] || I18N.zh
      const value = dict[key] !== undefined ? dict[key] : I18N.zh[key]
      if (typeof value === 'function') return value(...args)
      return typeof value === 'string' ? value : key
    }`
const newTranslate = `    /** 取文案：界面固定中文（英文词典已移除，保留入口以免调用点大改）。 */
    function translate(_lang, key, ...args) {
      const value = I18N.zh[key]
      if (typeof value === 'function') return value(...args)
      return typeof value === 'string' ? value : key
    }`
if (!src.includes(oldTranslate)) throw new Error('translate 未找到')
src = src.replace(oldTranslate, newTranslate)

// 3) useLang 固定中文（去掉订阅与 2 秒轮询）
const langStart = src.indexOf('    /** 订阅语言变化')
const langEnd = src.indexOf('    /** 取文案')
if (langStart < 0 || langEnd < 0) throw new Error('useLang 边界')
src = src.slice(0, langStart) + `    /** 界面固定中文：不再订阅 locale 服务，也不轮询，省掉一条后台定时器。 */
    function useLang() {
      return 'zh'
    }

` + src.slice(langEnd)

// 4) L() 只返回中文
src = src.split("const L = (zh, en) => (lang === 'en' ? en : zh)").join("const L = (zh, _en) => zh")
src = src.split("const L = (zh, en) => (lang === 'en' ? en : zh)").join("const L = (zh, _en) => zh")

// 5) 宿主文本固定原文
const hostStart = src.indexOf('    /** 宿主错误消息的英文前缀映射')
const hostEnd = src.indexOf('    /**\n     * 卡片兜底')
if (hostStart > 0 && hostEnd > hostStart) {
  src = src.slice(0, hostStart) + `    /** 界面固定中文：宿主返回的消息原样显示。 */
    function translateHostText(text) {
      return String(text == null ? '' : text)
    }

` + src.slice(hostEnd)
}

// 6) 不再依赖 locale 服务
src = src.replace("      inject: ['slots', 'locale'],", "      inject: ['slots'],")
src = src.replace("      /** 仅供测试：验证词典内容与语言探测（不影响运行时）。 */\n      __test: { I18N, translate, detectLang, normalizeLang },\n", '')

fs.writeFileSync('client.js', src)
console.log('en 词典已删:', !src.includes('      en: {'))
console.log('useLang 简化:', src.includes("function useLang() {"), '| L 固定中文:', src.includes('const L = (zh, _en) => zh'))
console.log('locale 依赖:', src.includes("inject: ['slots', 'locale']"))
