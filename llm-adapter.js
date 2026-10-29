/**
 * dsh-codex-gpt / DSH LLM 适配器（由 Codex 生成，本鱼接入与修正）。
 *
 * 把 ChatGPT Codex 后端接成 DSH 的一个 LLM provider，模型选择器里会出现
 * 「ChatGPT (Codex)」分组，选中后对话直接走 GPT（读上下文、流式回复、支持工具调用）。
 *
 * 协议：POST https://chatgpt.com/backend-api/codex/responses（SSE），
 * headers 需要 OAuth Bearer + originator: codex_cli_rs。
 */
export const PROVIDER_ID = 'openai-codex'
/**
 * 历史 provider id：0.2.x 早期版本用 `chatgpt-codex` 注册过。
 * 老会话里保存的模型选择仍是这个 id，适配器两个都认——改成规范 id 后，
 * 旧会话的选择依然可路由，不需要用户重新选一次模型。
 */
export const LEGACY_PROVIDER_IDS = ['chatgpt-codex']
const PROVIDER_NAME = 'ChatGPT'
/** 「自动选择」：由适配器按请求规模/工具量/思考强度挑具体模型。 */
export const AUTO_MODEL_ID = 'auto'
/** 思考强度档位：与 DSH 官方（DeepSeek）一致的 Off / Low / High / Max。 */
export const REASONING_EFFORTS = [
  { id: 'off', name: 'Off', description: '不进行思考' },
  { id: 'low', name: 'Low', description: '更快，思考更少' },
  { id: 'high', name: 'High', description: '更深入的推理（默认）' },
  { id: 'max', name: 'Max', description: '最深入的推理，最慢' },
]
const DEFAULT_REASONING_EFFORT = 'high'
/** DSH 档位 → Codex 后端 reasoning.effort。off 不传 reasoning。 */
const EFFORT_TO_CODEX = { low: 'low', high: 'high', max: 'xhigh' }
const RESPONSES_URL = 'https://chatgpt.com/backend-api/codex/responses'
const DEFAULT_CONTEXT_WINDOW = 272000
const DEFAULT_MAX_TOKENS = 64000

/**
 * 创建 ChatGPT Codex 的 DSH LLM 适配器。
 *
 * @param {{
 *   getCredential: () => Promise<{accessToken: string, accountId?: string} | undefined>,
 *   fetchModels: (credential: {accessToken: string, accountId?: string}) => Promise<Array<{slug: string, displayName?: string, contextWindow?: number}>>,
 *   fallbackModel?: string,
 *   now?: () => number
 * }} opts
 */
