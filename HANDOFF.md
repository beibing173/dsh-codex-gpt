# HANDOFF — dsh-codex-gpt（双脑）项目现状

> 这份文件是给「换新对话窗口后接手」用的：读完它 + [README.md](./README.md) 就能继续干活。
> 最后更新：2026-10-30，版本 **0.9.0**，提交 **`a3fa856`**。

## 一、这是什么

[DeepSeek Harness (DSH)](https://github.com/deepseek-ai) 的宿主插件，把 **ChatGPT / OpenAI Codex** 接进来，并自带一张**多 AI 用量看板**。

- **包名（下载名）**：`dsh-codex-gpt` —— 不能改，DSH 靠它识别/更新/依赖
- **中文名**：双脑（`package.json` 的 `displayName`，但 DSH 插件页只读包名，所以列表里看不到中文名）
- **仓库**：https://github.com/beibing173/dsh-codex-gpt
- **本地路径**：`C:\Users\17367\Documents\deepseek-harness\default-workspace\dsh-codex-gpt`
- **安装方式**：profile 里是 **Junction 链接**（`~/.dsh/profiles/desktop/node_modules/dsh-codex-gpt` → 本地目录），改代码即生效（宿主侧要禁用→启用重载）

## 二、已经做完并验证过的功能

| 功能 | 状态 | 关键实现 |
|---|---|---|
| ChatGPT 作为 LLM provider（OAuth 登录，走订阅额度） | ✅ | `index.js` + `llm-adapter.js` + `oauth.js` + `codex.js` |
| `codex` 工具（DeepSeek 自主升级 / 手动调用） | ✅ | `index.js`、`codex.js` |
| 会话级授权胶囊（输入框左侧按钮） | ✅ | `client.js`（`CodexToggle`） |
| `deepseek_delegate` 轻任务委派（走 DSH 授权，非裸 API） | ✅ | `index.js` 的 `runDeepSeek`（`ctx.llm.stream`） |
| 侧边栏用量看板（多 AI 切换） | ✅ | `client.js`（`CodexUsageCard`） |
| 看板页顺序：**DeepSeek → ChatGPT → 其它 AI → WorkBuddy → Trae → Qoder** | ✅ | `CONNECT_PLUGINS` 顺序 + `tabs` |
| ChatGPT 限额页（5h/每周/订阅/重置卡） | ✅ | `usage.js`、`codex.js` |
| DeepSeek 余额页（10s 刷新、`—` 而非 0、峰谷倒计时） | ✅ | `deepseek.js`、`index.js` 的 `readDeepseekBalanceCached` |
| Trae / WorkBuddy / Qoder 积分页 | ✅ | `client.js` 的 `parseConnectPoints` + 三个只读端点（`/plugins/<id>/usage`） |
| 「仅看板模式」开关（关掉 GPT 功能） | ✅ | `dashboardOnly` 配置 + 宿主注册处 `if (!dashboardOnly())` |
| 「关闭看板」开关（只藏卡片） | ✅ | `hideDashboard` 配置 + `uiControls` 运行时显隐 |
| 看板开关按钮 + 独立「保存看板设置」 | ✅ | `saveDashboardSwitches`（保存后立即生效，不用重载） |
| 模型选择器只保留 `openai-codex`（旧 id 自动迁移） | ✅ | `index.js` 注册处 + `agentDefaultModel.saveSelection` 迁移 |
| 卡片跟随**当前会话**模型（不是全局默认） | ✅ | `sessionModelStore`（胶囊写入 → 卡片订阅） |

## 三、架构与文件职责

```
index.js        宿主入口：路由 /dsh-codex-api、工具注册、会话策略、适配器注册、看板数据、配置 schema
codex.js        Codex 后端调用（chatgpt.com backend-api）、模型列表、重置卡
usage.js        ChatGPT 用量/订阅解析（5h、weekly、plan）
deepseek.js     DeepSeek 余额 + 峰谷时段（规则见下）
oauth.js        OpenAI OAuth（本地回调 1455）
network.js      连通性检查
llm-adapter.js  LLM 适配器（providerInfo/listModels/resolveModel/stream）
client.js       浏览器侧：胶囊、设置页、侧边栏看板（React，window.__ModuleLoader__.load）
cordis.patch.yml  插件配置默认值
```

## 四、关键规则与坑（踩过的，别重复踩）

1. **峰谷时段**（按[官方定价页](https://api-docs.deepseek.com/quick_start/pricing)，2026-10 核对）
   - 高峰：UTC `01:00–04:00`、`06:00–10:00`，**周一至周五**（北京 `09:00–12:00`、`14:00–18:00`）
   - 空闲（半价）：其余全部，含**周末全天**
   - 法定节假日官方也半价，但没有通用日历 → 我们按工作日算（已知近似）
   - 旧规则「北京 00:30–08:30 空闲」**早已作废**，别改回去
2. **DeepSeek 没有用量/账单 API**：官方只有 `GET /user/balance`；`platform.deepseek.com/api/v0/usage/*` 是网页私有接口，不要依赖
3. **`displayName` DSH 不读**：插件页标题只认 `name`
4. **客户端 `inject` 必须含 `@deepseek-ai/dsh-client-ui-slots`**，否则 `ctx.slots` 拿不到、整个客户端插件加载失败（胶囊和卡片一起消失）
5. **改宿主代码后必须「禁用 → 启用」插件**才重载；改客户端后 **Ctrl+R** 即可
6. **英文界面代码保留但已停用**（`lang` 固定 `zh`），不要在 README 或 UI 里宣传
7. **Windows + PowerShell 的坑**：多行字符串替换会被 CRLF 坑（`\n` 不匹配 `\r\n`），改代码优先用 `edit`/`write` 工具或行级脚本
8. **`node --check` 查不出运行时未定义变量**：改完客户端跑 `node test/card-render.test.mjs`（真实渲染）兜底

## 五、怎么跑测试

```powershell
cd C:\Users\17367\Documents\deepseek-harness\default-workspace\dsh-codex-gpt
node test/adapter.test.mjs
node test/host.test.mjs
# ……逐个跑（node --test 在沙箱里 spawn 会 EPERM）
```

当前 **117 条全绿**：adapter 16 / card-render 9 / client-smoke 6 / codex 13 / connect-points 9 / deepseek 9 / host 36 / oauth 3 / usage 16。

## 六、当前状态

- 版本 **0.9.0**，仓库 `master` 与远程同步（`a3fa856`）
- 工作区干净
- 最近一轮改动：峰谷规则按官方重写；看板开关改成按钮 + 独立保存；积分浮点格式化
- 运行中的宿主：端口随重启变化，可用 `GET /dsh-codex-api?meta=1` 查 `pluginVersion`

## 七、下一个项目（想法，待启动）

**把 DSH 设置页里的 token 统计做成独立插件**：

- 目标：像 ChatGPT/DSH 里 codex 那样的 **token 显示**（输入 / 输出 / cache 命中 / tok/s），单独一个设置页
- 待定问题：
  - 数据从哪来：DSH 会话投影里是否已有 usage（`session` 的 token 统计）？还是每次请求自己记？
  - 是否要跨会话聚合、按模型分桶
  - 与现有看板（余额/积分）的关系：新插件独立，还是复用「双脑」的看板容器
- 参考：DSH session 的 `usage` 字段、`dsh-usage-calendar` 的采样做法
