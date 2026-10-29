# dsh-codex

DeepSeek Harness 的 **Codex 桥接插件**：默认保持纯 DeepSeek（V4.1）模式，按会话手动授权后，模型可以在高难度任务上自主调用 OpenAI Codex/GPT 做专业分析或代码构建。

## 能力

- **会话级授权**：输入框左侧的「Codex」胶囊按钮，点击即授权/撤销**当前会话**。未授权的会话绝不会调用 OpenAI（零费用）。
- **自主升级**：已授权会话里，DeepSeek 按任务强度自行决定是否调用 `codex` 工具；普通任务仍由 DeepSeek 完成。可在设置里关掉「自主调用」，改为只在用户明确要求时调用。
- **专业分析 / 构建两种模式**：`analyze` 用于架构分析、疑难 bug 定位、方案评审、安全审计；`build` 用于直接产出可落地代码与补丁。
- **模型可选**：设置页可配置模型列表与默认模型（默认 `gpt-5-codex`，也可用 `gpt-5`、`gpt-5-mini` 等；兼容代理的自定义模型名同样可用）。
- **OpenAI 授权**：填写 API Key（或环境变量 `OPENAI_API_KEY`），支持自定义 Base URL（第三方兼容代理）。
- **状态持久化**：会话授权保存在 `$DSH_HOME/dsh-codex.json`，重启后保留；撤销即时生效。

## 使用

1. 安装本 bundle：`plugin_manager` → `install_bundle`，target 指向本目录。
2. 打开 **设置 → Codex**，填写 API Key、默认模型，点「保存」，可点「测试连接」验证。
3. 回到对话，点输入框左侧的 **Codex** 按钮授权当前会话（按钮变蓝）。
4. 遇到高难度任务时，DeepSeek 会自主调用 Codex，并在回答里说明用了哪个模型、耗时多少。

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
| `client.js` | 浏览器侧：输入框 Codex 按钮 + 设置页 |
| `cordis.patch.yml` | 插入主机行 `id: dsh-codex` |

安全边界：状态路由默认只接受本机回环地址；API Key 不会通过状态路由回传给浏览器。会话授权不继承给子代理或 fork 出的新会话。