export function createCodexGptAdapter(opts) {
  if (!opts || typeof opts.getCredential !== 'function') {
    throw new TypeError('createCodexGptAdapter: opts.getCredential 必须是函数')
  }
  if (typeof opts.fetchModels !== 'function') {
    throw new TypeError('createCodexGptAdapter: opts.fetchModels 必须是函数')
  }

  const getCredential = opts.getCredential
  const fetchModels = opts.fetchModels
  const readImage = typeof opts.readImage === 'function' ? opts.readImage : undefined
  /** 目录拿不到时的兜底模型：保证 provider 永远至少有一个可路由模型。 */
  const fallbackModel = typeof opts.fallbackModel === 'string' && opts.fallbackModel ? opts.fallbackModel : ''
  const now = typeof opts.now === 'function' ? opts.now : Date.now
  /** 模型目录缓存：DSH 会频繁刷新模型列表，缓存 5 分钟并容忍 429。 */
  const MODELS_TTL_MS = 5 * 60 * 1000
  /** 冷启动最长等待：超过就直接给上一份目录，后台继续拉，绝不卡住模型选择器。 */
  const MODELS_COLD_WAIT_MS = 1200
  /** 目录持久化：进程重启后先拿上次的目录，避免「模型先消失、要手动重选」。 */
  const modelsStore = opts.modelsCache && typeof opts.modelsCache === 'object' ? opts.modelsCache : null
  let modelsCache = { at: 0, models: [] }
  /** 上次成功目录的落盘副本：只用于启动时预热，读取失败就当没有。 */
  if (modelsStore && typeof modelsStore.load === 'function') {
    try {
      const stored = normalizeModels(modelsStore.load())
      if (stored.length > 0) modelsCache = { at: 0, models: stored }
    } catch {
      // 缓存文件坏了不影响启动
    }
  }
  /** 目录刷新单飞：并发刷新只打一次上游。 */
  let modelsInflight = null

  /** 把兜底模型并进目录：用户选中的模型不能因为一次刷新就「消失」。 */
  function withFallbackModel(models) {
    const list = Array.isArray(models) ? models : []
    if (!fallbackModel) return list
    if (list.some((model) => model.slug === fallbackModel)) return list
    return [...list, { slug: fallbackModel, displayName: fallbackModel, contextWindow: DEFAULT_CONTEXT_WINDOW }]
  }

  /** 后台刷新模型目录（单飞、静默失败；成功后写盘供下次启动预热）。 */
  function refreshModels(credential) {
    if (modelsInflight) return modelsInflight
    modelsInflight = (async () => {
      try {
        const models = normalizeModels(await fetchModels(credential))
        // 上游偶尔会返回比上次更短的列表（账号模型轮换），这里只接受"包含新内容"
        // 或"确实变了"的结果，但绝不把用户正用着的兜底模型弄丢。
        if (models.length > 0) {
          modelsCache = { at: now(), models }
          if (modelsStore && typeof modelsStore.save === 'function') {
            try {
              modelsStore.save(models)
            } catch {
              // 写盘失败不影响本次目录
            }
          }
        }
        return modelsCache.models
      } catch {
        // 限流/网络错误时退回旧缓存，绝不把 429 抛成 UI 红字。
        return modelsCache.models
      } finally {
        modelsInflight = null
      }
    })()
    return modelsInflight
  }

  async function loadModels(credential) {
    if (modelsCache.models.length > 0 && now() - modelsCache.at < MODELS_TTL_MS) {
      return modelsCache.models
    }
    return refreshModels(credential)
  }

  // 插件激活后预热一次目录：第一次打开模型选择器就不用等网络。
  if (opts.preload === true) {
    const timer = setTimeout(() => {
      Promise.resolve()
        .then(() => getCredential({ noRefresh: true }))
        .then((credential) => (credential && credential.accessToken ? refreshModels(credential) : null))
        .catch(() => {})
    }, 1500)
    if (timer && typeof timer.unref === 'function') timer.unref()
  }

  /** DSH 会把注册时的路由 id 传进来；返回它的规范 id（旧别名原样返回，保证 id === provider）。 */
  function providerInfo(provider) {
    const requested = requestedProviderId(provider)
    const id = requested || PROVIDER_ID
    // 旧 id 单独起个名字，免得模型选择器里出现两个一模一样的「ChatGPT」分组。
    return { id, name: LEGACY_PROVIDER_IDS.includes(id) ? `${PROVIDER_NAME}（旧 id）` : PROVIDER_NAME }
  }

  /** LlmModelInfo 只允许 provider/id/name/description/inputModalities。 */
  function toModelInfos(models, provider) {
    const owner = requestedProviderId(provider) || PROVIDER_ID
    return models.map((model) => ({
      provider: owner,
      id: model.slug,
      name: model.displayName || model.slug,
      inputModalities: ['text', 'image'],
    }))
  }

  async function listModels(provider) {
    assertProvider(provider)
    const cached = modelsCache.models
    const fresh = cached.length > 0 && now() - modelsCache.at < MODELS_TTL_MS

    // 列模型绝不能让 UI 等网络：凭证只要旧的就够，禁止在这里触发 token 刷新。
    let credential
    try {
      credential = await getCredential({ noRefresh: true })
    } catch {
      credential = undefined
    }
    const hasCredential = Boolean(credential && credential.accessToken)

    // 有目录就立刻返回；过期则后台续期（stale-while-revalidate）。
    // 关键：返回的目录永远包含兜底/已配置模型，刷新失败也不会让用户选中的模型"消失"。
    if (cached.length > 0) {
      if (!fresh && hasCredential) void refreshModels(credential)
      return toModelInfos(withFallbackModel(cached), provider)
    }
    if (!hasCredential) return toModelInfos(fallbackModels(), provider)

    // 冷启动：最多等 MODELS_COLD_WAIT_MS，超时先给兜底，刷新继续在后台跑。
    const raced = await Promise.race([
      refreshModels(credential),
      new Promise((resolve) => {
        setTimeout(() => resolve(null), MODELS_COLD_WAIT_MS)
      }),
    ])
    const models = raced && raced.length > 0 ? raced : fallbackModels()
    return toModelInfos(withFallbackModel(models), provider)
  }

  /** 上游目录不可用时的兜底清单（至少一个，保证 provider 可路由）。 */
  function fallbackModels() {
    const list = []
    if (fallbackModel) {
      list.push({ slug: fallbackModel, displayName: fallbackModel, contextWindow: DEFAULT_CONTEXT_WINDOW })
    } else {
      list.push({ slug: AUTO_MODEL_ID, displayName: '自动选择', contextWindow: DEFAULT_CONTEXT_WINDOW })
    }
    return list
  }

  async function resolveModel(provider, model, signal) {
    assertProvider(provider)
    throwIfAborted(signal)

    const modelId =
      typeof model === 'string' ? model : typeof model?.id === 'string' ? model.id : String(model || '')
    if (!modelId) throw new Error('未指定 Codex 模型')

    if (modelId === AUTO_MODEL_ID) {
      return {
        provider: requestedProviderId(provider) || PROVIDER_ID,
        id: AUTO_MODEL_ID,
        name: '自动选择',
        context: { contextWindow: DEFAULT_CONTEXT_WINDOW },
        defaultMaxTokens: DEFAULT_MAX_TOKENS,
        reasoning: { efforts: REASONING_EFFORTS.map((effort) => ({ ...effort })), defaultEffort: DEFAULT_REASONING_EFFORT },
        inputModalities: ['text', 'image'],
      }
    }

    let found
    try {
      // 用缓存的目录解析：选中模型后 DSH 会立刻解析一次，这里绝不能再等网络，
      // 否则切换模型时会出现明显卡顿/显示不刷新。
      const credential = await getCredential({ noRefresh: true })
      throwIfAborted(signal)
      if (credential?.accessToken) {
        const models = normalizeModels(await loadModels(credential))
        throwIfAborted(signal)
        found = models.find((candidate) => candidate.slug === modelId)
      }
    } catch (error) {
      // 取消必须继续冒泡，否则被取消的请求仍会返回模型信息并继续发送。
      if (isAbortError(error, signal)) throw error
      found = undefined
    }

    return {
      provider: requestedProviderId(provider) || PROVIDER_ID,
      id: modelId,
      name: found?.displayName || modelId,
      context: { contextWindow: found?.contextWindow || DEFAULT_CONTEXT_WINDOW },
      defaultMaxTokens: DEFAULT_MAX_TOKENS,
      reasoning: { efforts: REASONING_EFFORTS.map((effort) => ({ ...effort })), defaultEffort: DEFAULT_REASONING_EFFORT },
      inputModalities: ['text', 'image'],
    }
  }

  async function prepareCall(provider, model, signal) {
    const resolvedModel = await resolveModel(provider, model, signal)
    return { model: resolvedModel, stream }
  }

  /** DSH 要求 stream 返回 AsyncIterable；用异步生成器直接产出增量。 */
  async function* stream(options) {
    const signal = options?.signal

    if (signal?.aborted) {
      yield abortedFinish()
      return
    }

    let response
    try {
      response = await requestWith401Retry(options, signal)
    } catch (error) {
      if (isAbortError(error, signal)) {
        yield abortedFinish()
        return
      }
      yield errorFinish(error)
      return
    }

    if (signal?.aborted) {
      await cancelBody(response)
      yield abortedFinish()
      return
    }

    if (!response.ok) {
      const failure = await readHttpFailure(response)
      yield { type: 'finish', reason: { kind: 'error', failure } }
      return
    }

    if (!response.body) {
      yield {
        type: 'finish',
        reason: {
          kind: 'error',
          failure: { message: 'Codex 响应没有可读取的 SSE body', code: 'EMPTY_RESPONSE_BODY' },
        },
      }
      return
    }

    let nextBlockIndex = 0
    let textBlock
    let reasoningBlock
    const toolBlocks = []
    const toolAliases = new Map()
    let emittedToolCall = false
    let finished = false
    let lastUsageSignature

    const allocateBlock = (blockType) => ({
      index: nextBlockIndex++,
      blockType,
      text: '',
      started: false,
      ended: false,
    })

    const startTextBlock = () => {
      if (!textBlock || textBlock.ended) textBlock = allocateBlock('text')
      if (!textBlock.started) {
        textBlock.started = true
        return { type: 'block-start', index: textBlock.index, blockType: 'text' }
      }
      return undefined
    }

    const startReasoningBlock = () => {
      if (!reasoningBlock || reasoningBlock.ended) reasoningBlock = allocateBlock('reasoning')
      if (!reasoningBlock.started) {
        reasoningBlock.started = true
        return { type: 'block-start', index: reasoningBlock.index, blockType: 'reasoning' }
      }
      return undefined
    }

    const registerToolAliases = (block, aliases) => {
      for (const alias of aliases) {
        if (alias !== undefined && alias !== null && alias !== '') {
          toolAliases.set(String(alias), block)
        }
      }
    }

    const updateToolMetadata = (block, event, item) => {
      const id = item?.call_id || event?.call_id || item?.id
      const name = item?.name || event?.name
      if (id && !block.started) block.id = String(id)
      if (name) block.name = String(name)
    }

    const findOrCreateToolBlock = (event, item) => {
      const aliases = collectToolAliases(event, item)
      for (const alias of aliases) {
        const existing = toolAliases.get(alias)
        if (existing) {
          updateToolMetadata(existing, event, item)
          registerToolAliases(existing, aliases)
          return existing
        }
      }
      const block = {
        index: nextBlockIndex++,
        blockType: 'tool-call',
        started: false,
        ended: false,
        id: item?.call_id || event?.call_id || item?.id || event?.item_id || `call_${now()}_${toolBlocks.length}`,
        name: item?.name || event?.name || '',
        argumentsText: '',
      }
      toolBlocks.push(block)
      updateToolMetadata(block, event, item)
      registerToolAliases(block, aliases)
      registerToolAliases(block, [block.id])
      return block
    }

    const startToolBlock = (block) => {
      if (block.started) return undefined
      block.started = true
      emittedToolCall = true
      return { type: 'block-start', index: block.index, blockType: 'tool-call' }
    }

    const closeTextBlock = () => {
      if (!textBlock?.started || textBlock.ended) return undefined
      textBlock.ended = true
      return { type: 'block-end', index: textBlock.index, block: { type: 'text', text: textBlock.text } }
    }

    const closeReasoningBlock = () => {
      if (!reasoningBlock?.started || reasoningBlock.ended) return undefined
      reasoningBlock.ended = true
      return {
        type: 'block-end',
        index: reasoningBlock.index,
        block: { type: 'reasoning', text: reasoningBlock.text },
      }
    }

    const closeToolBlock = (block, item) => {
      if (block.ended) return []
      updateToolMetadata(block, undefined, item)
      const finalArguments = typeof item?.arguments === 'string' ? item.arguments : block.argumentsText
      if (finalArguments && finalArguments !== block.argumentsText && block.argumentsText.length === 0) {
        block.argumentsText = finalArguments
      }
      const chunks = []
      const start = startToolBlock(block)
      if (start) chunks.push(start)
      block.ended = true
      emittedToolCall = true
      chunks.push({
        type: 'block-end',
        index: block.index,
        block: {
          type: 'tool-call',
          id: block.id,
          name: block.name,
          // DSH 契约：tool-call 的 arguments 必须是原始 JSON 字符串，不能是已解析对象。
          arguments: block.argumentsText && block.argumentsText.trim() ? block.argumentsText : '{}',
        },
      })
      return chunks
    }

    const emitUsage = (source) => {
      const usage = normalizeUsage(source)
      if (!usage) return undefined
      const signature = `${usage.inputTokens}:${usage.outputTokens}:${usage.totalTokens ?? ''}`
      if (signature === lastUsageSignature) return undefined
      lastUsageSignature = signature
      return { type: 'usage', usage }
    }

    try {
      for await (const event of parseSse(response.body, signal)) {
        if (signal?.aborted) {
          yield abortedFinish()
          finished = true
          return
        }
        const type = event?.type

        if (type === 'response.output_text.delta' || type === 'response.content_part.delta') {
          const delta =
            typeof event.delta === 'string'
              ? event.delta
              : typeof event.delta?.text === 'string'
                ? event.delta.text
                : ''
          if (!delta) continue
          const start = startTextBlock()
          if (start) yield start
          textBlock.text += delta
          yield { type: 'text-delta', index: textBlock.index, text: delta }
          continue
        }

        if (
          type === 'response.reasoning_text.delta' ||
          type === 'response.reasoning_summary_text.delta' ||
          type === 'response.reasoning.delta'
        ) {
          const delta =
            typeof event.delta === 'string'
              ? event.delta
              : typeof event.delta?.text === 'string'
                ? event.delta.text
                : ''
          if (!delta) continue
          const start = startReasoningBlock()
          if (start) yield start
          reasoningBlock.text += delta
          yield { type: 'reasoning-delta', index: reasoningBlock.index, text: delta }
          continue
        }

        if (type === 'response.output_item.added') {
          const item = event.item
          if (item?.type === 'function_call') findOrCreateToolBlock(event, item)
          continue
        }

        if (type === 'response.function_call_arguments.delta') {
          const block = findOrCreateToolBlock(event)
          const delta =
            typeof event.delta === 'string'
              ? event.delta
              : typeof event.arguments_delta === 'string'
                ? event.arguments_delta
                : ''
          const start = startToolBlock(block)
          if (start) yield start
          if (delta) {
            block.argumentsText += delta
            yield {
              type: 'tool-call-delta',
              index: block.index,
              id: block.id,
              ...(block.name ? { name: block.name } : {}),
              argumentsDelta: delta,
            }
          }
          continue
        }

        if (type === 'response.output_item.done') {
          const item = event.item
          if (item?.type === 'function_call') {
            const block = findOrCreateToolBlock(event, item)
            for (const chunk of closeToolBlock(block, item)) yield chunk
            continue
          }
          if (item?.type === 'message') {
            const text = extractOutputText(item.content)
            if (text && !textBlock?.started) {
              const start = startTextBlock()
              if (start) yield start
              textBlock.text = text
              yield { type: 'text-delta', index: textBlock.index, text }
            }
            const end = closeTextBlock()
            if (end) yield end
          }
          continue
        }

        if (type === 'response.output_text.done' || type === 'response.content_part.done') {
          const finalText =
            typeof event.text === 'string'
              ? event.text
              : typeof event.part?.text === 'string'
                ? event.part.text
                : ''
          if (finalText && !textBlock?.started) {
            const start = startTextBlock()
            if (start) yield start
            textBlock.text = finalText
            yield { type: 'text-delta', index: textBlock.index, text: finalText }
          }
          const end = closeTextBlock()
          if (end) yield end
          continue
        }

        if (
          type === 'response.reasoning_text.done' ||
          type === 'response.reasoning_summary_text.done' ||
          type === 'response.reasoning.done'
        ) {
          const finalText =
            typeof event.text === 'string'
              ? event.text
              : typeof event.summary === 'string'
                ? event.summary
                : ''
          if (finalText && !reasoningBlock?.started) {
            const start = startReasoningBlock()
            if (start) yield start
            reasoningBlock.text = finalText
            yield { type: 'reasoning-delta', index: reasoningBlock.index, text: finalText }
          }
          const end = closeReasoningBlock()
          if (end) yield end
          continue
        }

        if (type === 'response.usage' || type === 'response.usage.updated' || type === 'usage') {
          const usageChunk = emitUsage(event.usage || event.response?.usage || event)
          if (usageChunk) yield usageChunk
          continue
        }

        if (type === 'response.completed') {
          const reasoningEnd = closeReasoningBlock()
          if (reasoningEnd) yield reasoningEnd
          const textEnd = closeTextBlock()
          if (textEnd) yield textEnd
          for (const block of toolBlocks) {
            if (!block.ended) for (const chunk of closeToolBlock(block)) yield chunk
          }
          const usageChunk = emitUsage(event.response?.usage || event.usage)
          if (usageChunk) yield usageChunk
          yield {
            type: 'finish',
            reason: { kind: emittedToolCall ? 'tool-calls' : 'stop' },
            replayState: { response: event.response },
          }
          finished = true
          return
        }

        if (type === 'response.incomplete' || type === 'response.output_text.incomplete') {
          const reasoningEnd = closeReasoningBlock()
          if (reasoningEnd) yield reasoningEnd
          const textEnd = closeTextBlock()
          if (textEnd) yield textEnd
          for (const block of toolBlocks) {
            if (!block.ended) for (const chunk of closeToolBlock(block)) yield chunk
          }
          const usageChunk = emitUsage(event.response?.usage || event.usage)
          if (usageChunk) yield usageChunk
          yield {
            type: 'finish',
            reason: { kind: 'max-tokens' },
            replayState: { response: event.response },
          }
          finished = true
          return
        }

        if (type === 'response.failed' || type === 'error') {
          const failureSource = event.response?.error || event.error || event.response || event
          yield {
            type: 'finish',
            reason: {
              kind: 'error',
              failure: {
                message: failureSource?.message || event.message || 'Codex 响应失败',
                code: failureSource?.code || failureSource?.type || type,
              },
            },
          }
          finished = true
          return
        }
        // 未知事件直接忽略（向前兼容）。
      }
    } catch (error) {
      if (isAbortError(error, signal)) yield abortedFinish()
      else yield errorFinish(error)
      finished = true
      return
    } finally {
      // 无论成功、失败还是提前 return，都必须释放上游连接，否则每次调用都会悬挂一条 reader/socket。
      await cancelBody(response)
    }

    if (!finished) {
      if (signal?.aborted) {
        yield abortedFinish()
      } else {
        yield {
          type: 'finish',
          reason: { kind: 'error', failure: { message: 'Codex SSE 流在 response.completed 之前结束', code: 'UNEXPECTED_EOF' } },
        }
      }
    }
  }

  async function requestWith401Retry(options, signal) {
    let credential = await getCredential()
    throwIfAborted(signal)
    if (!credential?.accessToken) throw createCodedError('未找到 ChatGPT OAuth 凭证', 'MISSING_CREDENTIAL')

    let response = await sendRequest(options, credential, signal)
    if (response.status !== 401) return response

    await cancelBody(response)
    throwIfAborted(signal)
    // 401 时 token 往往还没到过期时间，必须强制刷新，否则重试仍是同一个失效 token。
    credential = await getCredential({ force: true })
    throwIfAborted(signal)
    if (!credential?.accessToken) throw createCodedError('ChatGPT 凭证刷新失败', 'CREDENTIAL_REFRESH_FAILED')
    return sendRequest(options, credential, signal)
  }

  /** 「自动选择」：按任务规模挑具体模型（长上下文/多工具/max 思考 → 强模型，否则轻模型）。 */
  async function pickModelId(options, credential) {
    const requested = typeof options?.model === 'string' ? options.model : options?.model?.id
    if (requested && requested !== AUTO_MODEL_ID) return requested
    let models = []
    try {
      models = normalizeModels(await loadModels(credential))
    } catch {
      models = []
    }
    if (models.length === 0) return 'gpt-5-codex'
    const size = estimateRequestSize(options)
    const toolCount = Array.isArray(options?.tools) ? options.tools.length : 0
    const wantsStrong = size > 12_000 || toolCount > 12 || options?.reasoningEffort === 'max'
    const strong = models.find((model) => /6\.1|6-|sol|terra/i.test(model.slug))
    const light = models.find((model) => /5\.6|flash|luna/i.test(model.slug)) || models[0]
    return (wantsStrong && strong ? strong : light).slug
  }

  async function sendRequest(options, credential, signal) {
    const headers = {
      Authorization: `Bearer ${credential.accessToken}`,
      originator: 'codex_cli_rs',
      Accept: 'text/event-stream',
      'Content-Type': 'application/json',
    }
    if (credential.accountId) headers['chatgpt-account-id'] = credential.accountId
    const model = await pickModelId(options, credential)
    return fetch(RESPONSES_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify(await buildRequestBody({ ...options, model }, readImage)),
      signal,
    })
  }

  return {
    providerInfo,
    // DSH 的 LlmAdapter 基类方法：注册时会被调用，duck-typing 必须补齐。
    providerRetryPolicy: () => undefined,
    imageRequestPricing: () => undefined,
    imageRequestTarget: (_provider, _model, image) => ({
      width: Number.isFinite(image?.width) && image.width > 0 ? image.width : 2048,
      height: Number.isFinite(image?.height) && image.height > 0 ? image.height : 2048,
      maxBytes: 20 * 1024 * 1024,
    }),
    listModels,
    resolveModel,
    prepareCall,
    stream,
  }
}

