#!/usr/bin/env node
/**
 * 发布包完整性校验 —— `npm pack` 的补充闸门。
 *
 * 为什么需要它：本插件不做构建，发布包就是源码本身，`package.json` 的 `files`
 * 白名单是唯一防线。而 `npm pack` **只按白名单拷文件，从不检查导入图**：
 * 如果 `files` 漏了某个被 `import './x.js'` 引用的模块，打包依然"成功"、
 * 退出码依然 0，缺陷要等用户装到机器上才以 `ERR_MODULE_NOT_FOUND` 爆出来。
 *
 * 本脚本做三件事：
 *   1. 白名单里的每个条目确实存在于磁盘（防止拼错/删文件后忘记改 files）；
 *   2. 已发布的每个 .js 的相对导入目标也必须在发布集内（导入图封闭性）；
 *   3. 把发布集真的拷到临时目录并 import 入口，做一次运行时冒烟。
 *
 * 任一步失败即以非零码退出，供 CI 拦下。
 */
import { execFileSync } from 'node:child_process'
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync,
  readdirSync, rmSync, statSync, symlinkSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, posix, relative, isAbsolute } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const problems = []
const pass = (msg) => console.log(`  \u2713 ${msg}`)
const fail = (msg) => { problems.push(msg); console.log(`  \u2717 ${msg}`) }

/** 取 npm 真正会打进 tarball 的文件清单（权威口径）。 */
function packedFiles() {
  try {
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
    const stdout = execFileSync(npm, ['pack', '--dry-run', '--json'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    })
    const parsed = JSON.parse(stdout)
    const entry = Array.isArray(parsed) ? parsed[0] : parsed
    return { files: entry.files.map((f) => f.path), how: 'npm pack --dry-run --json' }
  } catch (error) {
    // 沙箱内可能不允许起子进程：退化为按 files 字段自行展开，结论仍有效。
    console.log(`  ! npm pack 不可用（${error.code || error.message}），改用 package.json files 字段展开`)
    return { files: expandFilesField(), how: 'package.json files' }
  }
}

/** 简易展开 package.json 的 files 字段（支持目录与 `*` 通配）。 */
function expandFilesField() {
  const { files = [] } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const found = []
  const hasMagic = (p) => p.includes('*')

  const walk = (dir, rel) => {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name === '.git') continue
      const abs = join(dir, name)
      const next = posix.join(rel, name)
      if (statSync(abs).isDirectory()) walk(abs, next)
      else found.push(next)
    }
  }

  for (const entry of files) {
    if (hasMagic(entry)) {
      const abs = join(root, entry)
      const dir = dirname(abs)
      const pattern = new RegExp('^' + posix.basename(entry).replace(/\./g, '\\.').replace(/\*/g, '[^/]*') + '$')
      if (existsSync(dir)) {
        for (const name of readdirSync(dir)) {
          if (pattern.test(name)) found.push(posix.join(posix.dirname(entry), name))
        }
      }
      continue
    }
    const abs = join(root, entry)
    if (!existsSync(abs)) continue
    if (statSync(abs).isDirectory()) walk(abs, entry)
    else found.push(entry)
  }
  return [...new Set(found)].sort()
}

/** 从源码里抽出所有相对导入目标（静态 import 与动态 import() 都算）。 */
function relativeImports(source) {
  const specs = new Set()
  const patterns = [
    /(?:^|[\s;{(])(?:import|export)\s[^'"`]*?from\s*['"](\.{1,2}\/[^'"]+)['"]/gm,
    /(?:^|[\s;{(])import\s*['"](\.{1,2}\/[^'"]+)['"]/gm,
    /import\s*\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/gm,
  ]
  for (const re of patterns) {
    for (const match of source.matchAll(re)) specs.add(match[1])
  }
  return [...specs]
}

console.log(`\n校验 ${posix.basename(root)} 的发布包…`)

// ── 1. 白名单条目存在性 ────────────────────────────────────────────────
const { files, how } = packedFiles()
console.log(`\n[1/3] 发布集来源：${how}（共 ${files.length} 个文件）`)
const shipped = new Set(files)
const declared = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).files || []
for (const entry of declared) {
  const abs = join(root, entry.replace(/\*.*$/, ''))
  if (!existsSync(abs)) fail(`files 里的 "${entry}" 在磁盘上不存在`)
}
if (problems.length === 0) pass('files 条目全部存在于磁盘')

// ── 2. 导入图封闭性（这一步才真正抓得到漏文件）────────────────────────
console.log('\n[2/3] 导入图封闭性')
const moduleFiles = files.filter((f) => f.endsWith('.js') || f.endsWith('.mjs'))
let dangling = 0
for (const file of moduleFiles) {
  const source = readFileSync(join(root, file), 'utf8')
  for (const spec of relativeImports(source)) {
    const target = posix.normalize(posix.join(posix.dirname(file), spec))
    if (shipped.has(target)) continue
    // 允许省略扩展名 / 指到目录 index.js 的写法
    const candidates = [target, `${target}.js`, `${target}.mjs`, posix.join(target, 'index.js')]
    if (candidates.some((c) => shipped.has(c))) continue
    dangling += 1
    fail(`${file} 引用了 ${spec}，但发布集里没有 ${target}` +
      (existsSync(join(root, target)) ? '（文件在仓库里，但不在 files 白名单内）' : '（文件根本不存在）'))
  }
}
if (dangling === 0) pass(`${moduleFiles.length} 个模块的相对导入全部落在发布集内`)

// ── 3. 运行时冒烟：把发布集拷出来真的 import 一次 ───────────────────────
console.log('\n[3/3] 运行时冒烟')
const main = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).main || 'index.js'
const temp = mkdtempSync(join(tmpdir(), 'verify-pack-'))
try {
  for (const file of files) {
    const dest = join(temp, file)
    mkdirSync(dirname(dest), { recursive: true })
    copyFileSync(join(root, file), dest)
  }

  // 让临时副本能解析到真实依赖（仅拷贝发布集，node_modules 用链接补）。
  const projectModules = join(root, 'node_modules')
  if (existsSync(projectModules)) {
    const destModules = join(temp, 'node_modules')
    try {
      symlinkSync(projectModules, destModules, process.platform === 'win32' ? 'junction' : 'dir')
    } catch {
      console.log('  ! 无法链接 node_modules，跳过运行时冒烟（静态检查已覆盖导入图）')
    }
  }

  try {
    await import(pathToFileURL(join(temp, main)).href)
    pass(`发布集可正常 import（入口 ${main}）`)
  } catch (error) {
    if (error.code === 'ERR_MODULE_NOT_FOUND' && !String(error.message).includes(temp)) {
      // 缺的是外部依赖，不是本次要验的导入图问题。
      console.log(`  ! 外部依赖未安装（${error.message.split('\n')[0]}），跳过运行时冒烟`)
    } else {
      fail(`发布集 import 失败：${error.code || ''} ${error.message.split('\n')[0]}`)
    }
  }
} finally {
  rmSync(temp, { recursive: true, force: true })
}

// ── 收尾 ───────────────────────────────────────────────────────────────
if (problems.length > 0) {
  console.log(`\n发布包校验未通过，共 ${problems.length} 个问题：`)
  for (const problem of problems) console.log(`  - ${problem}`)
  process.exit(1)
}
console.log('\n发布包校验通过。\n')
