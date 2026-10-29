/**
 * dsh-codex — 浏览器侧（dsh.client 声明，包入口 dsh-codex/client）。
 *
 * 三处 UI：
 *   1. 输入框左侧胶囊按钮（conversation.input.left）：点击授权/撤销当前会话；
 *      显示名随当前模型变化（ChatGPT 时显示「DeepSeek」，其他模型时显示「ChatGPT」），仅改显示。
 *   2. 侧边栏底部用量卡片（sidebar.footer.action）：5 小时 / 每周限额、订阅状态、有效期。
 *   3. 设置 →「ChatGPT」页（settings.section）：登录 OpenAI 账号（跳官网 OAuth）、
 *      模型列表（从 OpenAI 实时拉取）、自主调用开关、外网连通性检查。
 *
 * 数据通道：Host 的同源 HTTP 路由 `/dsh-codex-api`（GET 读状态，POST 写操作）。
 */
window.__ModuleLoader__.load({
  id: 'dsh-codex-gpt',
  factory: (require) => {
    const React = require('react')
    const { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } = React
    const h = React.createElement

    const API = '/dsh-codex-api'
    /** 写操作令牌：由同源 GET 快照下发，跨站页面读不到响应体因此拿不到。 */
    let writeToken = ''

    /** 没有模型目录时用的恒定订阅/取值，保证 hook 调用顺序稳定。 */
    const noopSubscribe = () => () => {}
    const emptyProviderValue = () => ''
    /** 本插件 ChatGPT provider 的规范 id（与生态对齐，便于其它插件识别）。 */
    const CHATGPT_PROVIDER_ID = 'openai-codex'
    /** 旧版本注册过的路由 id：老会话里保存的模型选择仍是它，显示名要一样按 GPT 认。 */
    const CHATGPT_PROVIDER_IDS = new Set([CHATGPT_PROVIDER_ID, 'chatgpt-codex'])
    /** 保险开关开启时，用来判断「其他 provider 提供的模型名看起来像 GPT」。 */
    const LOOKS_LIKE_GPT_RE = /^(?:gpt|o[0-9]|chatgpt)/i

    /** 从目录 store 里读出「provider\0model」，没有选择时给空串（保持 uSES 快照稳定）。 */
    const selectionOf = (store) => {
      try {
        const snapshot = store && typeof store.getSnapshot === 'function' ? store.getSnapshot() : null
        const current = snapshot && snapshot.current
        return current ? `${current.provider || ''}\u0000${current.model || ''}` : ''
      } catch {
        return ''
      }
    }

    /**
     * 只读解析当前会话的模型目录（仅用于决定胶囊显示名）。
     * modelDirectories 可能尚未就绪或未安装，任何失败都返回 null，胶囊回落到「ChatGPT」。
     */
    function resolveModelDirectory(ctx, sessionId) {
      if (!ctx || !sessionId) return null
      try {
        const service = ctx.get('modelDirectories')
        if (!service || typeof service.directoryFor !== 'function') return null
        const directory = service.directoryFor(String(sessionId))
        return directory && directory.store ? directory : null
      } catch {
        return null
      }
    }

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
        padding: '6px 14px',
        fontSize: '13px',
        cursor: 'pointer',
        fontFamily: 'inherit',
      },
      select: {
        background: 'transparent',
        border: '1px solid var(--dsw-alias-border-strong, rgba(128,128,128,.3))',
        borderRadius: '8px',
        padding: '5px 8px',
        color: 'inherit',
        fontSize: '13px',
        fontFamily: 'inherit',
        minWidth: '220px',
      },
      badge: {
        fontSize: '11px',
        lineHeight: '18px',
        padding: '0 8px',
        borderRadius: '99px',
        background: 'var(--dsw-specific-accent, #4d6bfe)',
        color: '#fff',
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
      if (typeof payload.writeToken === 'string' && payload.writeToken) writeToken = payload.writeToken
      return payload
    }

    function loadState(sessionId) {
      const query = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ''
      return request(API + query, { headers: { Accept: 'application/json' }, cache: 'no-store' })
    }

    async function postOp(payload, retried) {
      try {
        return await request(API, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'x-dsh-write-token': writeToken,
          },
          body: JSON.stringify(payload),
        })
      } catch (error) {
        // 令牌还没拿到（页面刚加载就点按钮）时，先取一次快照再重试。
        const message = String((error && error.message) || error)
        if (!retried && message.indexOf('令牌') >= 0) {
          await request(API, { headers: { Accept: 'application/json' }, cache: 'no-store' })
          return postOp(payload, true)
        }
        throw error
      }
    }

    function ToggleBox(props) {
      const on = props.on === true
      const toggle = props.onClick
      return h(
        'span',
        {
          role: 'switch',
          tabIndex: toggle ? 0 : undefined,
          'aria-checked': on ? 'true' : 'false',
          onClick: toggle,
          onKeyDown: toggle
            ? (event) => {
                if (event.key === ' ' || event.key === 'Enter') {
                  event.preventDefault()
                  toggle()
                }
              }
            : undefined,
          style: {
            ...styles.toggleTrack,
            cursor: toggle ? 'pointer' : undefined,
            background: on ? 'var(--dsw-specific-accent, #4d6bfe)' : styles.toggleTrack.background,
          },
        },
        h('span', { style: { ...styles.toggleKnob, left: on ? '19px' : '3px' } }),
      )
    }

    /** 输入框左侧的授权胶囊按钮（会话作用域）。 */
    function CodexToggle(props) {
      const slotProps = props || {}
      // slots 可能把 register({inject}) 的返回值直接铺成 props，也可能挂在 props.inject 下，
      // 两种都要认，否则「当前模型」永远读不到、胶囊就固定显示同一个名字。
      const bag = slotProps.inject && typeof slotProps.inject === 'object' ? slotProps.inject : null
      const readProp = (name) => {
        if (slotProps[name] !== undefined && slotProps[name] !== null) return slotProps[name]
        if (bag && bag[name] !== undefined && bag[name] !== null) return bag[name]
        return undefined
      }
      const rawSessionId = readProp('sessionId')
      const sessionId = rawSessionId ? String(rawSessionId) : ''
      const directoryStore = readProp('directoryStore') || null
      const loadModels = readProp('loadModels')
      const resolveDirectory = readProp('resolveDirectory')
      const [state, setState] = useState({ status: 'loading', session: null, auth: null, global: null, error: '' })
      const [busy, setBusy] = useState(false)

      // 只读当前会话的 provider / model（不切换、不写入），仅用于决定胶囊显示的名字。
      const subscribed = useSyncExternalStore(
        directoryStore && typeof directoryStore.subscribe === 'function'
          ? (listener) => directoryStore.subscribe(listener)
          : noopSubscribe,
        directoryStore && typeof directoryStore.getSnapshot === 'function'
          ? () => selectionOf(directoryStore)
          : emptyProviderValue,
      )

      // 兜底：如果 slot 没递进来目录对象，就自己通过 modelDirectories 服务解析，
      // 并轮询同步（订阅万一没触发也能在 0.8 秒内收敛）。
      const [polledSelection, setPolledSelection] = useState('')
      useEffect(() => {
        if (directoryStore || typeof resolveDirectory !== 'function' || !sessionId) return undefined
        let store = null
        let unsubscribe = null
        let stopped = false
        const sync = () => {
          if (stopped) return
          try {
            if (!store) {
              const directory = resolveDirectory()
              store = directory && directory.store ? directory.store : null
              if (store && typeof store.subscribe === 'function') {
                const off = store.subscribe(() => sync())
                unsubscribe = typeof off === 'function' ? off : null
              }
            }
            setPolledSelection(store ? selectionOf(store) : '')
          } catch {
            setPolledSelection('')
          }
        }
        sync()
        const timer = setInterval(sync, 800)
        return () => {
          stopped = true
          clearInterval(timer)
          if (unsubscribe) unsubscribe()
        }
      }, [directoryStore, resolveDirectory, sessionId])

      const selection = subscribed || polledSelection
      const [provider = '', currentModelId = ''] = selection ? selection.split('\u0000') : []

      useEffect(() => {
        if (typeof loadModels === 'function') loadModels()
      }, [loadModels])

      const reload = useCallback(async () => {
        if (!sessionId) {
          setState({ status: 'unavailable', session: null, auth: null, global: null, error: '当前没有会话' })
          return
        }
        try {
          const data = await loadState(sessionId)
          setState({ status: 'ready', session: data.session, auth: data.auth, global: data.global || null, error: '' })
        } catch (error) {
          setState({ status: 'error', session: null, auth: null, global: null, error: String(error.message || error) })
        }
      }, [sessionId])

      useEffect(() => {
        void reload()
      }, [reload])

      // 设置页保存后（如切换 gptNameDetect）窗口重新获得焦点时刷新一次，保证显示名跟上配置。
      useEffect(() => {
        if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return undefined
        const refresh = () => {
          void reload()
        }
        window.addEventListener('focus', refresh)
        return () => window.removeEventListener('focus', refresh)
      }, [reload])

      const enabled = Boolean(state.session && state.session.enabled === true)
      const loggedIn = Boolean(state.auth && state.auth.loggedIn === true)
      const unavailable = state.status === 'error' || state.status === 'unavailable'
      const model = (state.session && state.session.model) || (state.auth && state.auth.planLabel) || ''
      // 显示名规则（仅显示，不影响点击行为）：
      //   默认：当前 provider 是本插件 ChatGPT → 显示 DeepSeek，其他 → 显示 ChatGPT
      //   保险开关 gptNameDetect 开启后：其他 provider 但模型 id 形如 gpt-*/o3-* 也按 GPT 识别 → 显示 DeepSeek
      const nameDetect = Boolean(state.global && state.global.gptNameDetect === true)
      const isOwnChatGpt = CHATGPT_PROVIDER_IDS.has(provider)
      const isOtherGptNamed = nameDetect && LOOKS_LIKE_GPT_RE.test(currentModelId || '')
      const label = isOwnChatGpt || isOtherGptNamed ? 'DeepSeek' : 'ChatGPT'

      const toggle = useCallback(async () => {
        if (!sessionId || busy || unavailable) return
        setBusy(true)
        try {
          const data = await postOp({ op: 'setSessionEnabled', sessionId, enabled: !enabled })
          setState((prev) => ({ status: 'ready', session: data.session, auth: data.auth, global: prev.global, error: '' }))
        } catch (error) {
          if (typeof window !== 'undefined') window.alert('ChatGPT 开关失败：' + String(error.message || error))
        } finally {
          setBusy(false)
        }
      }, [sessionId, enabled, busy, unavailable])

      const title = unavailable
        ? `${label} 状态不可用：` + (state.error || '服务未就绪')
        : !loggedIn
          ? '尚未登录 OpenAI 账号：请先到 设置 → ChatGPT 页登录，再点这里授权本会话。'
          : enabled
            ? `本会话已授权 ChatGPT（模型 ${model || '默认'}）。点击撤销授权。`
            : '本会话未授权 ChatGPT。点击允许本会话在需要时调用 GPT 做专业分析。'

      return h(
        'button',
        {
          type: 'button',
          onClick: toggle,
          disabled: unavailable || busy,
          title,
          'aria-pressed': enabled ? 'true' : 'false',
          'aria-label': enabled ? `${label} 已授权，点击撤销` : `${label} 未授权，点击允许`,
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
        h('span', null, label),
        busy ? h('span', { style: { fontSize: '10px', opacity: 0.6 } }, '…') : null,
      )
    }

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

    /** unix 秒 → 本地「MM-DD HH:mm」，用于窗口重置时间提示。 */
    function formatReset(value) {
      const number = Number(value)
      if (!Number.isFinite(number) || number <= 0) return ''
      const date = new Date(number * 1000)
      if (Number.isNaN(date.getTime())) return ''
      const pad = (input) => String(input).padStart(2, '0')
      return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
    }

    /** 毫秒 → 「x 小时 y 分」/「y 分钟」。 */
    function formatCountdown(ms) {
      const total = Math.max(0, Math.round(Number(ms) / 60_000))
      if (total <= 0) return '不到 1 分钟'
      const hours = Math.floor(total / 60)
      const minutes = total % 60
      if (hours > 0) return minutes > 0 ? `${hours} 小时 ${minutes} 分` : `${hours} 小时`
      return `${minutes} 分钟`
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

    /** 侧边栏底部 Codex 用量卡片；拿不到数据或侧栏收起时不渲染。 */
    /** 侧边栏底部用量卡片：可在 ChatGPT / DeepSeek / 其它已配置的 AI 之间切换。 */
    const USAGE_ACCOUNTS_PATH = '/api/deepseek-usage/accounts'
    /** provider id → 展示名（缺省用接口返回的 displayName）。 */
    const USAGE_LABELS = {
      chatgpt: 'ChatGPT',
      'openai-codex': 'ChatGPT',
      'deepseek-account': 'DeepSeek',
      deepseek: 'DeepSeek',
      'deepseek-official': 'DeepSeek',
      moonshotai: 'Kimi',
      'kimi-coding': 'Kimi',
      zai: 'GLM',
      openrouter: 'OpenRouter',
      minimax: 'MiniMax',
      'minimax-cn': 'MiniMax CN',
      opencode: 'OpenCode',
      'opencode-go': 'OpenCode Go',
      anthropic: 'Claude',
    }
    const usageLabelOf = (row) => USAGE_LABELS[row.id] || row.displayName || row.id

    /**
     * 界面文案：跟随 DSH 当前语言（中/英）。
     *
     * 语言探测顺序：locale 服务快照 → <html lang>（DSH 会把当前语言写在这里）→ 中文。
     * 不注册词典、不用 useSyncExternalStore：只做「读语言 + 变化时 setState」，
     * 避免快照引用不稳定把组件弄崩（历史上因此整块卡片消失过）。
     */
    const I18N = {
      zh: {
        balance: '余额',
        paygo: '按量计费',
        offPeak: '折扣价时段',
        peak: '标准价时段',
        peakUnknown: '时段未知',
        nextOffPeak: '恢复标准价还有',
        nextPeak: '进入折扣价还有',
        loading: '正在读取…',
        noBalance: '暂无余额数据',
        noUsage: '暂无用量数据',
        remaining: (n) => `剩 ${n}%`,
        hour5: '5 小时',
        week: '每周',
        subUntil: (d) => `订阅有效至 ${d}`,
        subEnded: (d) => `订阅周期至 ${d}（已结束）`,
        resetCredits: (n) => `${n} 次重置`,
        refreshing: '刷新中…',
        accountBalance: '账户余额',
        usageDefault: '用量卡默认显示',
        usageDefaultAuto: '自动（跟随当前模型）',
        usageDefaultHint:
          '默认「自动」会跟着当前在用的模型走（用 ChatGPT 就显示 ChatGPT，用 DeepSeek 就显示 DeepSeek）；点卡片里当前那家的名字重新读取，点卡片其它地方切换到下一家。',
        version: '版本',
      },
      en: {
        balance: 'Balance',
        paygo: 'Pay as you go',
        offPeak: 'Off-peak pricing',
        peak: 'Standard pricing',
        peakUnknown: 'Pricing window unknown',
        nextOffPeak: 'standard pricing in',
        nextPeak: 'off-peak pricing in',
        loading: 'Loading…',
        noBalance: 'No balance data',
        noUsage: 'No usage data',
        remaining: (n) => `${n}% left`,
        hour5: '5 hours',
        week: 'Weekly',
        subUntil: (d) => `Subscribed until ${d}`,
        subEnded: (d) => `Period ended ${d}`,
        resetCredits: (n) => `${n} reset${n === 1 ? '' : 's'}`,
        refreshing: 'Refreshing…',
        accountBalance: 'Account balance',
        usageDefault: 'Default usage card',
        usageDefaultAuto: 'Auto (follow current model)',
        usageDefaultHint:
          'Auto follows the model you are using (ChatGPT model → ChatGPT card, DeepSeek model → DeepSeek card). Click the provider name to refresh, click elsewhere on the card to switch.',
        version: 'Version',
      },
    }

    /** 语言标签归一化：zh-CN→zh，en-US→en，其余一律按中文。 */
    function normalizeLang(value) {
      const raw = typeof value === 'string' ? value.trim().toLowerCase() : ''
      if (!raw) return ''
      return raw.startsWith('en') ? 'en' : raw.startsWith('zh') ? 'zh' : ''
    }

    /** 读当前语言：先问 locale 服务，再看 <html lang>，都没有就中文。 */
    function detectLang(locale) {
      try {
        if (locale && typeof locale.getSnapshot === 'function') {
          const snapshot = locale.getSnapshot()
          const active = normalizeLang(snapshot && snapshot.active)
          if (active) return active
        }
      } catch {
        // locale 服务不可用就往下走
      }
      try {
        if (typeof document !== 'undefined' && document && document.documentElement) {
          const lang = normalizeLang(document.documentElement.lang)
          if (lang) return lang
        }
      } catch {
        // 无 DOM 就当中文
      }
      return 'zh'
    }

    /** 订阅语言变化：locale 服务能订阅就订阅，另外每 2 秒对一次 <html lang>（只在变了才重渲染）。 */
    function useLang(locale) {
      const [lang, setLang] = useState(() => detectLang(locale))
      useEffect(() => {
        let alive = true
        const sync = () => {
          if (!alive) return
          const next = detectLang(locale)
          setLang((prev) => (prev === next ? prev : next))
        }
        sync()
        let off = () => {}
        try {
          if (locale && typeof locale.subscribe === 'function') {
            const unsubscribe = locale.subscribe(sync)
            if (typeof unsubscribe === 'function') off = unsubscribe
          }
        } catch {
          // 订阅失败靠定时器兜底
        }
        const timer = typeof setInterval === 'function' ? setInterval(sync, 2000) : null
        return () => {
          alive = false
          try {
            off()
          } catch {
            // 忽略
          }
          if (timer !== null) clearInterval(timer)
        }
      }, [locale])
      return lang
    }

    /** 取文案；缺键回退中文，再缺返回 key（永不渲染 undefined）。 */
    function translate(lang, key, ...args) {
      const dict = I18N[lang] || I18N.zh
      const value = dict[key] !== undefined ? dict[key] : I18N.zh[key]
      if (typeof value === 'function') return value(...args)
      return typeof value === 'string' ? value : key
    }


    /**
     * 卡片兜底：任何一个子组件的渲染异常都不该让左下角整块消失。
     * 出错时至少留一行可读提示，用户还能刷新页面恢复。
     */
    class CardBoundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { failed: false }
      }
      static getDerivedStateFromError() {
        return { failed: true }
      }
      render() {
        if (this.state.failed) {
          return h(
            'div',
            { style: { fontSize: '11px', opacity: 0.6, padding: '6px 2px' }, title: 'usage card render error' },
            '暂无用量数据',
          )
        }
        return this.props.children
      }
    }

    function CodexUsageCard(props) {
      const wide = !(props && props.wide === false)
      const [usage, setUsage] = useState(null)
      const [rows, setRows] = useState([])
      const [dashboard, setDashboard] = useState(null)
      const [tab, setTab] = useState('')
      const [manualKey, setManualKey] = useState('')
      const [preferred, setPreferred] = useState('auto')
      const [currentModel, setCurrentModel] = useState(null)
      const [busy, setBusy] = useState(false)
      const [clock, setClock] = useState(() => Date.now())
      const mounted = useRef(true)
      const requestSeq = useRef(0)
      // 每类数据独立的响应序列：慢响应回来不能覆盖新的。
      const preferredSeq = useRef(0)
      const dashboardSeq = useRef(0)
      const chatgptSeq = useRef(0)
      const providersSeq = useRef(0)

      /** 本插件自己的 ChatGPT 用量。 */
      const loadChatgpt = useCallback(async () => {
        const seq = ++chatgptSeq.current
        try {
          const data = await request(API + '?usage=1', {
            headers: { Accept: 'application/json' },
            cache: 'no-store',
          })
          if (!mounted.current || seq !== chatgptSeq.current) return
          setUsage(data.usage && data.usage.available === true ? data.usage : null)
        } catch {
          if (!mounted.current || seq !== chatgptSeq.current) return
          setUsage(null)
        }
      }, [])

      /** 其它 AI 的余额/用量：借用量插件的只读接口（没装就静默降级为只有 ChatGPT）。 */
      const loadProviders = useCallback(async () => {
        const seq = ++providersSeq.current
        try {
          const response = await fetch(USAGE_ACCOUNTS_PATH, {
            headers: { Accept: 'application/json' },
            cache: 'no-store',
          })
          if (!response.ok) return
          const data = await response.json()
          if (!mounted.current || seq !== providersSeq.current) return
          setRows(Array.isArray(data.accounts) ? data.accounts : [])
        } catch {
          // 静默：没有该插件时只显示 ChatGPT
        }
      }, [])

      /**
       * 跟随当前模型：走轻量 meta 端点（3 秒轮询），只回 { currentModel, defaultUsageTab }，
       * 不拉完整快照（不重复暴露邮箱/套餐，也不触发凭证同步副作用）。
       */
      const loadPreferred = useCallback(async () => {
        const seq = ++preferredSeq.current
        try {
          const data = await request(API + '?meta=1', {
            headers: { Accept: 'application/json' },
            cache: 'no-store',
          })
          // 只有真正拿到 meta 形状才算成功：旧宿主不认 ?meta=1 时会返回完整快照，
          // 那种响应没有顶层 currentModel，必须回退，否则会一直停在默认 tab。
          const isMeta = data && data.ok === true && data.currentModel !== undefined && data.auth === undefined
          if (isMeta) {
            if (!mounted.current || seq !== preferredSeq.current) return
            setCurrentModel(data.currentModel || null)
            if (typeof data.defaultUsageTab === 'string' && data.defaultUsageTab) {
              setPreferred(data.defaultUsageTab)
            }
            return
          }
          // 旧宿主不认 meta，直接把整份快照返回了：就地用它，免得再打一次。
          if (data && data.ok === true && data.global) {
            if (!mounted.current || seq !== preferredSeq.current) return
            if (typeof data.global.defaultUsageTab === 'string' && data.global.defaultUsageTab) {
              setPreferred(data.global.defaultUsageTab)
            }
            setCurrentModel(data.global.currentModel || null)
            return
          }
        } catch {
          // 网络失败走下面的完整快照回退
        }
        const full = ++preferredSeq.current
        try {
          const data = await loadState('')
          if (!mounted.current || full !== preferredSeq.current) return
          setPreferred((data.global && data.global.defaultUsageTab) || 'auto')
          setCurrentModel((data.global && data.global.currentModel) || null)
        } catch {
          // 读不到配置就保持上一次的值，别把 auto 打回 chatgpt
        }
      }, [])

      /** DeepSeek 余额 + 当前峰谷时段（本插件自己算，不依赖别的插件）。 */
      const loadDashboard = useCallback(async (force = false) => {
        const seq = ++dashboardSeq.current
        try {
          const data = await request(API + '?dashboard=1' + (force ? '&force=1' : ''), {
            headers: { Accept: 'application/json' },
            cache: 'no-store',
          })
          if (!mounted.current || seq !== dashboardSeq.current) return
          setDashboard({ peak: data.peak || null, deepseek: data.deepseek || null })
        } catch {
          if (!mounted.current) return
          setDashboard(null)
        }
      }, [])

      const reload = useCallback(
        async (force = false) => {
          const seq = ++requestSeq.current
          setBusy(true)
          await Promise.all([loadChatgpt(), loadProviders(), loadPreferred(), loadDashboard(force)])
          if (mounted.current && seq === requestSeq.current) {
            setBusy(false)
            setClock(Date.now())
          }
        },
        [loadChatgpt, loadProviders, loadPreferred, loadDashboard],
      )

      useEffect(() => {
        mounted.current = true
        if (!wide) return undefined
        void reload()
        const timer = setInterval(() => {
          if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
          void reload()
        }, 60_000)
        // auto 模式要「跟着当前模型走」：3 秒读一次本地快照，换模型几乎立刻跟上。
        const followTimer = setInterval(() => {
          if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
          void loadPreferred()
        }, 3_000)
        // 余额要「准」：10 秒单独刷一次看板（宿主侧也有 10 秒缓存，不会打爆上游）。
        const dashTimer = setInterval(() => {
          if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
          void loadDashboard()
        }, 10_000)
        // 峰谷倒计时需要比整体刷新更勤一点（只改本地时钟，不请求网络）。
        const clockTimer = setInterval(() => setClock(Date.now()), 30_000)
        const onVisible = () => {
          if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
            void loadPreferred()
            void loadDashboard(true)
            void reload()
          }
        }
        if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible)
        return () => {
          mounted.current = false
          clearInterval(timer)
          clearInterval(followTimer)
          clearInterval(dashTimer)
          clearInterval(clockTimer)
          if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible)
        }
      }, [loadDashboard, loadPreferred, reload, wide])

      /** 可切换的 AI 列表：ChatGPT 第一，DeepSeek 第二（本插件自己算），其余来自用量插件（若装了）。 */
      const tabs = useMemo(() => {
        const list = [
          { id: 'chatgpt', label: 'ChatGPT', kind: 'chatgpt', row: null },
          { id: 'deepseek', label: 'DeepSeek', kind: 'dashboard', row: null },
        ]
        const seen = new Set(['chatgpt', 'openai-codex', 'deepseek'])
        for (const row of rows) {
          if (!row || row.status !== 'ok' || typeof row.id !== 'string') continue
          // DeepSeek 家族已经由上面的本插件看板负责，避免出现重复项。
          if (row.id.startsWith('deepseek')) continue
          if (seen.has(row.id)) continue
          seen.add(row.id)
          list.push({ id: row.id, label: usageLabelOf(row), kind: row.kind, row })
        }
        return list
      }, [rows])

      /** auto 模式：按「当前在用的模型」决定先显示哪一家。 */
      const autoTabId = useMemo(() => {
        const provider = (currentModel && currentModel.provider) || ''
        if (provider === 'openai-codex' || provider === 'chatgpt-codex') return 'chatgpt'
        if (provider.startsWith('deepseek')) return 'deepseek'
        return tabs.some((item) => item.id === provider) ? provider : 'chatgpt'
      }, [currentModel, tabs])

      const preferredId = preferred === 'auto' ? autoTabId : preferred
      // 手动覆盖只在「同一个模型」下有效：换模型就自动回到跟随，不会长期压住 auto。
      const modelKey = currentModel ? `${currentModel.provider}|${currentModel.model}` : ''
      const manualValid = Boolean(tab) && (!manualKey || manualKey === modelKey)
      const activeId = manualValid && tabs.some((item) => item.id === tab)
        ? tab
        : tabs.some((item) => item.id === preferredId)
          ? preferredId
          : 'chatgpt'
      const active = tabs.find((item) => item.id === activeId) || tabs[0]

      /** 点标题文字 = 刷新当前这一家（绕过宿主缓存，立刻打上游）。 */
      const refreshActive = useCallback(async () => {
        await reload(true)
      }, [reload])

      /** 点卡片空白处 = 切到下一家（ChatGPT → DeepSeek → 其它 AI → ChatGPT）。 */
      const cycleTab = useCallback(async () => {
        const index = tabs.findIndex((item) => item.id === activeId)
        const next = tabs[(index + 1) % tabs.length] || tabs[0]
        if (!next || next.id === activeId) {
          await reload()
          return
        }
        // 只做临时覆盖，不写 localStorage：换模型时会自动回到「跟随当前模型」。
        setTab(next.id)
        setManualKey(modelKey)
        await reload()
      }, [activeId, modelKey, reload, tabs])

      if (!wide) return null

      const windows = Array.isArray(usage && usage.windows) ? usage.windows : []
      const planText = (usage && usage.planLabel) || ''
      const subscription = (usage && usage.subscription) || {}
      const untilDate = formatDate(subscription.activeUntil)
      const today = new Date().toISOString().slice(0, 10)
      const untilText = untilDate
        ? untilDate >= today
          ? t('subUntil', untilDate)
          : t('subEnded', untilDate)
        : ''
      const resetCredits =
        usage && Number.isFinite(usage.resetCredits) && usage.resetCredits > 0 ? usage.resetCredits : 0

      /** 一根「剩余百分比」进度条，ChatGPT 与其它 AI 共用。 */
      const bar = (key, label, remaining, hint) => {
        const value = Math.max(0, Math.min(100, Number(remaining) || 0))
        const low = value <= 15
        return h(
          'div',
          { key, style: usageStyles.row, title: hint },
          h('span', { style: usageStyles.label }, label),
          h(
            'div',
            { style: usageStyles.track },
            h('div', {
              style: {
                ...usageStyles.fill,
                width: `${value}%`,
                background: low ? '#d9534f' : 'var(--dsw-specific-accent, #4d6bfe)',
              },
            }),
          ),
          h('span', { style: usageStyles.percent }, `剩 ${Math.round(value)}%`),
        )
      }

      /** 其它 AI 的卡片主体：余额类显示金额，用量类显示各窗口剩余。 */
      const bodyFor = (item) => {
        if (item.kind === 'dashboard') {
          const data = dashboard && dashboard.deepseek
          const peak = dashboard && dashboard.peak
          if (!data && !peak) {
            return [
              h(
                'div',
                { key: 'empty', style: { ...usageStyles.hint, fontSize: '11px' } },
                busy ? t('loading') : t('noBalance'),
              ),
            ]
          }
          const total = data && Number.isFinite(Number(data.total)) ? Number(data.total) : null
          const symbol = data && data.currency === 'CNY' ? '¥' : data && data.currency === 'USD' ? '$' : ''
          const amount = total === null ? '—' : `${symbol}${total.toFixed(2)}`
          const remainMs = peak && Number.isFinite(Number(peak.nextChangeAt)) ? Number(peak.nextChangeAt) - clock : 0
          const countdown = remainMs > 60_000 ? formatCountdown(remainMs) : ''
          const cheap = peak ? peak.isPeak === false : false
          return [
            h(
              'div',
              { key: 'balance', style: { display: 'flex', alignItems: 'baseline', gap: '6px' } },
              h('span', { style: { ...usageStyles.brand, fontSize: '19px', letterSpacing: 0 } }, amount),
              h('span', { style: { ...usageStyles.hint, fontSize: '10px' } }, t('balance')),
            ),
            h(
              'div',
              { key: 'peak', style: { display: 'flex', alignItems: 'center', gap: '5px' } },
              h('span', {
                style: {
                  width: '6px',
                  height: '6px',
                  borderRadius: '50%',
                  flex: 'none',
                  background: peak ? (cheap ? '#3f9e6e' : '#e0913f') : 'var(--dsw-alias-border-strong, #999)',
                },
              }),
              h(
                'span',
                { style: { ...usageStyles.hint, fontSize: '10px' } },
                peak
                  ? `${cheap ? t('offPeak') : t('peak')}${
                      countdown ? ` · ${cheap ? t('nextOffPeak') : t('nextPeak')} ${countdown}` : ''
                    }`
                  : t('peakUnknown'),
              ),
            ),
            data && data.error
              ? h('div', { key: 'err', style: { ...usageStyles.hint, fontSize: '10px', opacity: 0.5 } }, String(data.error))
              : null,
          ]
        }
        const row = item.row
        if (!row) {
          // ChatGPT：本插件自己的数据
          if (!usage) {
            return [h('div', { key: 'empty', style: usageStyles.hint }, busy ? t('loading') : t('noUsage'))]
          }
          return [
            ...windows.map((window) => {
              const used = Math.max(0, Math.min(100, Number(window.usedPercent) || 0))
              return bar(
                window.id || window.label,
                window.label || '',
                100 - used,
                `${window.label || ''}：已用 ${Math.round(used)}%，剩余 ${Math.round(100 - used)}%${
                  window.resetAt ? `，${formatReset(window.resetAt)} 重置` : ''
                }`,
              )
            }),
            untilText ? h('div', { key: 'until', style: usageStyles.hint }, untilText) : null,
          ]
        }
        const balance = row.balance || {}
        if (row.kind === 'balance') {
          const total = Number(balance.total)
          const amount = Number.isFinite(total) ? `${balance.currency === 'CNY' ? '¥' : ''}${total.toFixed(2)}` : '—'
          return [
            h('div', { key: 'balance', style: { ...usageStyles.brand, fontSize: '20px' } }, amount),
            h('div', { key: 'hint', style: usageStyles.hint }, row.reason ? String(row.reason) : t('accountBalance')),
          ]
        }
        const list = Array.isArray(row.usage && row.usage.windows) ? row.usage.windows : []
        if (list.length === 0) {
          return [h('div', { key: 'empty', style: usageStyles.hint }, row.reason ? String(row.reason) : t('noUsage'))]
        }
        return list.map((window) => {
          const percent = Number(window.percent)
          const remaining = Number.isFinite(percent) ? 100 - percent : 0
          return bar(
            window.key,
            window.key === '5h' ? t('hour5') : window.key === '7d' ? t('week') : String(window.key || ''),
            remaining,
            `${window.key || ''}：已用 ${Math.round(percent || 0)}%，剩余 ${Math.round(remaining)}%`,
          )
        })
      }

      return h(
        'div',
        {
          role: 'status',
          onClick: () => void cycleTab(),
          title: `点击卡片切换到下一家（当前 ${active.label}）`,
          style: usageStyles.card,
        },
        h(
          'div',
          { style: usageStyles.head },
          // 点这一行的名字 = 刷新当前这一家；点卡片其它地方 = 切换。
          h(
            'span',
            {
              onClick: (event) => {
                if (event && typeof event.stopPropagation === 'function') event.stopPropagation()
                void refreshActive()
              },
              title: `${active.label}：点击刷新`,
              style: { ...usageStyles.brand, cursor: 'pointer' },
            },
            active.label,
          ),
          active.kind === 'chatgpt' && planText ? h('span', { style: usageStyles.badge }, planText) : null,
          active.kind === 'dashboard' ? h('span', { style: usageStyles.badge }, t('paygo')) : null,
          h(
            'span',
            { style: { marginLeft: 'auto', fontSize: '10px', opacity: 0.45 } },
            resetCredits > 0 && active.kind === 'chatgpt'
              ? t('resetCredits', resetCredits)
              : busy
                ? t('refreshing')
                : '',
          ),
        ),
        ...bodyFor(active),
      )
    }

    /** 设置 →「ChatGPT」页。 */
    function CodexSettings(props) {
      const [auth, setAuth] = useState(null)
      const [defaultModel, setDefaultModel] = useState('')
      const [autoConsult, setAutoConsult] = useState(true)
      const [allowLan, setAllowLan] = useState(false)
      const [delegateLight, setDelegateLight] = useState(false)
      const [gptNameDetect, setGptNameDetect] = useState(false)
      const [defaultUsageTab, setDefaultUsageTab] = useState('auto')
      const [usageTabOptions, setUsageTabOptions] = useState([
        { id: 'auto', label: '自动（跟随当前模型）' },
        { id: 'chatgpt', label: 'ChatGPT' },
        { id: 'deepseek', label: 'DeepSeek' },
      ])
      const [currentModelLabel, setCurrentModelLabel] = useState('')
      const [pluginVersion, setPluginVersion] = useState('')
      const [deepseekModel, setDeepseekModel] = useState('')
      const [deepseekModels, setDeepseekModels] = useState([])
      const [deepseekModelsError, setDeepseekModelsError] = useState('')
      const [models, setModels] = useState([])
      const [modelsError, setModelsError] = useState('')
      const [error, setError] = useState('')
      const [notice, setNotice] = useState('')
      const [busy, setBusy] = useState(false)
      const [logging, setLogging] = useState(false)
      const [loginUrl, setLoginUrl] = useState('')
      const [network, setNetwork] = useState(null)
      const [checking, setChecking] = useState(false)
      const [resetInfo, setResetInfo] = useState(null)
      const [resetting, setResetting] = useState(false)
      const pollRef = useRef(null)
      const initialized = useRef(false)

      const loadModels = useCallback(async (force) => {
        try {
          // force 走 POST（服务端强制刷新，跳过 5 分钟缓存）；否则用 GET 的缓存路径。
          const data = force
            ? (await postOp({ op: 'listModels' })).result || {}
            : await request(API + '?models=1', { headers: { Accept: 'application/json' }, cache: 'no-store' })
          setModels(Array.isArray(data.models) ? data.models : [])
          setModelsError(data.error || '')
        } catch (modelsFailure) {
          setModelsError(String(modelsFailure.message || modelsFailure))
        }
      }, [])

      const loadResets = useCallback(async () => {
        try {
          const data = await request(API + '?resets=1', {
            headers: { Accept: 'application/json' },
            cache: 'no-store',
          })
          setResetInfo(data.result || null)
        } catch {
          setResetInfo(null)
        }
      }, [])

      /** DeepSeek 侧模型列表（供「轻任务委派」选择，支持自动选择）。 */
      const loadDeepseekModels = useCallback(async () => {
        try {
          const data = await request(API + '?deepseekModels=1', {
            headers: { Accept: 'application/json' },
            cache: 'no-store',
          })
          setDeepseekModels(Array.isArray(data.models) ? data.models : [])
          setDeepseekModelsError(data.error || '')
        } catch (deepseekFailure) {
          setDeepseekModelsError(String(deepseekFailure.message || deepseekFailure))
        }
      }, [])

      /** 用量卡「默认展示」的候选：ChatGPT + DeepSeek（本插件自带）+ 其它已配置的 AI。 */
      const loadUsageTabOptions = useCallback(async () => {
        const base = [
          { id: 'auto', label: '自动（跟随当前模型）' },
          { id: 'chatgpt', label: 'ChatGPT' },
          { id: 'deepseek', label: 'DeepSeek' },
        ]
        try {
          const response = await fetch(USAGE_ACCOUNTS_PATH, {
            headers: { Accept: 'application/json' },
            cache: 'no-store',
          })
          if (!response.ok) {
            setUsageTabOptions(base)
            return
          }
          const data = await response.json()
          const rows = Array.isArray(data.accounts) ? data.accounts : []
          const seen = new Set(['chatgpt', 'openai-codex', 'deepseek'])
          const list = [...base]
          for (const row of rows) {
            if (!row || row.status !== 'ok' || typeof row.id !== 'string' || seen.has(row.id)) continue
            if (row.id.startsWith('deepseek')) continue
            seen.add(row.id)
            list.push({ id: row.id, label: usageLabelOf(row) })
          }
          setUsageTabOptions(list)
        } catch {
          setUsageTabOptions(base)
        }
      }, [])

      const loadAll = useCallback(async () => {
        try {
          const data = await loadState('')
          setAuth(data.auth || { loggedIn: false })
          if (typeof data.pluginVersion === 'string' && data.pluginVersion) setPluginVersion(data.pluginVersion)
          if (!initialized.current) {
            initialized.current = true
            setDefaultModel(data.global.defaultModel || '')
            setAutoConsult(data.global.autoConsult !== false)
            setAllowLan(data.global.allowLanAccess === true)
            setDelegateLight(data.global.delegateLightTasks === true)
            setGptNameDetect(data.global.gptNameDetect === true)
            setDefaultUsageTab(data.global.defaultUsageTab || 'chatgpt')
            setDeepseekModel(data.global.deepseekModel || '')
          }
          if (data.auth && data.auth.loggedIn) {
            await loadModels(false)
            await loadResets()
          }
          await loadDeepseekModels()
          await loadUsageTabOptions()
        } catch (loadFailure) {
          setError(String(loadFailure.message || loadFailure))
        }
      }, [loadModels, loadResets, loadDeepseekModels, loadUsageTabOptions])

      useEffect(() => {
        void loadAll()
        return () => {
          if (pollRef.current) {
            clearInterval(pollRef.current)
            pollRef.current = null
          }
        }
      }, [loadAll])

      const stopPolling = useCallback(() => {
        if (pollRef.current) {
          clearInterval(pollRef.current)
          pollRef.current = null
        }
        setLogging(false)
      }, [])

      /** 复制授权链接（浏览器拦截弹窗时的兜底；不把长 URL 铺在界面上）。 */
      const copyLoginUrl = useCallback(async () => {
        if (!loginUrl) return
        try {
          if (
            typeof navigator !== 'undefined' &&
            navigator.clipboard &&
            typeof navigator.clipboard.writeText === 'function'
          ) {
            await navigator.clipboard.writeText(loginUrl)
            setNotice('授权链接已复制，粘贴到浏览器地址栏打开即可。')
            return
          }
          throw new Error('剪贴板不可用')
        } catch {
          if (typeof window !== 'undefined') window.prompt('复制这个授权链接：', loginUrl)
        }
      }, [loginUrl])

      const startLogin = useCallback(async () => {
        setError('')
        setNotice('')
        setLogging(true)
        try {
          const data = await postOp({ op: 'login' })
          const url = data.result && data.result.url
          if (!url) throw new Error('没有拿到 OpenAI 授权地址')
          setLoginUrl(url)
          if (typeof window !== 'undefined') {
            // noopener 会让 window.open 永远返回 null，不能据此判断是否被拦截。
            try {
              window.open(url, '_blank', 'noopener')
            } catch {
              // 被浏览器直接拒绝时走下面的复制兜底
            }
            setNotice('已尝试打开 OpenAI 登录页；若没有弹出，点下方「点我复制授权链接」。')
          }
          if (pollRef.current) clearInterval(pollRef.current)
          let attempts = 0
          pollRef.current = setInterval(async () => {
            attempts += 1
            try {
              const status = await request(API + '?auth=1', { headers: { Accept: 'application/json' }, cache: 'no-store' })
              if (status.auth && status.auth.loggedIn) {
                stopPolling()
                setAuth(status.auth)
                setNotice('登录成功，已获取模型列表。')
                await loadModels(true)
                await loadResets()
                return
              }
            } catch {
              // 轮询失败继续等
            }
            if (attempts > 150) {
              stopPolling()
              setError('登录等待超时，请重试。')
            }
          }, 2000)
        } catch (loginFailure) {
          stopPolling()
          setError('发起登录失败：' + String(loginFailure.message || loginFailure))
        }
      }, [loadModels, loadResets, stopPolling])

      const logout = useCallback(async () => {
        setBusy(true)
        setError('')
        setNotice('')
        try {
          await postOp({ op: 'logout' })
          setAuth({ loggedIn: false })
          setModels([])
          setModelsError('')
          stopPolling()
          setNotice('已退出 OpenAI 登录。')
        } catch (logoutFailure) {
          setError(String(logoutFailure.message || logoutFailure))
        } finally {
          setBusy(false)
        }
      }, [stopPolling])

      const refreshModels = useCallback(async () => {
        setError('')
        setNotice('')
        try {
          const data = await postOp({ op: 'listModels' })
          const result = data.result || {}
          setModels(Array.isArray(result.models) ? result.models : [])
          setModelsError(result.error || '')
          setNotice(`已从 OpenAI 拉取 ${Array.isArray(result.models) ? result.models.length : 0} 个模型。`)
        } catch (modelsFailure) {
          setError('拉取模型列表失败：' + String(modelsFailure.message || modelsFailure))
        }
      }, [])

      const save = useCallback(async () => {
        setBusy(true)
        setError('')
        setNotice('')
        try {
          await postOp({
            op: 'setGlobal',
            patch: {
              defaultModel,
              autoConsult,
              allowLanAccess: allowLan,
              delegateLightTasks: delegateLight,
              deepseekModel,
              gptNameDetect,
              defaultUsageTab,
            },
          })
          setNotice('已保存并生效。')
        } catch (saveFailure) {
          setError(String(saveFailure.message || saveFailure))
        } finally {
          setBusy(false)
        }
      }, [defaultModel, autoConsult, allowLan, delegateLight, deepseekModel, gptNameDetect, defaultUsageTab])

      const checkNetwork = useCallback(async () => {
        setChecking(true)
        setError('')
        setNotice('')
        try {
          const data = await postOp({ op: 'testNetwork' })
          setNetwork(data.result || null)
        } catch (networkFailure) {
          setError('外网连通性检查失败：' + String(networkFailure.message || networkFailure))
        } finally {
          setChecking(false)
        }
      }, [])

      /** 使用一张重置卡（不可撤销，二次确认后调用）。 */
      const consumeReset = useCallback(async () => {
        const count = resetInfo && Number(resetInfo.availableCount) > 0 ? Number(resetInfo.availableCount) : 0
        if (count <= 0) return
        if (typeof window !== 'undefined') {
          const ok = window.confirm(
            `确定使用一张重置卡吗？\n\n将立即重置 5 小时 / 每周限流窗口，操作不可撤销。\n当前可用：${count} 张`,
          )
          if (!ok) return
        }
        setResetting(true)
        setError('')
        setNotice('')
        try {
          const data = await postOp({ op: 'consumeReset' })
          const result = data.result || {}
          const messages = {
            reset: `已重置 ${result.windowsReset || 1} 个限流窗口。`,
            nothing_to_reset: '当前没有需要重置的限流窗口（额度还充足），本次未消耗重置卡。',
            no_credit: '没有可用的重置卡。',
            already_redeemed: '这次重置请求此前已完成（幂等），按成功处理。',
          }
          setNotice(messages[result.code] || `重置结果：${result.code || 'unknown'}`)
          await loadResets()
        } catch (resetFailure) {
          setError('重置失败：' + String(resetFailure.message || resetFailure))
        } finally {
          setResetting(false)
        }
      }, [resetInfo, loadResets])

      if (!auth) {
        // 加载失败时必须把原因显示出来，否则页面会永远停在「加载中」。
        return h(
          'div',
          { style: styles.card },
          h('div', { style: styles.title }, ' ChatGPT 设置'),
          error
            ? h('div', { style: styles.error }, '加载失败：' + error)
            : h('div', { style: styles.hint }, '加载中…'),
          error
            ? h(
                'div',
                { style: styles.row },
                h('button', { type: 'button', style: styles.button, onClick: () => void loadAll() }, '重试'),
              )
            : null,
        )
      }

      const loggedIn = auth.loggedIn === true
      const untilDate = formatDate(auth.activeUntil)
      const today = new Date().toISOString().slice(0, 10)
      const untilText = untilDate
        ? untilDate >= today
          ? t('subUntil', untilDate)
          : t('subEnded', untilDate)
        : ''
      const modelOptions = [...new Set([...(defaultModel ? [defaultModel] : []), ...models.map((item) => item.slug)])]

      return h(
        'div',
        { style: styles.page },
        // ── 插件版本 ────────────────────────────────────────────────
        h(
          'div',
          { style: { ...styles.hint, display: 'flex', alignItems: 'center', gap: '6px' } },
          h('span', { style: styles.badge }, `dsh-codex-gpt ${pluginVersion || '—'}`),
          h('span', { style: { opacity: 0.6 } }, t('version')),
        ),
        // ── OpenAI 账号 ──────────────────────────────────────────────
        h(
          'div',
          { style: styles.card },
          h('div', { style: styles.title }, '🔐 OpenAI 账号'),
          loggedIn
            ? h(
                'div',
                { style: styles.row },
                h('span', { style: styles.badge }, auth.planLabel || '已登录'),
                h('span', { style: { fontSize: '13px' } }, auth.email || '（未返回邮箱）'),
                untilText ? h('span', { style: styles.hint }, untilText) : null,
                h(
                  'button',
                  { type: 'button', style: { ...styles.button, marginLeft: 'auto' }, onClick: logout, disabled: busy },
                  '退出登录',
                ),
              )
            : h(
                'div',
                { style: styles.row },
                h(
                  'button',
                  { type: 'button', style: styles.buttonPrimary, onClick: startLogin, disabled: logging },
                  logging ? '等待授权…' : '登录 OpenAI 账号',
                ),
                h('span', { style: styles.hint }, '点击后会打开 OpenAI 官网，登录并同意授权即可；无需手动填写 API Key。'),
              ),
          h(
            'div',
            { style: styles.hint },
            '登录使用与 Codex CLI 相同的官方 OAuth 客户端，凭证只保存在本机（$DSH_HOME/dsh-codex-auth.json）。',
          ),
          h(
            'div',
            { style: styles.row },
            h(
              'button',
              { type: 'button', style: styles.button, onClick: checkNetwork, disabled: checking },
              checking ? '检查中…' : '外网连通性检查',
            ),
            h(
              'button',
              { type: 'button', style: styles.button, onClick: startLogin, disabled: logging || !loggedIn },
              '重新登录',
            ),
          ),
          loginUrl
            ? h(
                'div',
                { style: styles.row },
                h(
                  'button',
                  {
                    type: 'button',
                    style: styles.button,
                    onClick: copyLoginUrl,
                    title: '复制完整授权链接（链接较长，桌面端窗口里放不下）',
                  },
                  '🔗 点我复制授权链接',
                ),
                h('span', { style: styles.hint }, '复制后粘贴到浏览器地址栏即可完成授权。'),
              )
            : null,
          network
            ? h(
                'div',
                { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
                h(
                  'div',
                  { style: styles.hint },
                  `外网连通性：${network.reachable}/${network.total} 条链路可达（能拿到 HTTP 响应即算可达）`,
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
        ),
        // ── Codex 设置 ──────────────────────────────────────────────
        h(
          'div',
          { style: styles.card },
          h('div', { style: styles.title }, '🛠️ ChatGPT 设置'),
          h(
            'div',
            { style: styles.row },
            h('span', { style: styles.label }, '默认模型'),
            h(
              'select',
              {
                style: styles.select,
                value: defaultModel,
                onChange: (event) => setDefaultModel(event.target.value),
                disabled: !loggedIn,
              },
              h('option', { value: '' }, '自动选择（按任务自动挑）'),
              modelOptions.length === 0
                ? h('option', { value: '__none__', disabled: true }, '登录后自动获取')
                : modelOptions.map((slug) => h('option', { key: slug, value: slug }, slug)),
            ),
            h(
              'button',
              { type: 'button', style: styles.button, onClick: refreshModels, disabled: !loggedIn },
              '刷新模型列表',
            ),
          ),
          models.length > 0
            ? h(
                'div',
                { style: styles.hint },
                `可选模型 ${models.length} 个：${models
                  .slice(0, 6)
                  .map((item) => item.slug + (item.contextWindow ? `（${Math.round(item.contextWindow / 1000)}K）` : ''))
                  .join('、')}${models.length > 6 ? '…' : ''}`,
              )
            : modelsError
              ? h('div', { style: styles.error }, '模型列表不可用：' + modelsError)
              : null,
          h(
            'div',
            { style: styles.row },
            h('span', { style: styles.label }, '自主调用'),
            h(
              'label',
              { style: { display: 'inline-flex', alignItems: 'center', gap: '8px', cursor: 'pointer' } },
              h(ToggleBox, { on: autoConsult, onClick: () => setAutoConsult(!autoConsult) }),
              h(
                'span',
                { onClick: () => setAutoConsult(!autoConsult), style: { fontSize: '13px' } },
                autoConsult ? '已授权会话可按任务强度自主调用' : '仅在用户明确要求时调用',
              ),
            ),
          ),
          h(
            'div',
            { style: styles.row },
            h(ToggleBox, { on: allowLan, onClick: () => setAllowLan(!allowLan) }),
            h(
              'span',
              { onClick: () => setAllowLan(!allowLan), style: { fontSize: '13px', cursor: 'pointer' } },
              '允许局域网设备只读查看本插件状态（写操作始终仅限本机）',
            ),
          ),
          h(
            'div',
            { style: styles.row },
            h(ToggleBox, { on: delegateLight, onClick: () => setDelegateLight(!delegateLight) }),
            h(
              'span',
              { onClick: () => setDelegateLight(!delegateLight), style: { fontSize: '13px', cursor: 'pointer' } },
              'GPT 模式下轻任务交 DeepSeek V4.1 收尾（独立开关）',
            ),
          ),
          delegateLight
            ? h(
                'div',
                { style: styles.hint },
                '开启后，ChatGPT 处理会话时可以把格式化、整理、检索归纳、润色等轻任务交给 DeepSeek V4.1 完成，再整合进回答；复杂任务仍由 GPT 直接处理。',
              )
            : null,
          delegateLight
            ? h(
                'div',
                { style: styles.row },
                h('span', { style: styles.label }, 'DeepSeek 模型'),
                h(
                  'select',
                  {
                    style: styles.select,
                    value: deepseekModel,
                    onChange: (event) => setDeepseekModel(event.target.value),
                  },
                  h('option', { value: '' }, '自动选择（按任务自动挑）'),
                  deepseekModel && !deepseekModels.some((item) => item.id === deepseekModel)
                    ? h('option', { value: deepseekModel }, deepseekModel)
                    : null,
                  deepseekModels.length === 0
                    ? h('option', { value: '__none__', disabled: true }, deepseekModelsError || '加载中…')
                    : deepseekModels.map((item) =>
                        h('option', { key: item.id, value: item.id }, item.name || item.id),
                      ),
                ),
                h('button', { type: 'button', style: styles.button, onClick: loadDeepseekModels }, '刷新'),
              )
            : null,
          h(
            'div',
            { style: styles.row },
            h(ToggleBox, { on: gptNameDetect, onClick: () => setGptNameDetect(!gptNameDetect) }),
            h(
              'span',
              { onClick: () => setGptNameDetect(!gptNameDetect), style: { fontSize: '13px', cursor: 'pointer' } },
              '按模型名识别 GPT（保险开关，默认关闭）',
            ),
          ),
          h(
            'div',
            { style: styles.hint },
            gptNameDetect
              ? '已开启：即使模型来自其他 provider，只要模型 id 形如 gpt-* / o3-*，输入框胶囊也会按「GPT」识别（显示 DeepSeek）。'
              : '关闭时只认本插件的 ChatGPT provider；开启后才会额外按模型名判断，避免把别家同名模型误认成本插件的 GPT。',
          ),
          h(
            'div',
            { style: styles.row },
            h('span', { style: styles.label }, t('usageDefault')),
            h(
              'select',
              {
                value: defaultUsageTab,
                onChange: (event) => setDefaultUsageTab(event.target.value),
                style: styles.select,
              },
              usageTabOptions.map((item) =>
                h('option', { key: item.id, value: item.id }, item.id === 'auto' ? t('usageDefaultAuto') : item.label),
              ),
            ),
          ),
          h('div', { style: styles.hint }, t('usageDefaultHint')),
          h(
            'div',
            { style: styles.row },
            h(
              'button',
              { type: 'button', style: styles.buttonPrimary, onClick: save, disabled: busy },
              busy ? '保存中…' : '保存',
            ),
          ),
          notice ? h('div', { style: styles.notice }, notice) : null,
          error ? h('div', { style: styles.error }, error) : null,
        ),
        // ── 重置额度（重置卡） ──────────────────────────────────────
        h(
          'div',
          { style: styles.card },
          h('div', { style: styles.title }, '🎟️ 重置额度（重置卡）'),
          h(
            'div',
            { style: styles.hint },
            loggedIn
              ? resetInfo
                ? `当前可用 ${Number(resetInfo.availableCount) || 0} 张重置卡${
                    resetInfo.credits && resetInfo.credits[0] && resetInfo.credits[0].expiresAt
                      ? `，最近一张 ${formatDate(resetInfo.credits[0].expiresAt)} 过期`
                      : ''
                  }。`
                : '正在读取重置卡…'
              : '登录 OpenAI 账号后可以查看和使用重置卡。',
          ),
          resetInfo && Array.isArray(resetInfo.credits) && resetInfo.credits.length > 0
            ? h(
                'div',
                { style: { display: 'flex', flexDirection: 'column', gap: '3px' } },
                resetInfo.credits.slice(0, 3).map((credit) =>
                  h(
                    'div',
                    { key: credit.id, style: { fontSize: '12px', opacity: 0.7 } },
                    `· ${credit.title}${credit.expiresAt ? `（${formatDate(credit.expiresAt)} 过期）` : ''}`,
                  ),
                ),
              )
            : null,
          h(
            'div',
            { style: styles.row },
            h(
              'button',
              {
                type: 'button',
                style: styles.buttonPrimary,
                onClick: consumeReset,
                disabled: !loggedIn || resetting || !resetInfo || Number(resetInfo.availableCount) <= 0,
              },
              resetting ? '重置中…' : '使用一张重置额度',
            ),
            h(
              'button',
              { type: 'button', style: styles.button, onClick: loadResets, disabled: !loggedIn },
              '刷新重置卡',
            ),
          ),
          h(
            'div',
            { style: styles.hint },
            '重置会立即恢复 5 小时 / 每周的限流窗口，操作不可撤销；只在额度确实受限时使用。',
          ),
        ),
        // ── 使用方式 ────────────────────────────────────────────────
        h(
          'div',
          { style: styles.card },
          h('div', { style: styles.title }, '使用方式'),
          h('div', { style: styles.hint }, '1. 点「登录 OpenAI 账号」，在官网完成授权（不用填 Key）。'),
          h('div', { style: styles.hint }, '2. 登录后模型列表会自动从 OpenAI 拉取，选一个默认模型并保存。'),
          h('div', { style: styles.hint }, '3. 回到对话，点输入框左侧胶囊按钮授权当前会话（变蓝 = 已授权）。按钮名随当前模型变化：本插件 ChatGPT 时显示「DeepSeek」，其他模型时显示「ChatGPT」。'),
          h('div', { style: styles.hint }, '4. 之后遇到高难度任务，DeepSeek 会自主调用 ChatGPT；未授权的会话不产生任何额度消耗。'),
        ),
      )
    }

    return {
      name: 'codex-client',
      inject: ['slots'],
      apply(ctx) {
        // locale 服务只取一次：渲染时不再访问 ctx 上的 getter，避免取值本身把渲染弄崩。
        // 拿不到就回退中文（组件内另有 <html lang> 兜底探测）。
        const localeService = (() => {
          try {
            return ctx.locale || null
          } catch {
            return null
          }
        })()
        ctx.slots.inject('conversation.input.left', () =>
          ctx.slots.register(
            {
              name: 'conversation.input.left',
              id: 'codex-toggle',
              order: 4,
              inject: (sessionId) => {
                const directory = resolveModelDirectory(ctx, sessionId)
                return {
                  sessionId,
                  directoryStore: directory ? directory.store : null,
                  loadModels: directory ? () => directory.load().catch(() => {}) : null,
                  // 组件内的兜底解析器：slot 注入时机拿不到目录时也能自己再解析一次。
                  resolveDirectory: () => resolveModelDirectory(ctx, sessionId),
                }
              },
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
              label: 'ChatGPT',
            },
            (props) => h(CodexSettings, { locale: localeService }),
          ),
        )
        ctx.slots.inject('sidebar.footer.action', () =>
          ctx.slots.register(
            {
              name: 'sidebar.footer.action',
              id: 'dsh-codex-usage',
              order: 101,
              label: 'ChatGPT 用量',
            },
            (props) =>
              h(
                CardBoundary,
                null,
                h(CodexUsageCard, { wide: props && props.wide, locale: localeService }),
              ),
          ),
        )
      },
    }
  },
})