/** 估算一次请求的文本规模（字符数），用于「自动选择」挑模型。 */
export function estimateRequestSize(options) {
  let total = String(options?.system || '').length
  for (const message of Array.isArray(options?.messages) ? options.messages : []) {
    const content = message?.content
    if (typeof content === 'string') {
      total += content.length
      continue
    }
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block?.type === 'text' && typeof block.text === 'string') total += block.text.length
      }
    }
  }
  return total
}

/** 组装 Codex Responses 请求体（异步：需要读取图片附件）。 */
export async function buildRequestBody(options, readImage) {
  const { instructions, input } = await convertMessages(options?.messages, options?.system, readImage)
  const model = typeof options?.model === 'string' ? options.model : options?.model?.id
  if (!model) throw createCodedError('未指定 Codex 模型', 'MISSING_MODEL')

  const body = { model, instructions, input, stream: true, store: false }
  if (Array.isArray(options?.tools) && options.tools.length > 0) {
    body.tools = options.tools
      .filter((tool) => tool && typeof tool.name === 'string')
      .map((tool) => ({
        type: 'function',
        name: tool.name,
        description: typeof tool.description === 'string' ? tool.description : '',
        parameters:
          tool.parameters && typeof tool.parameters === 'object' ? tool.parameters : { type: 'object', properties: {} },
      }))
  }
  const effort = options?.reasoningEffort ? EFFORT_TO_CODEX[options.reasoningEffort] : undefined
  if (effort) {
    body.reasoning = { effort, summary: 'auto' }
  }
  if (Number.isFinite(options?.maxTokens) && Number(options.maxTokens) > 0) {
    body.max_output_tokens = Math.trunc(Number(options.maxTokens))
  }
  if (Number.isFinite(options?.temperature)) body.temperature = Number(options.temperature)
  return body
}

