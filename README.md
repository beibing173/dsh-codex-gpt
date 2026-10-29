# dsh-codex-gpt

把 **ChatGPT / OpenAI Codex** 接入 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai) 的插件：既能在模型选择器里把 **ChatGPT 当作一个 LLM provider 直接对话**，也能让 DeepSeek 在会话内按需把难任务**转交给 GPT 做独立分析或代码构建**。

全程使用 **ChatGPT 订阅额度**，走 OpenAI 官方 OAuth 登录，不需要填写 API Key，不产生 OpenAI API 计费。

![设置页：OpenAI 账号、ChatGPT 设置、轻任务委派开关与重置卡](assets/screenshot-1.webp)

---

## 特性

### 1. ChatGPT 作为 LLM provider（直接对话）

- 模型选择器新增 **「ChatGPT」** provider（内部 id `chatgpt-codex`），选中后整个对话由 GPT 处理：完整上下文、流式输出、工具调用。
- 模型列表**实时**从账号可用模型拉取（`gpt-6.1-sol`、`gpt-6-astra`、`gpt-5.6-sol` …），不写死。
- 支持**思考强度**：`Off / Low / High / Max`，默认 `High`，内部映射到 Codex 的 `reasoning.effort`（`Max → xhigh`，`Off → 不发送 reasoning`）。
- 支持**图片输入**：贴图直接发给 GPT（经 `ctx.attachments.readImage` 读取并编码为 `input_image`）。
- 模型列表带 5 分钟缓存，并对 HTTP 429 限流自动回退，不会污染界面。
- **GPT 模式轻任务委派（独立开关）**：开启后，ChatGPT 处理会话时会把格式化、整理、检索归纳、润色等轻任务交给 **DeepSeek V4.1** 完成并收尾，复杂任务仍由 GPT 直接处理；随时可关。

### 2. `codex` 工具（DeepSeek 自主升级）

- **会话级授权**：输入框左侧的胶囊按钮控制当前会话（显示名随当前模型变化：本插件 ChatGPT 时显示「DeepSeek」，其余显示「ChatGPT」）；未授权会话绝不会调用 OpenAI。
- 已授权会话中，DeepSeek 按任务强度决定是否调用 `codex` 工具；可在设置里关闭「自主调用」。
- 两种模式：`analyze`（架构分析、疑难 bug 定位、方案评审、安全审计）与 `build`（直接产出可落地代码/补丁）。

### 3. 用量与订阅

- 侧边栏卡片显示 ChatGPT 订阅的 **5 小时限额 / 每周限额 / 订阅状态 / 到期时间**。
- 显示**可用的重置卡**（rate-limit reset credits），并支持在设置页**消费最早过期的一张**（二次确认，不可逆）。

### 4. 诊断

- 设置页一键检查 `api.openai.com`、`chatgpt.com`、`auth.openai.com` 三条链路。
- `/dsh-codex-api` 状态路由暴露登录态、provider 注册状态与模型目录诊断信息。

---

## 安装

DSH 中通过 **插件管理** 以本地 bundle 方式安装：

1. 打开「插件 → 插件管理」；
2. `install_bundle`，target 指向本目录（或发布后的包名 `dsh-codex-gpt`）；
3. 安装后 bundle 条目 id 为 `dsh-codex-gpt`。

> 本包以 `link:` 方式安装到 profile 时，Node 从包的真实目录解析依赖，因此
> `node_modules/`（含 `@deepseek-ai/schemastery` 等）需要随包本地存在，但**不提交到 git**。

---

## 登录

1. 打开 **设置 → ChatGPT** → 点「登录 OpenAI 账号」；
2. 浏览器跳转 `auth.openai.com` 官方授权页，登录并同意；
3. 回调本机 `http://localhost:1455/auth/callback` 完成授权（端口占用会明确提示）。

凭证仅保存在本机 `$DSH_HOME/dsh-codex-auth.json`，与 Codex CLI 的 `auth.json` 相互独立。

---

## 使用

### 方式 A：直接和 ChatGPT 对话

1. 完成登录；
2. 点输入框的模型选择器，选 **ChatGPT** 分组下的任意模型；
3. 可在同一菜单里调整**推理等级**（Off / Low / High / Max）；
4. 正常对话即可，支持贴图。

### 方式 B：让 DeepSeek 自主调用 Codex

1. 模型保持在 DeepSeek（V4.1）；
2. 点输入框左侧胶囊按钮授权当前会话；
3. 遇到高难度任务时 DeepSeek 会调用 `codex` 工具，并在回答中说明所用模型与耗时。

---

## 配置

