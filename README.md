# dsh-codex

DeepSeek Harness 的 **Codex 桥接插件**：默认保持纯 DeepSeek（V4.1）模式，按会话手动授权后，模型可以在高难度任务上自主调用 OpenAI Codex/GPT 做专业分析或代码构建。

## 登录方式：OpenAI 官方 OAuth（不填 API Key）

点「登录 OpenAI 账号」会打开 `auth.openai.com` 的官方授权页，登录并同意后自动回调本机
`http://localhost:1455/auth/callback` 完成授权。凭证只保存在本机
`$DSH_HOME/dsh-codex-auth.json`，与 Codex CLI 的 `auth.json` 相互独立，不会互相覆盖。

登录后：

- **模型列表**从 `chatgpt.com/backend-api/codex/models` **实时拉取**（当前账号可用的才返回）；
- 推理调用走 `chatgpt.com/backend-api/codex/responses`，消耗的是 **ChatGPT 订阅额度**（侧边栏卡片里的 5 小时 / 每周限额），不是 API 计费。

## 能力

- **会话级授权**：输入框左侧的「Codex」胶囊按钮，点击即授权/撤销**当前会话**。未授权的会话绝不会调用 Codex。
- **自主升级**：已授权会话里，DeepSeek 按任务强度自行决定是否调用 `codex` 工具；普通任务仍由 DeepSeek 完成。可在设置里关掉「自主调用」。
- **专业分析 / 构建两种模式**：`analyze` 用于架构分析、疑难 bug 定位、方案评审、安全审计；`build` 用于直接产出可落地代码与补丁。
- **侧边栏用量卡片**：显示 ChatGPT 订阅的 5 小时限额、每周限额、订阅状态、订阅有效期；拿不到数据时整块不渲染。
- **外网连通性检查**：设置页一键检查 `api.openai.com`、`chatgpt.com`、`auth.openai.com` 三条链路。
- **按会话持久化**：会话授权保存在 `$DSH_HOME/dsh-codex.json`，重启后保留；撤销即时生效。

## 使用

1. 安装本 bundle（本地目录方式）：`plugin_manager` → `install_bundle`，target 指向本目录。
2. 打开 **设置 → Codex** → 点「登录 OpenAI 账号」，在浏览器完成授权；回到 Harness 后模型列表自动出现，选默认模型并保存。
3. 回对话，点输入框左侧 **Codex** 按钮授权当前会话（按钮变蓝）。
4. 遇到高难度任务时，DeepSeek 会自主调用 Codex，并在回答里说明用了哪个模型、耗时多少。

> OAuth 回调固定使用本机 1455 端口（与官方 Codex CLI 相同的 redirect_uri）；若端口被占用会明确提示。

## 配置项（profile 的 `cordis.patch.yml` 里可改）

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `defaultModel` | `gpt-5-codex` | 默认模型（候选从 OpenAI 实时拉取） |
| `autoConsult` | `true` | 允许模型自主按任务强度调用 Codex |
| `allowLanAccess` | `false` | 允许局域网设备读写插件状态（默认仅本机） |

## 实现

| 文件 | 作用 |
| --- | --- |
| `index.js` | Host 插件：`codex` 工具、每会话提示策略段、会话授权、`/dsh-codex-api` 状态路由（含 Origin/Content-Type 守卫） |
| `oauth.js` | OpenAI OAuth：PKCE、1455 回调服务器、换 token、自动续期、凭证存储 |
| `codex.js` | Codex 后端调用层：`codex/responses`（SSE）与 `codex/models`（模型列表） |
| `usage.js` | ChatGPT 订阅用量：`wham/usage`，支持注入插件凭证，也兼容 Codex CLI 的 auth.json |
| `network.js` | 外网连通性检查 |
| `client.js` | 浏览器侧：输入框 Codex 按钮 + 侧边栏用量卡片 + 设置页 |
| `cordis.patch.yml` | 插入主机行 `id: dsh-codex` |
| `test/` | `node --test` 单测（37 条） |

## 安装说明（本地 link 模式）

本包用 `link:` 方式安装到 profile，Node 从包的真实目录解析 import，因此
`@deepseek-ai/schemastery` 及依赖放在包内 `node_modules/`（不随 git 提交）：

```
node_modules/@deepseek-ai/schemastery
node_modules/@deepseek-ai/cosmokit
node_modules/@standard-schema/spec
```

安全边界：状态路由默认只接受本机回环地址，并校验 Origin / `Sec-Fetch-Site` / Host / Content-Type；token 不会通过状态路由回传给浏览器；会话授权不继承给子代理或 fork 出的新会话。