/** 把 DSH 消息转换成 Responses input + instructions（图片需 readImage 读取附件字节）。 */
export async function convertMessages(messages, explicitSystem, readImage) {
  const instructionParts = []
  appendInstruction(instructionParts, explicitSystem)
  const input = []

  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message || typeof message.role !== 'string') continue

    if (message.role === 'system' || message.role === 'developer') {
      appendInstruction(instructionParts, message.content)
      continue
    }

    if (message.role === 'user') {
      const parts = []
      for (const block of normalizeContent(message.content)) {
        if (block?.type === 'text' && typeof block.text === 'string' && block.text) {
          parts.push({ type: 'input_text', text: block.text })
          continue
        }
        if (block?.type === 'image' && block.attachment && readImage) {
          try {
            const image = await readImage(block.attachment)
            if (image?.data && image?.mediaType) {
              parts.push({
                type: 'input_image',
                image_url: `data:${image.mediaType};base64,${Buffer.from(image.data).toString('base64')}`,
              })
            }
          } catch {
            // 读图失败时跳过该图，不让整条请求失败。
          }
        }
      }
      if (parts.length > 0) input.push({ role: 'user', content: parts })
      continue
    }

    if (message.role === 'assistant') {
      const textParts = []
      for (const block of normalizeContent(message.content)) {
        if (block?.type === 'text' && typeof block.text === 'string') {
          textParts.push(block.text)
          continue
        }
        if (block?.type === 'tool-call') {
          input.push({
            type: 'function_call',
            call_id: String(block.id || ''),
            name: String(block.name || ''),
            arguments: stringifyToolArguments(block.arguments),
          })
        }
      }
      if (textParts.length > 0) {
        input.push({ role: 'assistant', content: [{ type: 'output_text', text: textParts.join('') }] })
      }
      continue
    }

    if (message.role === 'tool') {
      const callId = message.toolCallId || message.tool_call_id || message.callId
      if (!callId) continue
      input.push({
        type: 'function_call_output',
        call_id: String(callId),
        output: extractToolOutput(message.content),
      })
    }
  }

  return { instructions: instructionParts.join('\n\n'), input }
}

