# dsh-codex

DeepSeek Harness 的 **Codex 桥接插件**：默认保持纯 DeepSeek（V4.1）模式，按会话手动授权后，模型可以在高难度任务上自主调用 OpenAI Codex/GPT 做专业分析或代码构建。

## 能力

- **会话级授权**：输入框左侧的「Codex」胶囊按钮，点击即授权/撤销**当前会话**。未授权的会话绝不会调用 OpenAI（零费用）。
- **自主升级**：已授权会话里，DeepSeek 按任务强度自行决定是否调用 `codex` 工具；普通任务仍由 DeepSeek 完成。可在设置里关掉「自主调用」，改为只在用户明确要求时调用。
- **专业分析 / 构建两种模式**：`analyze` 用于架构分析、疑难 bug 定位、方案评审、安全审计；`build` 用于直接产出可落地代码与补丁。
- **模型可选**：设置页可配置模型列表与默认模型（默认 `gpt-5-codex`，也可用 `gpt-5`、`gpt-5-mini` 等；兼容代理的自定义模型名同样可用）。
- **OpenAI 授权**：填写 API Key（或环境变量 `OPENAI_API_KEY`），支持自定义 Base URL（第三方兼容代理）。
- **侧边栏用量卡片**：读本机 Codex CLI 的登录凭证，显示 ChatGPT 订阅的 **5 小时限额 / 每周限额 / 订阅状态 / 订阅有效期**；拿不到凭证或接口不可达时整块不渲染，不显示假数据。
- **外网连通性检查**：设置页一键检查 `api.openai.com`、`chatgpt.com`、`auth.openai.com` 三条链路（能拿到 HTTP 响应即算可达，401/403 也算）。
- **状态持久化**：会话授权保存在 `$DSH_HOME/dsh-codex.json`，重启后保留；撤销即时生效。

## 使用

1. 安装本 bundle（本地目录方式）：`plugin_manager` → `install_bundle`，target 指向本目录。
2. 打开 **设置 → Codex**，填写 API Key、默认模型，点「保存」；可用「测试连接」「外网连通性检查」验证。
3. 回到对话，点输入框左侧的 **Codex** 按钮授权当前会话（按钮变蓝）。
4. 遇到高难度任务时，DeepSeek 会自主调用 Codex，并在回答里说明用了哪个模型、耗时多少。

> 侧边栏卡片依赖本机 Codex CLI 登录（`~/.codex/auth.json` 或 `$CODEX_HOME/auth.json`）；没登录过 Codex CLI 就没有卡片。
> 卡片里的「订阅有效期」来自登录 token，可能停留在上一个周期；过期会标注「（已结束）」而不是假装有效。

## 配置项（同时可在 profile 的 `cordis.patch.yml` 里改）

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `apiKey` | `''` | OpenAI API Key；留空回退环境变量 `OPENAI_API_KEY` |
| `baseUrl` | `https://api.openai.com/v1` | API 基址，兼容代理可改 |
| `models` | `gpt-5-codex, gpt-5, gpt-5-mini, gpt-4.1, o4-mini` | 可选模型列表 |
| `defaultModel` | `gpt-5-codex` | 默认模型 |
| `autoConsult` | `true` | 允许模型自主按任务强度调用 Codex |
| `maxOutputTokens` | `0` | 单次调用输出上限，0 = 不设置 |
| `allowLanAccess` | `false` | 允许局域网设备读写插件状态 |

## 实现

| 文件 | 作用 |
| --- | --- |
| `index.js` | Host 插件：`codex` 工具、每会话提示策略段 `dsh-codex-policy`、会话授权存储、`/dsh-codex-api` 状态路由 |
| `codex.js` | OpenAI 调用层：Responses API（404/405 自动回退 Chat Completions）、文本提取 |
| `usage.js` | Codex/ChatGPT 订阅用量：读本机凭证、`wham/usage`、401 时刷新并写回 `auth.json` |
| `network.js` | 外网连通性检查（三条链路并行探测） |
| `client.js` | 浏览器侧：输入框 Codex 按钮 + 侧边栏用量卡片 + 设置页 |
| `cordis.patch.yml` | 插入主机行 `id: dsh-codex` |
| `test/` | `node --test` 单测：OpenAI 调用、用量解析、Host 接线与授权门控 |

## 安装说明（本地 link 模式）

本包用 `link:` 方式安装到 profile，Node 会从包的真实目录解析 import，因此
`@deepseek-ai/schemastery` 及其依赖放在包内 `node_modules/`（不随 git 提交）。
若把包目录挪走或清理了 `node_modules`，重新安装前先恢复这三个依赖：

```
node_modules/@deepseek-ai/schemastery
node_modules/@deepseek-ai/cosmokit
node_modules/@standard-schema/spec
```

（`@deepseek-ai/dsh-*` 由 Harness 运行时解析，不需要随包提供。）

安全边界：状态路由默认只接受本机回环地址；API Key 不会通过状态路由回传给浏览器。会话授权不继承给子代理或 fork 出的新会话。