以下字段可在 profile 的 `cordis.patch.yml` 中修改：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `defaultModel` | `gpt-5-codex` | 默认模型（候选从 OpenAI 实时拉取） |
| `autoConsult` | `true` | 允许模型自主按任务强度调用 `codex` 工具 |
| `allowLanAccess` | `false` | 允许局域网设备**只读**查看插件状态（写操作始终仅限本机） |
| `delegateLightTasks` | `false` | GPT 模式下允许把轻任务交给 DeepSeek V4.1 收尾（独立开关，可随时关闭） |
| `gptNameDetect` | `false` | 保险开关：开启后其他 provider 的模型名形如 `gpt-*` / `o3-*` 也按 GPT 识别（影响胶囊显示名） |
| `deepseekModel` | 空 | 轻任务委派使用的 DeepSeek 模型 id；留空自动选择当前可用模型 |

持久化数据：

| 路径 | 内容 |
| --- | --- |
| `$DSH_HOME/dsh-codex-auth.json` | OAuth 凭证（access/refresh token、账号信息） |
| `$DSH_HOME/dsh-codex.json` | 按会话的授权状态与模型选择 |

---

## 架构

| 文件 | 作用 |
| --- | --- |
| `index.js` | Host 插件入口：`codex` 工具、会话授权、系统提示策略段、LLM 适配器注册、设置页 provider 目录、`/dsh-codex-api` 路由 |
| `llm-adapter.js` | DSH `LlmAdapter` 适配器：模型目录、思考强度、图片输入、SSE → `StreamChunk` 转换 |
| `codex.js` | Codex 后端调用层：`codex/responses`（SSE）、`codex/models`、重置卡查询/消费 |
| `oauth.js` | OpenAI OAuth：PKCE、1455 回调服务器、token 交换/续期、凭证存储 |
| `usage.js` | ChatGPT 订阅用量（`wham/usage`），插件凭证优先、兼容 Codex CLI |
| `network.js` | 外网连通性检查 |
| `client.js` | 浏览器侧：输入框授权胶囊、侧边栏用量卡片、设置页 |
| `cordis.patch.yml` | 插入主机行 `id: dsh-codex-gpt` |
| `test/` | `node --test` 单测（63 条，含安全回归） |

数据流（方式 A）：

```
DSH Agent Loop
  └─ llm.prepareCall → chatgpt-codex 适配器
       └─ POST chatgpt.com/backend-api/codex/responses (SSE)
            └─ StreamChunk: text / reasoning / tool-call / usage / finish
```

---

## 开发

```bash
npm install          # 或使用本地 vendored node_modules
node --test "test/codex.test.mjs" "test/usage.test.mjs" "test/host.test.mjs" "test/adapter.test.mjs"
```

测试全部使用 `node:test` + mock 网络，不需要真实 OpenAI 凭证。

---

## 安全边界

- 状态路由 `/dsh-codex-api` 默认**仅接受本机回环地址**，并校验 `Origin`、`Sec-Fetch-Site`、`Host` 与 `Content-Type: application/json`；
- `Host` 校验不依赖 `getOrigin()` 是否可用：即使端口来源信息缺失，非回环 Host 也会被拒绝（防 DNS rebinding）；
- `allowLanAccess: true` 时局域网设备**只能只读查询**；登录、登出、兑换重置卡等写操作必须在运行 DSH 的本机执行；
- OAuth 回调页回显的 URL 参数（如 `error`）全部做 HTML 转义，防止反射型 XSS；
- 凭证文件以 `0600` 权限写入（POSIX 系统），token **不会**通过状态路由回传给浏览器；
- 插件只读 Codex CLI 的 `auth.json`，**不替其他应用刷新或轮换**其 token；
- 局域网模式下的只读数据已脱敏（不返回邮箱、姓名、订阅起止、用量、模型与重置卡）；
- 会话授权**不继承**给子代理（subagent）或 fork 出的新会话；
- 未登录 / 未授权时不会发起任何 OpenAI 请求。

---

## 已知限制

- 依赖 ChatGPT 后端的若干**非公开接口**（`codex/responses`、`codex/models`、`wham/usage`、`wham/rate-limit-reset-credits`），OpenAI 调整协议时可能需要适配；
- `codex` 工具与模型列表均受账号订阅额度约束，额度用尽需等待重置周期或使用重置卡；
- OAuth 回调固定占用本机 `1455` 端口。

---

## 免责声明

本项目为第三方社区插件，与 OpenAI 及 DeepSeek 官方无隶属关系。使用 ChatGPT 订阅额度调用后端接口可能受服务条款约束，请自行评估合规性与风险。

---

## License

MIT