function appendInstruction(target, value) {
  if (typeof value === 'string') {
    if (value) target.push(value)
    return
  }
  const text = extractText(value)
  if (text) target.push(text)
}

function normalizeContent(content) {
  if (Array.isArray(content)) return content
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  if (content && typeof content === 'object') return [content]
  return []
}

function extractText(content) {
  if (typeof content === 'string') return content
  return normalizeContent(content)
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('')
}

function extractToolOutput(content) {
  if (typeof content === 'string') return content
  const text = extractText(content)
  if (text) return text
  try {
    return JSON.stringify(content ?? '')
  } catch {
    return String(content ?? '')
  }
}

function extractOutputText(content) {
  if (!Array.isArray(content)) return ''
  return content
    .filter((part) => (part?.type === 'output_text' || part?.type === 'text') && typeof part.text === 'string')
    .map((part) => part.text)
    .join('')
}

function stringifyToolArguments(value) {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value ?? {})
  } catch {
    return '{}'
  }
}

function parseToolArguments(value) {
  if (typeof value !== 'string' || value.length === 0) return {}
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

function collectToolAliases(event, item) {
  return [item?.id, item?.call_id, event?.item_id, event?.call_id, event?.output_index]
    .filter((value) => value !== undefined && value !== null && value !== '')
    .map(String)
}

function normalizeUsage(source) {
  if (!source || typeof source !== 'object') return undefined
  const inputTokens = firstFiniteNumber(source.input_tokens, source.inputTokens, source.prompt_tokens)
  const outputTokens = firstFiniteNumber(source.output_tokens, source.outputTokens, source.completion_tokens)
  const totalTokens = firstFiniteNumber(source.total_tokens, source.totalTokens)
  if (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined) return undefined
  const normalizedInput = inputTokens ?? 0
  const normalizedOutput = outputTokens ?? 0
  return {
    inputTokens: normalizedInput,
    outputTokens: normalizedOutput,
    totalTokens: totalTokens ?? normalizedInput + normalizedOutput,
  }
}

function firstFiniteNumber(...values) {
  for (const value of values) {
    const number = Number(value)
    if (Number.isFinite(number) && number >= 0) return number
  }
  return undefined
}

/** 按 SSE 空行边界分帧；损坏 JSON、心跳、注释忽略。 */
export async function* parseSse(body, signal) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      throwIfAborted(signal)
      const { value, done } = await reader.read()
      if (done) {
        buffer += decoder.decode()
        break
      }
      buffer += decoder.decode(value, { stream: true })
      while (true) {
        const boundary = findSseBoundary(buffer)
        if (!boundary) break
        const frame = buffer.slice(0, boundary.index)
        buffer = buffer.slice(boundary.index + boundary.length)
        const event = parseSseFrame(frame)
        if (event !== undefined) yield event
      }
    }
    // 上游尾包可能不带结尾空行：done 之后仍按边界切分，避免多帧被拼成一个、丢失 response.completed。
    while (true) {
      const boundary = findSseBoundary(buffer)
      if (!boundary) break
      const frame = buffer.slice(0, boundary.index)
      buffer = buffer.slice(boundary.index + boundary.length)
      const event = parseSseFrame(frame)
      if (event !== undefined) yield event
    }
    if (buffer.trim()) {
      const event = parseSseFrame(buffer)
      if (event !== undefined) yield event
    }
  } finally {
    try {
      reader.releaseLock()
    } catch {
      // reader 已关闭
    }
  }
}

