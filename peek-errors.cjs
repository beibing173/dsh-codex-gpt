const fs = require('fs')
const src = fs.readFileSync('client.js', 'utf8').split('\n')
src.forEach((line, i) => {
  if (/modelsError|deepseekModelsError|credit\.title|styles\.error|} , error|error\b.*styles\.hint|\{ notice|notice\b/.test(line)) {
    console.log((i + 1) + ': ' + line.trim().slice(0, 130))
  }
})
