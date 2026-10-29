# 发布流程

本仓库的 CI 与 Release 都由 GitHub Actions 托管，**打 tag 即发布**。

## 日常

| 动作 | 结果 |
|---|---|
| 推到 `master` / 开 PR | 跑 `CI`（Linux + Windows 双平台：测试 + 发布包完整性校验） |
| 手动触发 `CI` | 同上，用于排查环境差异 |
| 推 `v*` tag | 先跑 `CI`，全绿后自动创建 GitHub Release |

## 发一个版本

```bash
# 1. 改 package.json 的 version
# 2. 提交
git add package.json
git commit -m "chore: 版本升级至 X.Y.Z"
git push origin master

# 3. 打 tag 并推送 —— 这一步触发 Release
git tag -a vX.Y.Z -m "vX.Y.Z: <一句话说明>"
git push origin vX.Y.Z
```

工作流会校验 **tag 与 `package.json` 版本一致**；不一致直接失败，避免用户看到 v0.9.2 却装到 0.9.1 的代码。

## Release 里有什么

只有 GitHub 自动附带的 **Source code (zip)** 与 **Source code (tar.gz)**。

本插件不做构建、经源码分发，因此工作流**不产出任何构建附件**——不塞 `.tgz`、不塞 `dist/`。想要打包产物请用 `npm pack` 自己打。

## 发布包完整性校验（`npm run verify:pack`）

CI 里除了跑测试，还有一道 `scripts/verify-pack.mjs` 闸门。它存在的理由是：

本插件不做构建，发布包就是**源码本身**，`package.json` 的 `files` 白名单是唯一防线。而 `npm pack` **只按白名单拷文件，从不检查导入图**——白名单漏掉一个被 `import './x.js'` 引用的模块时，打包照样成功、退出码照样 0，缺陷要到用户机器上才以 `ERR_MODULE_NOT_FOUND` 爆出来。

脚本做三件事：

1. `files` 里每个条目确实存在于磁盘（防拼错、防删文件后忘改白名单）
2. 已发布模块的相对导入目标也必须在发布集内（**导入图封闭性**，这一步才抓得到漏文件）
3. 把发布集真的拷到临时目录、import 一次入口（运行时冒烟）

任一步失败即非零退出，CI 红灯。手动跑：

```bash
npm run verify:pack
```

> 这道闸门不是纸上谈兵：本仓库的 `deepseek.js` 曾经被 `index.js` 引用却不在 `files` 白名单里，`npm pack` 一直"成功"，装到用户机器上才炸。抓出它的正是第 2 步。

## 已知坑

- **默认分支是 `master`，不是 `main`**。工作流的 `push.branches` 写的是 `master`，改成别的就等于 CI 不触发。
- **不提交 lockfile**，所以 CI 里用 `npm install --no-package-lock`，不能用 `--frozen-lockfile`。
- **唯一运行时依赖是 `@deepseek-ai/schemastery`**（公共 npm 可得）。`test/host.test.mjs` 会在沙箱里放一个替身桩，因此那份测试不依赖真实 Harness 包。
- 改 `.github/workflows/*.yml` 后先确认 YAML 没写坏；语法错的 workflow 不会报错，只会**静默不运行**。