function findSseBoundary(buffer) {
  const match = /\r?\n\r?\n/.exec(buffer)
  if (!match) return undefined
  return { index: match.index, length: match[0].length }
}

export function parseSseFrame(frame) {
  const dataLines = []
  for (const line of frame.split(/\r?\n/)) {
    if (!line || line.startsWith(':')) continue
    if (line === 'data') {
      dataLines.push('')
      continue
    }
    if (line.startsWith('data:')) {
      let value = line.slice(5)
      if (value.startsWith(' ')) value = value.slice(1)
      dataLines.push(value)
    }
  }
  if (dataLines.length === 0) return undefined
  const data = dataLines.join('\n').trim()
  if (!data || data === '[DONE]') return undefined
  try {
    return JSON.parse(data)
  } catch {
    return undefined
  }
}

export function normalizeModels(models) {
  if (!Array.isArray(models)) return []
  return models
    .filter((model) => model && typeof model.slug === 'string')
    .map((model) => ({
      slug: model.slug,
      displayName:
        typeof model.displayName === 'string'
          ? model.displayName
          : typeof model.display_name === 'string'
            ? model.display_name
            : model.slug,
      contextWindow: firstFiniteNumber(model.contextWindow, model.context_window) || DEFAULT_CONTEXT_WINDOW,
    }))
}

