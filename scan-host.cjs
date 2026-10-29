const fs = require('fs')
const files = ['index.js', 'codex.js', 'usage.js', 'deepseek.js']
const re = /'([^'\n]*[\u4e00-\u9fa5][^'\n]*)'|`([^`\n]*[\u4e00-\u9fa5][^`\n]*)`/g
for (const file of files) {
  const src = fs.readFileSync(file, 'utf8').split('\n')
  const out = []
  src.forEach((line, i) => {
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) return
    for (const m of line.matchAll(re)) {
      const text = m[1] !== undefined ? m[1] : m[2]
      // 只挑「可能走到界面」的：错误/提示类
      if (/error|Error|throw|message|reason|label|title|error:|return \{/.test(line) || true) out.push((i + 1) + ': ' + text)
    }
  })
  if (out.length) {
    console.log('=== ' + file + ' (' + out.length + ') ===')
    console.log(out.slice(0, 40).join('\n'))
  }
}
