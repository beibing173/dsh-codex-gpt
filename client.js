/**
 * dsh-codex — 浏览器侧（dsh.client 声明，包入口 dsh-codex/client）。
 *
 * 两处 UI：
 *   1. 输入框左侧「Codex」胶囊按钮（conversation.input.left，按会话渲染）：
 *      点击 = 授权/撤销当前会话使用 Codex。这是用户手动授权的唯一入口。
 *   2. 设置 →「Codex」页（settings.section）：API Key / Base URL / 默认模型 /
 *      模型列表 / 自主调用开关 / 局域网访问 / 连接测试。
 *
 * 数据通道：Host 注册的同源 HTTP 路由 `/dsh-codex-api`（GET 读状态，POST 写状态）。
 * 这样不需要自定义 Typert Remote 描述符，客户端只依赖 fetch 与 slots。
 *
 * 格式为 __ModuleLoader__ 的 CJS-factory 形式（id 必须等于包名）。
 */
window.__ModuleLoader__.load({
  id: 'dsh-codex',
  factory: (require) => {
    const React = require('react')
    const { useCallback, useEffect, useRef, useState } = React
    const h = React.createElement

    /** Host 状态路由。 */
    const API = '/dsh-codex-api'

    const styles = {
      page: { display: 'flex', flexDirection: 'column', gap: '14px', padding: '4px 0', maxWidth: '720px' },
      card: {
        border: '1px solid var(--dsw-alias-border-strong, rgba(128,128,128,.3))',
        borderRadius: '12px',
        padding: '14px 16px',
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
      },
      row: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' },
      title: { fontSize: '15px', fontWeight: 600 },
      hint: { fontSize: '13px', opacity: 0.72, lineHeight: '1.65' },
      label: { fontSize: '12px', opacity: 0.6, minWidth: '92px' },
      button: {
        border: '1px solid var(--dsw-alias-border-strong, rgba(128,128,128,.3))',
        background: 'transparent',
        color: 'inherit',
        borderRadius: '8px',
        padding: '4px 10px',
        fontSize: '13px',
        cursor: 'pointer',
        fontFamily: 'inherit',
      },
      buttonPrimary: {
        border: 'none',
        background: 'var(--dsw-specific-accent, #4d6bfe)',
        color: '#fff',
        borderRadius: '8px',
        padding: '5px 12px',
        fontSize: '13px',
        cursor: 'pointer',
        fontFamily: 'inherit',
      },
      input: {
        background: 'transparent',
        border: '1px solid var(--dsw-alias-border-strong, rgba(128,128,128,.3))',
        borderRadius: '8px',
        padding: '5px 8px',
        color: 'inherit',
        fontSize: '13px',
        fontFamily: 'inherit',
        flex: 1,
        minWidth: '200px',
        boxSizing: 'border-box',
      },
      select: {
        background: 'transparent',
        border: '1px solid var(--dsw-alias-border-strong, rgba(128,128,128,.3))',
        borderRadius: '8px',
        padding: '5px 8px',
        color: 'inherit',
        fontSize: '13px',
        fontFamily: 'inherit',
        minWidth: '180px',
      },
      notice: { fontSize: '12px', color: 'var(--dsw-specific-accent, #4d6bfe)' },
      error: { fontSize: '12px', color: '#d9534f', lineHeight: '1.5' },
      toggleTrack: {
        width: '38px',
        height: '22px',
        borderRadius: '11px',
        position: 'relative',
        transition: 'background .15s',
        cursor: 'pointer',
        background: 'var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.35))',
        flex: '0 0 auto',
      },
      toggleKnob: {
        width: '16px',
        height: '16px',
        borderRadius: '50%',
        background: '#fff',
        position: 'absolute',
        top: '3px',
        transition: 'left .15s',
      },
    }

    /** 统一请求：非 2xx 或 ok:false 抛 Error(message)。 */
    async function request(path, init) {
      const response = await fetch(path, init)
      let payload
      try {
        payload = await response.json()
      } catch {
        payload = undefined
      }
      if (!response.ok || !payload || payload.ok === false) {
        const message = (payload && payload.error) || `HTTP ${response.status}`
        throw new Error(message)
      }
      return payload
    }

    /** 读取全局配置 + 指定会话授权状态。 */
    function loadState(sessionId) {
      const query = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ''
      return request(API + query, { headers: { Accept: 'application/json' }, cache: 'no-store' })
    }

    /** 写入一个操作。 */
    function postOp(payload) {
      return request(API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(payload),
      })
    }

    function ToggleBox(props) {
      const on = props.on === true
      return h(
        'span',
        {
          style: {
            ...styles.toggleTrack,
            background: on ? 'var(--dsw-specific-accent, #4d6bfe)' : styles.toggleTrack.background,
          },
        },
        h('span', { style: { ...styles.toggleKnob, left: on ? '19px' : '3px' } }),
      )
    }

    /**
     * 输入框左侧的 Codex 胶囊按钮（会话作用域）。
     * 未授权时灰色、已授权时高亮；点击切换本会话授权。
     */
    function CodexToggle(props) {
      const sessionId = props && props.sessionId ? String(props.sessionId) : ''
      const [state, setState] = useState({ status: 'loading', session: null, global: null, error: '' })
      const [busy, setBusy] = useState(false)

      const reload = useCallback(async () => {
        if (!sessionId) {
          setState({ status: 'unavailable', session: null, global: null, error: '当前没有会话' })
          return
        }
        try {
          const data = await loadState(sessionId)
          setState({ status: 'ready', session: data.session, global: data.global, error: '' })
        } catch (error) {
          setState({ status: 'error', session: null, global: null, error: String(error.message || error) })
        }
      }, [sessionId])

      useEffect(() => {
        void reload()
      }, [reload])

      const enabled = Boolean(state.session && state.session.enabled === true)
      const unavailable = state.status === 'error' || state.status === 'unavailable'
      const model = (state.session && state.session.model) || (state.global && state.global.defaultModel) || ''

      const toggle = useCallback(async () => {
        if (!sessionId || busy || unavailable) return
        setBusy(true)
        try {
          const data = await postOp({ op: 'setSessionEnabled', sessionId, enabled: !enabled })
          setState({ status: 'ready', session: data.session, global: data.global, error: '' })
        } catch (error) {
          if (typeof window !== 'undefined') window.alert('Codex 开关失败：' + String(error.message || error))
        } finally {
          setBusy(false)
        }
      }, [sessionId, enabled, busy, unavailable])

      const title = unavailable
        ? 'Codex 状态不可用：' + (state.error || '服务未就绪')
        : enabled
          ? `本会话已授权 Codex（模型 ${model || '默认'}）。点击撤销授权。`
          : '本会话未授权 Codex。点击允许本会话在需要时调用 GPT/Codex 做专业分析。'

      return h(
        'button',
        {
          type: 'button',
          onClick: toggle,
          disabled: unavailable || busy,
          title,
          'aria-pressed': enabled ? 'true' : 'false',
          'aria-label': enabled ? 'Codex 已授权，点击撤销' : 'Codex 未授权，点击允许',
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: '6px',
            height: '26px',
            padding: '0 9px',
            borderRadius: '13px',
            border: `1px solid ${enabled ? 'var(--dsw-specific-accent, #4d6bfe)' : 'var(--dsw-alias-border-strong, rgba(128,128,128,.35))'}`,
            background: 'transparent',
            color: enabled ? 'var(--dsw-specific-accent, #4d6bfe)' : 'inherit',
            cursor: unavailable || busy ? 'default' : 'pointer',
            opacity: unavailable ? 0.45 : busy ? 0.6 : 1,
            fontSize: '12px',
            fontFamily: 'inherit',
            lineHeight: 1,
            whiteSpace: 'nowrap',
            flex: '0 0 auto',
          },
        },
        h('span', {
          style: {
            width: '6px',
            height: '6px',
            borderRadius: '50%',
            flex: '0 0 auto',
            background: enabled
              ? 'var(--dsw-specific-accent, #4d6bfe)'
              : 'var(--dsw-alias-border-strong, rgba(128,128,128,.55))',
          },
        }),
        h('span', null, 'Codex'),
        busy ? h('span', { style: { fontSize: '10px', opacity: 0.6 } }, '…') : null,
      )
    }

    /** 设置 →「Codex」页。 */
    function CodexSettings() {
      const [global, setGlobal] = useState(null)
      const [error, setError] = useState('')
      const [notice, setNotice] = useState('')
      const [busy, setBusy] = useState(false)
      const [testing, setTesting] = useState(false)
      const [checking, setChecking] = useState(false)
      const [network, setNetwork] = useState(null)
      const initialized = useRef(false)
      const [form, setForm] = useState({
        apiKey: '',
        baseUrl: '',
        defaultModel: '',
        modelsText: '',
        autoConsult: true,
        maxOutputTokens: '0',
        allowLanAccess: false,
      })

      const setField = useCallback((key, value) => {
        setForm((current) => ({ ...current, [key]: value }))
      }, [])

      const load = useCallback(async () => {
        try {
          const data = await loadState('')
          setGlobal(data.global)
          setError('')
          if (!initialized.current) {
            initialized.current = true
            setForm({
              apiKey: '',
              baseUrl: data.global.baseUrl || '',
              defaultModel: data.global.defaultModel || '',
              modelsText: (data.global.models || []).join(', '),
              autoConsult: data.global.autoConsult !== false,
              maxOutputTokens: String(data.global.maxOutputTokens || 0),
              allowLanAccess: data.global.allowLanAccess === true,
            })
          }
        } catch (error) {
          setError(String(error.message || error))
        }
      }, [])

      useEffect(() => {
        void load()
      }, [load])

      const models = (global && global.models) || []
      const modelOptions = [...new Set([...(form.defaultModel ? [form.defaultModel] : []), ...models])]

      const save = useCallback(async () => {
        setBusy(true)
        setNotice('')
        setError('')
        try {
          const patch = {
            baseUrl: form.baseUrl.trim(),
            defaultModel: form.defaultModel.trim(),
            models: form.modelsText
              .split(',')
              .map((item) => item.trim())
              .filter(Boolean),
            autoConsult: form.autoConsult,
            maxOutputTokens: Number(form.maxOutputTokens) || 0,
            allowLanAccess: form.allowLanAccess,
          }
          if (form.apiKey.trim()) patch.apiKey = form.apiKey.trim()
          const data = await postOp({ op: 'setGlobal', patch })
          setGlobal(data.global)
          setForm((current) => ({ ...current, apiKey: '' }))
          setNotice('已保存并生效。')
        } catch (error) {
          setError(String(error.message || error))
        } finally {
          setBusy(false)
        }
      }, [form])

      const test = useCallback(async () => {
        setTesting(true)
        setNotice('')
        setError('')
        try {
          const data = await postOp({ op: 'testConnection' })
          const result = data.result || {}
          setNotice(`连接正常：${result.model || '模型'}（${result.latencyMs ?? '?'}ms，${result.endpoint || 'responses'}）`)
        } catch (error) {
          setError('连接测试失败：' + String(error.message || error))
        } finally {
          setTesting(false)
        }
      }, [])

      const checkNetwork = useCallback(async () => {
        setChecking(true)
        setNotice('')
        setError('')
        try {
          const data = await postOp({ op: 'testNetwork' })
          setNetwork(data.result || null)
        } catch (error) {
          setError('外网连通性检查失败：' + String(error.message || error))
        } finally {
          setChecking(false)
        }
      }, [])

      if (!global && !error) return h('div', { style: styles.hint }, 'Codex 设置加载中…')
      if (!global && error) return h('div', { style: styles.error }, `Codex 状态不可用：${error}`)

      const keyHint = global.apiConfigured
        ? global.keySource === 'env'
          ? '已从环境变量 OPENAI_API_KEY 读取；留空则继续使用环境变量。'
          : '已配置 API Key；留空保持不变，填入新值则覆盖。'
        : '尚未配置 API Key。填写后保存，或设置环境变量 OPENAI_API_KEY。'

      return h(
        'div',
        { style: styles.page },
        h(
          'div',
          { style: styles.card },
          h('div', { style: styles.title }, '🛠️ Codex 专业分析通道'),
          h(
            'div',
            { style: styles.hint },
            '正常任务始终由 DeepSeek（V4.1）处理。只有你手动在会话里授权 Codex 后，模型才会在任务强度高或需要专业分析时调用 OpenAI Codex/GPT；授权按会话保存，可随时撤销。',
          ),
          h(
            'div',
            { style: styles.row },
            h('span', { style: styles.label }, 'API Key'),
            h('input', {
              type: 'password',
              autoComplete: 'off',
              spellCheck: false,
              style: styles.input,
              placeholder: global.apiConfigured ? '已配置（留空保持不变）' : 'sk-...',
              value: form.apiKey,
              onChange: (event) => setField('apiKey', event.target.value),
            }),
          ),
          h('div', { style: styles.hint }, keyHint),
          h(
            'div',
            { style: styles.row },
            h('span', { style: styles.label }, 'Base URL'),
            h('input', {
              style: styles.input,
              placeholder: 'https://api.openai.com/v1',
              value: form.baseUrl,
              onChange: (event) => setField('baseUrl', event.target.value),
            }),
          ),
          h(
            'div',
            { style: styles.row },
            h('span', { style: styles.label }, '默认模型'),
            h(
              'select',
              {
                style: styles.select,
                value: form.defaultModel,
                onChange: (event) => setField('defaultModel', event.target.value),
              },
              modelOptions.map((model) => h('option', { key: model, value: model }, model)),
            ),
          ),
          h(
            'div',
            { style: styles.row },
            h('span', { style: styles.label }, '模型列表'),
            h('input', {
              style: styles.input,
              placeholder: '用逗号分隔，例如 gpt-5-codex, gpt-5, gpt-5-mini',
              value: form.modelsText,
              onChange: (event) => setField('modelsText', event.target.value),
            }),
          ),
          h(
            'div',
            { style: styles.row },
            h('span', { style: styles.label }, '自主调用'),
            h(
              'label',
              { style: { display: 'inline-flex', alignItems: 'center', gap: '8px', cursor: 'pointer' } },
              h(ToggleBox, { on: form.autoConsult }),
              h(
                'span',
                { onClick: () => setField('autoConsult', !form.autoConsult), style: { fontSize: '13px' } },
                form.autoConsult ? '已授权会话可按任务强度自主调用' : '仅在用户明确要求时调用',
              ),
            ),
          ),
          h(
            'div',
            { style: styles.row },
            h('span', { style: styles.label }, '输出上限'),
            h('input', {
              type: 'number',
              min: 0,
              step: 1000,
              style: { ...styles.input, maxWidth: '140px' },
              value: form.maxOutputTokens,
              onChange: (event) => setField('maxOutputTokens', event.target.value),
            }),
            h('span', { style: styles.hint }, 'token；0 表示不设置'),
          ),
          h(
            'div',
            { style: styles.row },
            h(ToggleBox, { on: form.allowLanAccess }),
            h(
              'span',
              {
                onClick: () => setField('allowLanAccess', !form.allowLanAccess),
                style: { fontSize: '13px', cursor: 'pointer' },
              },
              '允许局域网设备读写本插件状态（默认仅本机）',
            ),
          ),
          h(
            'div',
            { style: styles.row },
            h(
              'button',
              { type: 'button', style: styles.buttonPrimary, onClick: save, disabled: busy },
              busy ? '保存中…' : '保存',
            ),
            h(
              'button',
              { type: 'button', style: styles.button, onClick: test, disabled: testing },
              testing ? '测试中…' : '测试连接',
            ),
            h(
              'button',
              { type: 'button', style: styles.button, onClick: checkNetwork, disabled: checking },
              checking ? '检查中…' : '外网连通性检查',
            ),
          ),
          network
            ? h(
                'div',
                { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
                h(
                  'div',
                  { style: styles.hint },
                  `外网连通性：${network.reachable}/${network.total} 条链路可达（判定标准是能拿到 HTTP 响应）`,
                ),
                (network.targets || []).map((target) =>
                  h(
                    'div',
                    { key: target.id, style: { display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px' } },
                    h('span', {
                      style: {
                        width: '7px',
                        height: '7px',
                        borderRadius: '50%',
                        flex: '0 0 auto',
                        background: target.ok ? '#2fa84f' : '#d9534f',
                      },
                    }),
                    h('span', { style: { minWidth: '96px' } }, target.label),
                    h(
                      'span',
                      { style: { opacity: 0.65, flex: 1 } },
                      target.ok
                        ? `可达 · HTTP ${target.status} · ${target.latencyMs}ms`
                        : `不可达 · ${target.error || '连接失败'}（${target.latencyMs}ms）`,
                    ),
                  ),
                ),
              )
            : null,
          notice ? h('div', { style: styles.notice }, notice) : null,
          error ? h('div', { style: styles.error }, error) : null,
        ),
        h(
          'div',
          { style: styles.card },
          h('div', { style: styles.title }, '使用方式'),
          h(
            'div',
            { style: styles.hint },
            '1. 在本页填好 API Key 与默认模型并保存。',
          ),
          h(
            'div',
            { style: styles.hint },
            '2. 回到对话，点击输入框左侧的「Codex」按钮授权当前会话（按钮变蓝即已授权）。',
          ),
          h(
            'div',
            { style: styles.hint },
            '3. 之后遇到高难度任务，DeepSeek 会自主调用 Codex 获取分析；也可以直接说「让 GPT 分析一下」。',
          ),
          h(
            'div',
            { style: styles.hint },
            '4. 未授权的会话保持纯 DeepSeek 模式，不会产生任何 OpenAI 费用。',
          ),
        ),
      )
    }

    /** 日期展示：ISO 字符串或 unix 秒/毫秒都兜住。 */
    function formatDate(value) {
      if (typeof value !== 'string' || !value) return ''
      const match = value.match(/^(\d{4})-(\d{2})-(\d{2})/)
      if (match) return `${match[1]}-${match[2]}-${match[3]}`
      const number = Number(value)
      if (Number.isFinite(number) && number > 0) {
        const date = new Date(number < 1e12 ? number * 1000 : number)
        if (!Number.isNaN(date.getTime())) return date.toISOString().slice(0, 10)
      }
      return ''
    }

    const usageStyles = {
      card: {
        display: 'flex',
        flexDirection: 'column',
        gap: '7px',
        width: '100%',
        boxSizing: 'border-box',
        border: '1px solid var(--dsw-alias-border-strong, rgba(128,128,128,.3))',
        borderRadius: '12px',
        padding: '10px 12px',
        cursor: 'pointer',
      },
      head: { display: 'flex', alignItems: 'center', gap: '6px' },
      brand: { fontSize: '12px', fontWeight: 600, letterSpacing: '.02em' },
      badge: {
        fontSize: '10px',
        lineHeight: '16px',
        padding: '0 6px',
        borderRadius: '99px',
        background: 'var(--dsw-specific-accent, #4d6bfe)',
        color: '#fff',
      },
      row: { display: 'flex', alignItems: 'center', gap: '8px' },
      label: { fontSize: '11px', opacity: 0.72, minWidth: '44px' },
      track: {
        flex: 1,
        height: '4px',
        borderRadius: '2px',
        background: 'var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.25))',
        overflow: 'hidden',
      },
      fill: { height: '100%', borderRadius: '2px', transition: 'width .2s' },
      percent: { fontSize: '11px', opacity: 0.8, minWidth: '32px', textAlign: 'right' },
      hint: { fontSize: '11px', opacity: 0.6, marginTop: '1px' },
    }

    /**
     * 侧边栏底部用量卡片：Codex（ChatGPT 订阅）的 5 小时 / 每周限额、
     * 当前订阅状态与到期日。数据来自 Host 的 `/dsh-codex-api?usage=1`
     * （读本机 Codex 登录凭证）；拿不到就整块不渲染，不留空卡片。
     * 只有侧边栏展开（wide）时显示；点击卡片立即刷新，60 秒心跳一次。
     */
    function CodexUsageCard(props) {
      const wide = !(props && props.wide === false)
      const [usage, setUsage] = useState(null)
      const mounted = useRef(true)
      const requestSeq = useRef(0)

      const load = useCallback(async () => {
        const seq = ++requestSeq.current
        try {
          const data = await request(API + '?usage=1', {
            headers: { Accept: 'application/json' },
            cache: 'no-store',
          })
          if (!mounted.current || seq !== requestSeq.current) return
          setUsage(data.usage && data.usage.available === true ? data.usage : null)
        } catch {
          if (!mounted.current || seq !== requestSeq.current) return
          setUsage(null)
        }
      }, [])

      useEffect(() => {
        mounted.current = true
        void load()
        const timer = setInterval(() => {
          if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
          void load()
        }, 60_000)
        const onVisible = () => {
          if (typeof document !== 'undefined' && document.visibilityState === 'visible') void load()
        }
        if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible)
        return () => {
          mounted.current = false
          clearInterval(timer)
          if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible)
        }
      }, [load])

      if (!wide || !usage) return null

      const windows = Array.isArray(usage.windows) ? usage.windows : []
      const planText = usage.planLabel || ''
      const subscription = usage.subscription || {}
      const untilDate = formatDate(subscription.activeUntil)
      // 订阅周期字段来自登录 token，可能是上一个周期：过期就如实标注，而不是假装有效。
      const today = new Date().toISOString().slice(0, 10)
      const untilText = untilDate
        ? untilDate >= today
          ? `订阅有效至 ${untilDate}`
          : `订阅周期至 ${untilDate}（已结束）`
        : ''
      const resetCredits = Number.isFinite(usage.resetCredits) && usage.resetCredits > 0 ? usage.resetCredits : 0

      return h(
        'div',
        {
          onClick: () => void load(),
          title: 'Codex 用量：点击刷新',
          role: 'status',
          style: usageStyles.card,
        },
        h(
          'div',
          { style: usageStyles.head },
          h('span', { style: usageStyles.brand }, 'Codex'),
          planText ? h('span', { style: usageStyles.badge }, planText) : null,
          resetCredits > 0
            ? h('span', { style: { marginLeft: 'auto', fontSize: '10px', opacity: 0.55 } }, `${resetCredits} 次重置`)
            : null,
        ),
        ...windows.map((window) =>
          h(
            'div',
            { key: window.id || window.label, style: usageStyles.row },
            h('span', { style: usageStyles.label }, window.label || ''),
            h(
              'div',
              { style: usageStyles.track },
              h('div', {
                style: {
                  ...usageStyles.fill,
                  width: `${Math.max(0, Math.min(100, Number(window.usedPercent) || 0))}%`,
                  background:
                    Number(window.usedPercent) >= 85
                      ? '#d9534f'
                      : 'var(--dsw-specific-accent, #4d6bfe)',
                },
              }),
            ),
            h('span', { style: usageStyles.percent }, `${Math.round(Number(window.usedPercent) || 0)}%`),
          ),
        ),
        untilText ? h('div', { style: usageStyles.hint }, `订阅有效至 ${untilText}`) : null,
      )
    }

    return {
      name: 'codex-client',
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.input.left', () =>
          ctx.slots.register(
            {
              name: 'conversation.input.left',
              id: 'codex-toggle',
              order: 4,
            },
            CodexToggle,
          ),
        )
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            {
              name: 'settings.section',
              id: 'dsh-codex',
              order: 60,
              label: 'Codex',
            },
            CodexSettings,
          ),
        )
        // 侧边栏底部用量卡片（拿不到 Codex 用量时组件自身返回 null）。
        ctx.slots.inject('sidebar.footer.action', () =>
          ctx.slots.register(
            {
              name: 'sidebar.footer.action',
              id: 'dsh-codex-usage',
              order: 101,
              label: 'Codex 用量',
            },
            (props) => h(CodexUsageCard, { wide: props && props.wide }),
          ),
        )
      },
    }
  },
})
