/**
 * dsh-codex / OpenAI 调用层。
 *
 * 只负责「把一次 Codex 咨询发出去、把文本收回来」，不碰 Harness 状态：
 *   - 首选 Responses API（Codex / GPT-5 系列的原生接口）；
 *   - 代理只实现了 Chat Completions 时，遇到 404/405 自动回退一次；
 *   - 结果文本从多种响应形态里提取，空结果视为失败。
 *
 * 调用方（index.js）负责授权检查、API Key 解析、超时与错误呈现。
 */

/** analyze 模式：只做分析、评审、定位，不改代码。 */
export const ANALYZE_INSTRUCTIONS = [
  '你是 OpenAI Codex 推理模型，作为独立专家为另一个编码 Agent 提供专业分析。',
  '目标：给出可验证、可执行的判断，而不是泛泛而谈。',
  '要求：',
  '1. 先复述你理解的问题与关键约束（简短），再给结论。',
  '2. 结论必须落到具体文件/函数/行为/命令上；缺少信息时明确列出需要补充什么。',
  '3. 涉及代码时给出最小充分片段与修改位置，说明为什么这样改。',
  '4. 指出风险、边界条件与验证方法。',
  '5. 不要写与任务无关的客套话；不要声称你执行了未实际执行的操作。',
].join('\n')

/** build 模式：直接产出可落地的代码与补丁。 */
export const BUILD_INSTRUCTIONS = [
  '你是 OpenAI Codex 编码模型，为另一个编码 Agent 产出可直接落地的实现方案。',
  '要求：',
  '1. 先给实现要点（数据结构、接口、控制流），再给完整代码或精确补丁。',
  '2. 代码按目标项目现有风格书写；标注每个片段应放入的文件路径。',
  '3. 列出需要新增/修改的依赖与命令，并给出验证步骤。',
  '4. 显式说明不确定之处与假设，不要编造不存在的 API。',
  '5. 输出使用 Markdown，代码块标注语言。',
].join('\n')

/** 组装用户输入：任务 + 可选上下文，上下文放后面避免淹没任务。 */
export function composeUserInput(task, context) {
  const head = String(task ?? '').trim()
  const tail = String(context ?? '').trim()
  if (!tail) return head
  return `${head}\n\n---\n\n附加上下文：\n${tail}`
}

/** Responses API 的文本提取。 */
export function extractResponsesText(json) {
  if (!json || typeof json !== 'object') return ''
  if (typeof json.output_text === 'string' && json.output_text.trim()) {
    return json.output_text.trim()
  }
  const chunks = []
  if (Array.isArray(json.output)) {
    for (const item of json.output) {
      if (!item || typeof item !== 'object') {
        if (typeof item === 'string') chunks.push(item)
        continue
      }
      // reasoning 项不是答案，跳过。
      if (item.type === 'reasoning') continue
      if (typeof item.text === 'string' && item.type !== 'reasoning') {
        chunks.push(item.text)
        continue
      }
      if (!Array.isArray(item.content)) continue
      for (const part of item.content) {
        if (!part) continue
        if (typeof part === 'string') {
          chunks.push(part)
          continue
        }
        if (part.type === 'reasoning_text') continue
        if (typeof part.text === 'string') chunks.push(part.text)
      }
    }
  }
  return chunks.join('\n\n').trim()
}

/** Chat Completions 的文本提取（兼容代理）。 */
export function extractChatText(json) {
  if (!json || typeof json !== 'object') return ''
  const choice = Array.isArray(json.choices) ? json.choices[0] : undefined
  const content = choice && choice.message ? choice.message.content : undefined
  if (typeof content === 'string') return content.trim()
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === 'string' ? part : typeof part?.text === 'string' ? part.text : ''))
      .join('')
      .trim()
  }
  return ''
}

/**
 * 发一次 JSON POST，非 2xx 抛错（错误对象带 status，供回退判断）。
 * @param {string} url 完整 URL。
 * @param {object} body 请求体。
 * @param {string} apiKey Bearer key。
 * @param {AbortSignal | undefined} signal 取消/超时信号。
 * @returns {Promise<object>} 解析后的 JSON。
 */
async function postJson(url, body, apiKey, signal) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(body),
    signal,
  })
  const raw = await response.text()
  let json
  try {
    json = raw ? JSON.parse(raw) : undefined
  } catch {
    json = undefined
  }
  if (!response.ok) {
    const detail =
      (json && json.error && (json.error.message || json.error.code)) ||
      (raw ? raw.slice(0, 800) : '') ||
      response.statusText ||
      'unknown error'
    const error = new Error(`OpenAI HTTP ${response.status}: ${detail}`)
    error.status = response.status
    throw error
  }
  if (!json || typeof json !== 'object') {
    throw new Error('OpenAI 返回了无法解析的响应体')
  }
  return json
}

/**
 * 调用 Codex / GPT。
 * @param {object} options
 * @param {string} options.apiKey OpenAI API Key。
 * @param {string} options.baseUrl API 基址（可带或不带结尾斜杠）。
 * @param {string} options.model 模型名。
 * @param {'analyze' | 'build'} options.mode 任务模式。
 * @param {string} options.task 任务正文。
 * @param {string} [options.context] 附加上下文。
 * @param {number} [options.maxOutputTokens] 输出上限（0/undefined = 不设置）。
 * @param {AbortSignal} [options.signal] 取消/超时信号。
 * @returns {Promise<{ text: string, model: string, endpoint: string }>}
 */
export async function callCodex(options) {
  const {
    apiKey,
    baseUrl,
    model,
    mode,
    task,
    context,
    maxOutputTokens = 0,
    signal,
  } = options
  const base = String(baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '')
  const instructions = mode === 'build' ? BUILD_INSTRUCTIONS : ANALYZE_INSTRUCTIONS
  const userText = composeUserInput(task, context)

  const responsesBody = {
    model,
    instructions,
    input: [
      {
        role: 'user',
        content: [{ type: 'input_text', text: userText }],
      },
    ],
  }
  if (maxOutputTokens > 0) responsesBody.max_output_tokens = maxOutputTokens

  try {
    const json = await postJson(`${base}/responses`, responsesBody, apiKey, signal)
    const text = extractResponsesText(json)
    if (!text) throw new Error('OpenAI 返回为空（Responses API 未找到输出文本）')
    return { text, model, endpoint: 'responses' }
  } catch (error) {
    // 只对「接口不存在」回退；鉴权、限流、模型错等原样抛出。
    if (!error || (error.status !== 404 && error.status !== 405)) throw error
    const chatBody = {
      model,
      messages: [
        { role: 'system', content: instructions },
        { role: 'user', content: userText },
      ],
    }
    if (maxOutputTokens > 0) chatBody.max_tokens = maxOutputTokens
    const json = await postJson(`${base}/chat/completions`, chatBody, apiKey, signal)
    const text = extractChatText(json)
    if (!text) throw new Error('OpenAI 返回为空（Chat Completions 未找到输出文本）')
    return { text, model, endpoint: 'chat/completions' }
  }
}