function assertProvider(provider) {
  const providerId = requestedProviderId(provider)
  if (providerId && providerId !== PROVIDER_ID && !LEGACY_PROVIDER_IDS.includes(providerId)) {
    throw createCodedError(`不支持的 LLM provider: ${providerId}`, 'UNSUPPORTED_PROVIDER')
  }
}

/** 把 DSH 传进来的 provider（字符串或 {id}）读成路由 id；没传时给空串。 */
function requestedProviderId(provider) {
  if (typeof provider === 'string') return provider
  if (provider && typeof provider.id === 'string') return provider.id
  return ''
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return
  if (typeof signal.throwIfAborted === 'function') signal.throwIfAborted()
  const error = new Error('操作已取消')
  error.name = 'AbortError'
  throw error
}

function isAbortError(error, signal) {
  return signal?.aborted || error?.name === 'AbortError' || error?.code === 'ABORT_ERR'
}

function abortedFinish() {
  return {
    type: 'finish',
    reason: { kind: 'aborted', failure: { message: '请求已取消', code: 'ABORTED' } },
  }
}

function errorFinish(error) {
  return {
    type: 'finish',
    reason: {
      kind: 'error',
      failure: {
        message: errorMessage(error),
        code: error?.code || error?.cause?.code || error?.name || 'CODEX_REQUEST_ERROR',
      },
    },
  }
}

function createCodedError(message, code) {
  const error = new Error(message)
  error.code = code
  return error
}

function errorMessage(error) {
  if (typeof error?.message === 'string' && error.message) return error.message
  if (typeof error === 'string' && error) return error
  return 'Codex 请求失败'
}

async function readHttpFailure(response) {
  let detail = ''
  try {
    detail = (await response.text()).trim()
  } catch {
    // HTTP 状态本身即可描述失败
  }
  if (detail) {
    try {
      const parsed = JSON.parse(detail)
      detail = parsed?.error?.message || parsed?.message || detail
    } catch {
      // 非 JSON 正文原样保留
    }
  }
  return {
    message: detail || `Codex 请求失败：HTTP ${response.status} ${response.statusText || ''}`.trim(),
    code: `HTTP_${response.status}`,
  }
}

async function cancelBody(response) {
  try {
    await response?.body?.cancel()
  } catch {
    // body 可能已关闭
  }
}
