import { readFileSync } from 'node:fs'
const source = readFileSync('client.js', 'utf8')
const start = source.indexOf('function CodexSettings(')
const end = source.indexOf("name: 'codex-client'", start)
const body = source.slice(start, end)
const i = body.indexOf("if (!auth) {")
console.log(body.slice(i, i + 700))
