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
      const lang = useLang(slotProps.locale)
      /** 文案选择：第一个参数为当前展示文案。 */
      const L = (zh, en) => (lang === 'en' ? en : zh)
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
          setState({ status: 'unavailable', session: null, auth: null, global: null, error: L('当前没有会话', 'No active session') })
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

      // 把「当前会话用的是哪个 provider/model」写给侧边栏用量卡。
      useEffect(() => {
        if (!sessionId || !provider) return
        sessionModelStore.set({ sessionId, provider, model: currentModelId })
      }, [sessionId, provider, currentModelId])

      const toggle = useCallback(async () => {
        if (!sessionId || busy || unavailable) return
        setBusy(true)
        try {
          const data = await postOp({ op: 'setSessionEnabled', sessionId, enabled: !enabled })
          setState((prev) => ({ status: 'ready', session: data.session, auth: data.auth, global: prev.global, error: '' }))
        } catch (error) {
          if (typeof window !== 'undefined') window.alert(L('ChatGPT 开关失败：', 'Failed to toggle ChatGPT: ') + String(error.message || error))
        } finally {
          setBusy(false)
        }
      }, [sessionId, enabled, busy, unavailable])

      const title = unavailable
        ? `${label} ${L('状态不可用：', 'status unavailable: ')}` + (state.error || L('服务未就绪', 'service not ready'))
        : !loggedIn
          ? L('尚未登录 OpenAI 账号：请先到 设置 → ChatGPT 页登录，再点这里授权本会话。', 'Not signed in to OpenAI yet. Go to Settings → ChatGPT, sign in, then authorize this session here.')
          : enabled
            ? L(`本会话已授权 ChatGPT（模型 ${model || '默认'}）。点击撤销授权。`, `This session is authorized for ChatGPT (model ${model || 'default'}). Click to revoke.`)
            : L('本会话未授权 ChatGPT。点击允许本会话在需要时调用 GPT 做专业分析。', 'This session is not authorized for ChatGPT. Click to allow it to call GPT for deeper analysis.')

      return h(
        'button',
        {
          type: 'button',
          onClick: toggle,
          disabled: unavailable || busy,
          title,
          'aria-pressed': enabled ? 'true' : 'false',
          'aria-label': enabled ? L(`${label} 已授权，点击撤销`, `${label}: authorized, click to revoke`) : L(`${label} 未授权，点击允许`, `${label}: not authorized, click to allow`),
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

    /** 毫秒 → 当前语言的时长文案（默认中文）。 */
    function formatCountdown(ms, lang = 'zh') {
      const total = Math.max(0, Math.round(Number(ms) / 60_000))
      const en = lang === 'en'
      if (total <= 0) return en ? 'less than 1 min' : '不到 1 分钟'
      const hours = Math.floor(total / 60)
      const minutes = total % 60
      if (hours > 0) {
        if (!en) return minutes > 0 ? `${hours} 小时 ${minutes} 分` : `${hours} 小时`
        return minutes > 0 ? `${hours} h ${minutes} min` : `${hours} h`
      }
      return en ? `${minutes} min` : `${minutes} 分钟`
    }

    /**
     * 当前会话的模型选择。
     * 输入框左侧胶囊每次渲染都能拿到当前会话的 provider/model，写进这个 store；
     * 侧边栏用量卡订阅它，于是「当前对话换成什么模型，卡片就跟着换」。
     */
    const sessionModelStore = (() => {
      let snapshot = { sessionId: '', provider: '', model: '' }
      const listeners = new Set()
      return {
        get() {
          return snapshot
        },
        subscribe(listener) {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
        set(next) {
          const value = {
            sessionId: String((next && next.sessionId) || ''),
            provider: String((next && next.provider) || ''),
            model: String((next && next.model) || ''),
          }
          if (
            value.sessionId === snapshot.sessionId &&
            value.provider === snapshot.provider &&
            value.model === snapshot.model
          ) {
            return
          }
          snapshot = value
          for (const listener of listeners) {
            try {
              listener()
            } catch {
              // 单个订阅者出错不影响其它订阅者
            }
          }
        },
      }
    })()

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
    /**
     * 第三方 connect 插件（WorkBuddy / Trae）的只读用量端点。
     * 它们各自暴露 `/plugins/<id>/usage`，返回里带 credits；卡片直接读，不复制它们的登录逻辑。
     * 数组顺序决定卡片里的排列：WorkBuddy 在前、Trae 在后（两者都排在其它 AI 之后）。
     */
    const CONNECT_PLUGINS = [
      {
        id: 'workbuddy',
        label: 'WorkBuddy',
        path: '/plugins/dsh-connect-workbuddy/usage',
        providers: ['workbuddy', 'workbuddy-global'],
      },
      { id: 'trae', label: 'Trae', path: '/plugins/dsh-connect-trae/usage', providers: ['trae', 'trae-enterprise'] },
    ]

    /**
     * 从 connect 插件的 usage 文档里取出「剩余积分」。
     * Trae 的 total 是累计发放，剩余在 available/workAvailable/generalAvailable；
     * WorkBuddy 的 total 本身就是剩余合计，另有 expiringSoon。
     * 未登录或形状不对返回 null（卡片就不显示这一家，不显示 0 误导）。
     */
    function parseConnectPoints(id, doc) {
      if (!doc || typeof doc !== 'object' || doc.status !== 'signed-in') return null
      // 企业版读不到个人积分（插件自己标了 creditsUnavailable）：不显示这一页，别显示成 0。
      if (doc.creditsUnavailable) return null
      const credits = doc.credits && typeof doc.credits === 'object' ? doc.credits : null
      if (!credits) return null
      const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : null)
      if (id === 'trae') {
        const available =
          num(credits.available) ?? ((num(credits.workAvailable) || 0) + (num(credits.generalAvailable) || 0))
        if (available === null) return null
        const total = num(credits.total)
        return {
          id,
          label: 'Trae',
          total: available,
          sub: total !== null ? `累计 ${total}` : '',
          checkin: doc.checkin && doc.checkin.checkedIn ? '今日已签到' : '',
        }
      }
      if (id === 'workbuddy') {
        const total = num(credits.total)
        if (total === null) return null
        const soon = num(credits.expiringSoon)
        return {
          id,
          label: 'WorkBuddy',
          total,
          sub: soon && soon > 0 ? `即将过期 ${soon}` : '',
          checkin: doc.checkin && doc.checkin.todayCheckedIn ? '今日已签到' : '',
        }
      }
      return null
    }

    /**
     * 积分显示：整数直接显示，带小数的最多保留两位（去掉多余的 0）。
     * 上游累加会产生 5494.9100000001 这种浮点噪声，不能原样丢给用户。
     */
    function formatPoints(value) {
      if (value === null || value === undefined || value === '') return '—'
      const number = Number(value)
      if (!Number.isFinite(number)) return '—'
      if (Number.isInteger(number)) return String(number)
      return number.toFixed(2).replace(/\.?0+$/, '')
    }

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

    /** 语言探测与订阅（实现保留，当前未被引用）。 */
    function useDetectedLang(locale) {
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

    /** 组件统一入口：当前固定中文。 */
    function useLang() {
      return 'zh'
    }

    /** 取文案；缺键回退中文，再缺返回 key（永不渲染 undefined）。 */
    function translate(lang, key, ...args) {
      const dict = I18N[lang] || I18N.zh
      const value = dict[key] !== undefined ? dict[key] : I18N.zh[key]
      if (typeof value === 'function') return value(...args)
      return typeof value === 'string' ? value : key
    }

    /** 宿主/第三方插件返回的中文提示：原样透传（映射实现保留，当前未启用）。 */
    const HOST_TEXT_EN = {
      '未配置 DEEPSEEK_API_KEY': 'DEEPSEEK_API_KEY is not configured',
      '尚未登录 OpenAI 账号': 'Not signed in to OpenAI',
      '余额接口返回无法解析': 'Balance endpoint returned unparsable data',
      'lan-redacted': 'Hidden on LAN',
    }
    function translateHostText(text, lang) {
      const raw = String(text == null ? '' : text)
      // Node 抛的 "fetch failed" 对用户没信息量，直接说清是网络/代理问题。
      if (/^fetch failed$/i.test(raw.trim())) return '网络请求失败（检查连接或代理）'
      if (lang !== 'en') return raw
      if (HOST_TEXT_EN[raw]) return HOST_TEXT_EN[raw]
      const http = /^余额接口 HTTP (\S+)$/.exec(raw)
      if (http) return `Balance endpoint returned HTTP ${http[1]}`
      return raw
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
            '暂无用量数据 / No usage data',
          )
        }
        return this.props.children
      }
    }

    function CodexUsageCard(props) {
      const locale = props && props.locale
      // 宿主直接读 DSH 配置得到的界面语言最准；拿不到再用 locale 服务/&lt;html lang&gt; 兜底。
      const [hostLang, setHostLang] = useState('')
      const detectedLang = useLang(locale)
      const lang = hostLang === 'en' || hostLang === 'zh' ? hostLang : detectedLang
      const t = (key, ...args) => translate(lang, key, ...args)
      /** 文案选择：第一个参数为当前展示文案。 */
      const L = (zh, en) => (lang === 'en' ? en : zh)
      /** 宿主返回的窗口标签是中文（5 小时 / 每周）；映射实现保留，当前原样使用。 */
      const chatgptWindowLabel = (window) => {
        const id = String((window && window.id) || '')
        const raw = String((window && window.label) || '')
        if (lang !== 'en') return raw
        if (id === 'primary' || raw.includes('小时') || raw.includes('5')) return '5 hours'
        if (id === 'secondary' || raw.includes('周')) return 'Weekly'
        return raw
      }
      const wide = !(props && props.wide === false)
      const [usage, setUsage] = useState(null)
      const [rows, setRows] = useState([])
      const [connectPoints, setConnectPoints] = useState({})
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
      // 第三方积分单独一个序号：和 providers 共用会在并发时互相丢弃结果。
      const connectSeq = useRef(0)

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

      /** 读取 Trae / WorkBuddy 的积分（各自的只读 usage 端点，未安装/未登录就跳过）。 */
      const loadConnectPoints = useCallback(async () => {
        const seq = ++connectSeq.current
        const results = await Promise.all(
          CONNECT_PLUGINS.map(async (plugin) => {
            try {
              const response = await fetch(plugin.path, {
                // 超时兜底：某个插件不响应时不能把整张卡片的刷新卡住。
                signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(8000) : undefined,
                headers: { Accept: 'application/json' },
                cache: 'no-store',
              })
              if (!response.ok) return [plugin.id, null]
              const doc = await response.json()
              return [plugin.id, parseConnectPoints(plugin.id, doc)]
            } catch {
              return [plugin.id, null]
            }
          }),
        )
        if (!mounted.current || seq !== connectSeq.current) return
        const next = {}
        for (const [id, value] of results) {
          if (value) next[id] = value
        }
        setConnectPoints(next)
      }, [])

      /**
       * 跟随当前模型：走轻量 meta 端点（3 秒轮询），只回 { currentModel, defaultUsageTab }，
       * 不拉完整快照（不重复暴露邮箱/套餐，也不触发凭证同步副作用）。
       */
      const loadPreferred = useCallback(async () => {
        const seq = ++preferredSeq.current
        /** 宿主读到的界面语言（DSH 配置里的真实值）优先于客户端猜测。 */
        const applyHostLang = (value) => {
          if (value === 'en' || value === 'zh') setHostLang(value)
        }
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
            applyHostLang(data.uiLang)
            setCurrentModel(data.currentModel || null)
            if (typeof data.defaultUsageTab === 'string' && data.defaultUsageTab) {
              setPreferred(data.defaultUsageTab)
            }
            return
          }
          // 旧宿主不认 meta，直接把整份快照返回了：就地用它，免得再打一次。
          if (data && data.ok === true && data.global) {
            if (!mounted.current || seq !== preferredSeq.current) return
            applyHostLang(data.uiLang)
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
          applyHostLang(data.uiLang)
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
          await Promise.all([
            loadChatgpt(),
            loadProviders(),
            loadConnectPoints(),
            loadPreferred(),
            loadDashboard(force),
          ])
          if (mounted.current && seq === requestSeq.current) {
            setBusy(false)
            setClock(Date.now())
          }
        },
        [loadChatgpt, loadProviders, loadConnectPoints, loadPreferred, loadDashboard],
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
          // 第三方积分（Trae / WorkBuddy）跟着同一个节奏刷新。
          void loadConnectPoints()
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

      /**
       * 可切换的 AI 列表，顺序固定为：
       *   DeepSeek → ChatGPT → 其它已配置 AI → WorkBuddy → Trae
       * 点卡片空白处就按这个顺序循环。
       */
      const tabs = useMemo(() => {
        const list = [
          { id: 'deepseek', label: 'DeepSeek', kind: 'dashboard', row: null },
          { id: 'chatgpt', label: 'ChatGPT', kind: 'chatgpt', row: null },
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
        // 第三方积分固定排在最后（WorkBuddy 先、Trae 后），读到才显示。
        for (const plugin of CONNECT_PLUGINS) {
          const points = connectPoints && connectPoints[plugin.id]
          if (!points || seen.has(plugin.id)) continue
          seen.add(plugin.id)
          list.push({ id: plugin.id, label: plugin.label, kind: 'points', row: points })
        }
        return list
      }, [connectPoints, rows])

      /** auto 模式：按「当前在用的模型」决定先显示哪一家。 */
      /** 当前会话的模型（由输入框胶囊写入，比全局默认模型更贴近「我现在在用什么」）。 */
      const sessionModel = useSyncExternalStore(sessionModelStore.subscribe, sessionModelStore.get)

      /** auto 模式：优先按当前会话的模型决定先显示哪一家，其次才用全局默认模型。 */
      const autoTabId = useMemo(() => {
        const provider = (sessionModel && sessionModel.provider) || (currentModel && currentModel.provider) || ''
        if (provider === 'openai-codex' || provider === 'chatgpt-codex') return 'chatgpt'
        if (provider.startsWith('deepseek')) return 'deepseek'
        // Trae / WorkBuddy：按 provider 找到对应积分卡（含 -global / -enterprise 变体）。
        // provider 可能是 workbuddy / workbuddy-global / trae / trae-enterprise，两种都认。
        const connect = CONNECT_PLUGINS.find(
          (plugin) => plugin.providers.includes(provider) || provider.startsWith(plugin.id),
        )
        if (connect && tabs.some((item) => item.id === connect.id)) return connect.id
        // 其它（含不支持/不认识的 provider）：有对应余额卡就用它，否则退 DeepSeek 余额。
        // 只有确实在用本插件的 ChatGPT 时才显示 ChatGPT 限额，避免默认停在 GPT。
        return tabs.some((item) => item.id === provider) ? provider : 'deepseek'
      }, [currentModel, sessionModel, tabs])

      const preferredId = preferred === 'auto' ? autoTabId : preferred
      // 手动覆盖只在「同一个模型」下有效：换模型就自动回到跟随，不会长期压住 auto。
      const modelKey = currentModel ? `${currentModel.provider}|${currentModel.model}` : ''
      const manualValid = Boolean(tab) && (!manualKey || manualKey === modelKey)
      const activeId = manualValid && tabs.some((item) => item.id === tab)
        ? tab
        : tabs.some((item) => item.id === preferredId)
          ? preferredId
          : 'deepseek'
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
        if (item.kind === 'points') {
          // Trae / WorkBuddy 的剩余积分：大数字 + 「积分」小字，下面附累计/即将过期与签到状态。
          const points = item.row || {}
          const total = Number.isFinite(Number(points.total)) ? Number(points.total) : null
          const lines = [
            h(
              'div',
              { key: 'points', style: { display: 'flex', alignItems: 'baseline', gap: '6px' } },
              h(
                'span',
                { style: { ...usageStyles.brand, fontSize: '19px', letterSpacing: 0 } },
                total === null ? '—' : formatPoints(total),
              ),
              h('span', { style: { ...usageStyles.hint, fontSize: '10px' } }, '积分'),
            ),
          ]
          const notes = [points.sub, points.checkin].filter((text) => typeof text === 'string' && text)
          if (notes.length > 0) {
            lines.push(
              h(
                'div',
                { key: 'notes', style: { ...usageStyles.hint, fontSize: '10px', opacity: 0.6 } },
                notes.join(' · '),
              ),
            )
          }
          return lines
        }
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
          // 查询失败（网络/代理/上游错误）时绝不显示成 0.00，用 — 表示「没读到」。
          const failed = Boolean(data && data.error)
          const amount = failed || total === null ? '—' : `${symbol}${total.toFixed(2)}`
          const remainMs = peak && Number.isFinite(Number(peak.nextChangeAt)) ? Number(peak.nextChangeAt) - clock : 0
          const countdown = remainMs > 60_000 ? formatCountdown(remainMs, lang) : ''
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
              ? h('div', { key: 'err', style: { ...usageStyles.hint, fontSize: '10px', opacity: 0.5 } }, translateHostText(data.error, lang))
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
              const left = Math.round(100 - used)
              // 宿主的窗口标签是中文（5 小时 / 每周）。
              const label = chatgptWindowLabel(window)
              const resetHint = window.resetAt
                ? L(`, ${formatReset(window.resetAt)} 重置`, `, resets ${formatReset(window.resetAt)}`)
                : ''
              return bar(
                window.id || window.label,
                label,
                100 - used,
                L(
                  `${label}：已用 ${Math.round(used)}%，剩余 ${left}%${resetHint}`,
                  `${label}: ${Math.round(used)}% used, ${left}% left${resetHint}`,
                ),
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
            h('div', { key: 'hint', style: usageStyles.hint }, row.reason ? translateHostText(row.reason, lang) : t('accountBalance')),
          ]
        }
        const list = Array.isArray(row.usage && row.usage.windows) ? row.usage.windows : []
        if (list.length === 0) {
          return [h('div', { key: 'empty', style: usageStyles.hint }, row.reason ? translateHostText(row.reason, lang) : t('noUsage'))]
        }
        return list.map((window) => {
          const percent = Number(window.percent)
          const remaining = Number.isFinite(percent) ? 100 - percent : 0
          const label =
            window.key === '5h' ? t('hour5') : window.key === '7d' ? t('week') : String(window.key || '')
          return bar(
            window.key,
            label,
            remaining,
            L(
              `${label}：已用 ${Math.round(percent || 0)}%，剩余 ${Math.round(remaining)}%`,
              `${label}: ${Math.round(percent || 0)}% used, ${Math.round(remaining)}% left`,
            ),
          )
        })
      }

      return h(
        'div',
        {
          role: 'status',
          onClick: () => void cycleTab(),
          title: L(
            `点击卡片切换到下一家（当前 ${active.label}）`,
            `Click to switch to the next provider (current: ${active.label})`,
          ),
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
              title: L(`${active.label}：点击刷新`, `${active.label}: click to refresh`),
              style: { ...usageStyles.brand, cursor: 'pointer' },
            },
            active.label,
          ),
          active.kind === 'chatgpt' && planText ? h('span', { style: usageStyles.badge }, planText) : null,
          active.kind === 'dashboard' ? h('span', { style: usageStyles.badge }, t('paygo')) : null,
          active.kind === 'points' ? h('span', { style: usageStyles.badge }, '积分') : null,
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
      const locale = props && props.locale
      // 宿主读到的界面语言优先（DSH 配置事实），其次 locale 服务 / <html lang>。
      const [hostLang, setHostLang] = useState('')
      const detectedLang = useLang(locale)
      const lang = hostLang === 'en' || hostLang === 'zh' ? hostLang : detectedLang
      const t = (key, ...args) => translate(lang, key, ...args)
      /** 文案选择：第一个参数为当前展示文案。 */
      const L = (zh, en) => (lang === 'en' ? en : zh)
      const [auth, setAuth] = useState(null)
      const [defaultModel, setDefaultModel] = useState('')
      const [autoConsult, setAutoConsult] = useState(true)
      const [allowLan, setAllowLan] = useState(false)
      const [delegateLight, setDelegateLight] = useState(false)
      const [gptNameDetect, setGptNameDetect] = useState(false)
      const [defaultUsageTab, setDefaultUsageTab] = useState('auto')
      const [dashboardOnly, setDashboardOnly] = useState(false)
      const [hideDashboard, setHideDashboard] = useState(false)
      const [usageTabOptions, setUsageTabOptions] = useState([
        { id: 'auto', label: L('自动（跟随当前模型）', 'Auto (follow current model)') },
        { id: 'deepseek', label: 'DeepSeek' },
        { id: 'chatgpt', label: 'ChatGPT' },
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

      /** 用量卡「默认展示」的候选，顺序与卡片切换一致：DeepSeek → ChatGPT → 其它已配置 AI。 */
      const loadUsageTabOptions = useCallback(async () => {
        const base = [
          { id: 'auto', label: L('自动（跟随当前模型）', 'Auto (follow current model)') },
          { id: 'deepseek', label: 'DeepSeek' },
          { id: 'chatgpt', label: 'ChatGPT' },
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
          if (data.uiLang === 'en' || data.uiLang === 'zh') setHostLang(data.uiLang)
          if (typeof data.pluginVersion === 'string' && data.pluginVersion) setPluginVersion(data.pluginVersion)
          if (!initialized.current) {
            initialized.current = true
            setDefaultModel(data.global.defaultModel || '')
            setAutoConsult(data.global.autoConsult !== false)
            setAllowLan(data.global.allowLanAccess === true)
            setDelegateLight(data.global.delegateLightTasks === true)
            setGptNameDetect(data.global.gptNameDetect === true)
            setDefaultUsageTab(data.global.defaultUsageTab || 'chatgpt')
            setDashboardOnly(data.global.dashboardOnly === true)
            setHideDashboard(data.global.hideDashboard === true)
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
            setNotice(L('授权链接已复制，粘贴到浏览器地址栏打开即可。', 'Authorization link copied — paste it into your browser\'s address bar.'))
            return
          }
          throw new Error(L('剪贴板不可用', 'Clipboard unavailable'))
        } catch {
          if (typeof window !== 'undefined') window.prompt(L('复制这个授权链接：', 'Copy this authorization link:'), loginUrl)
        }
      }, [loginUrl])

      const startLogin = useCallback(async () => {
        setError('')
        setNotice('')
        setLogging(true)
        try {
          const data = await postOp({ op: 'login' })
          const url = data.result && data.result.url
          if (!url) throw new Error(L('没有拿到 OpenAI 授权地址', 'No OpenAI authorization URL returned'))
          setLoginUrl(url)
          if (typeof window !== 'undefined') {
            // noopener 会让 window.open 永远返回 null，不能据此判断是否被拦截。
            try {
              window.open(url, '_blank', 'noopener')
            } catch {
              // 被浏览器直接拒绝时走下面的复制兜底
            }
            setNotice(L('已尝试打开 OpenAI 登录页；若没有弹出，点下方「点我复制授权链接」。', 'Tried to open the OpenAI login page. If it did not appear, use "Copy authorization link" below.'))
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
                setNotice(L('登录成功，已获取模型列表。', 'Signed in — model list loaded.'))
                await loadModels(true)
                await loadResets()
                return
              }
            } catch {
              // 轮询失败继续等
            }
            if (attempts > 150) {
              stopPolling()
              setError(L('登录等待超时，请重试。', 'Login timed out. Please try again.'))
            }
          }, 2000)
        } catch (loginFailure) {
          stopPolling()
          setError(L('发起登录失败：', 'Failed to start login: ') + String(loginFailure.message || loginFailure))
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
          setNotice(L('已退出 OpenAI 登录。', 'Signed out of OpenAI.'))
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
          setNotice(L(`已从 OpenAI 拉取 ${Array.isArray(result.models) ? result.models.length : 0} 个模型。`, `Fetched ${Array.isArray(result.models) ? result.models.length : 0} model(s) from OpenAI.`))
        } catch (modelsFailure) {
          setError(L('拉取模型列表失败：', 'Failed to fetch the model list: ') + String(modelsFailure.message || modelsFailure))
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
              dashboardOnly,
              hideDashboard,
            },
          })
          setNotice(L('已保存并生效。', 'Saved and applied.'))
        } catch (saveFailure) {
          setError(String(saveFailure.message || saveFailure))
        } finally {
          setBusy(false)
        }
      }, [defaultModel, autoConsult, allowLan, delegateLight, deepseekModel, gptNameDetect, defaultUsageTab, dashboardOnly, hideDashboard])

      const checkNetwork = useCallback(async () => {
        setChecking(true)
        setError('')
        setNotice('')
        try {
          const data = await postOp({ op: 'testNetwork' })
          setNetwork(data.result || null)
        } catch (networkFailure) {
          setError(L('外网连通性检查失败：', 'Connectivity check failed: ') + String(networkFailure.message || networkFailure))
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
            L(`确定使用一张重置卡吗？\n\n将立即重置 5 小时 / 每周限流窗口，操作不可撤销。\n当前可用：${count} 张`, `Use one reset credit?\n\nThis immediately resets the 5-hour / weekly limits and cannot be undone.\nAvailable: ${count}`),
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
            reset: L(`已重置 ${result.windowsReset || 1} 个限流窗口。`, `Reset ${result.windowsReset || 1} rate-limit window(s).`),
            nothing_to_reset: L('当前没有需要重置的限流窗口（额度还充足），本次未消耗重置卡。', 'No rate-limit window needs resetting (quota is fine). No reset credit was consumed.'),
            no_credit: L('没有可用的重置卡。', 'No reset credits available.'),
            already_redeemed: L('这次重置请求此前已完成（幂等），按成功处理。', 'This reset was already completed (idempotent); treated as success.'),
          }
          setNotice(messages[result.code] || L(`重置结果：${result.code || 'unknown'}`, `Reset result: ${result.code || 'unknown'}`))
          await loadResets()
        } catch (resetFailure) {
          setError(L('重置失败：', 'Reset failed: ') + String(resetFailure.message || resetFailure))
        } finally {
          setResetting(false)
        }
      }, [resetInfo, loadResets])

      if (!auth) {
        // 加载失败时必须把原因显示出来，否则页面会永远停在「加载中」。
        return h(
          'div',
          { style: styles.card },
          h('div', { style: styles.title }, L(' ChatGPT 设置', 'ChatGPT settings')),
          error
            ? h('div', { style: styles.error }, L('加载失败：', 'Load failed: ') + error)
            : h('div', { style: styles.hint }, L('加载中…', 'Loading…')),
          error
            ? h(
                'div',
                { style: styles.row },
                h('button', { type: 'button', style: styles.button, onClick: () => void loadAll() }, L('重试', 'Retry')),
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
        // ── 仅看板模式 / 关闭看板 ─────────────────────────────────────
        h(
          'div',
          { style: styles.card },
          h('div', { style: styles.title }, '🦭 看板开关'),
          h(
            'div',
            { style: styles.row },
            h('input', {
              type: 'checkbox',
              checked: dashboardOnly,
              onChange: (event) => setDashboardOnly(event.target.checked),
            }),
            h('span', { style: styles.label }, '仅看板模式：只保留用量看板'),
          ),
          h(
            'div',
            { style: styles.hint },
            '开启后关闭 ChatGPT 模型、codex 工具、会话授权与凭证同步，设置页只留看板相关项。默认关闭；保存后需禁用→启用插件完全生效。',
          ),
          h(
            'div',
            { style: styles.row },
            h('input', {
              type: 'checkbox',
              checked: hideDashboard,
              onChange: (event) => setHideDashboard(event.target.checked),
            }),
            h('span', { style: styles.label }, '关闭看板：隐藏侧边栏卡片'),
          ),
          h(
            'div',
            { style: styles.hint },
            '与「仅看板模式」互不影响：打开它只把侧边栏那张用量卡藏起来，ChatGPT 模型、codex 工具、会话授权照旧可用。保存后需禁用→启用插件完全生效。',
          ),
          h(
            'div',
            { style: styles.hint },
            '如果你觉得这个做的不好看，可以向我提 issues 或 PR；也可以试一下同类兼容的看板：https://github.com/dougen/dsh-deepseek-usage',
          ),
        ),
        // ── 插件版本 ────────────────────────────────────────────────
        h(
          'div',
          { style: { ...styles.hint, display: 'flex', alignItems: 'center', gap: '6px' } },
          h('span', { style: styles.badge }, `dsh-codex-gpt ${pluginVersion || '—'}`),
          h('span', { style: { opacity: 0.6 } }, t('version')),
        ),
        // ── OpenAI 账号 ──────────────────────────────────────────────
        ...(dashboardOnly ? [] : [
        h(
          'div',
          { style: styles.card },
          h('div', { style: styles.title }, L('🔐 OpenAI 账号', '🔐 OpenAI account')),
          loggedIn
            ? h(
                'div',
                { style: styles.row },
                h('span', { style: styles.badge }, auth.planLabel || L('已登录', 'Signed in')),
                h('span', { style: { fontSize: '13px' } }, auth.email || L('（未返回邮箱）', '(no email returned)')),
                untilText ? h('span', { style: styles.hint }, untilText) : null,
                h(
                  'button',
                  { type: 'button', style: { ...styles.button, marginLeft: 'auto' }, onClick: logout, disabled: busy },
                  L('退出登录', 'Sign out'),
                ),
              )
            : h(
                'div',
                { style: styles.row },
                h(
                  'button',
                  { type: 'button', style: styles.buttonPrimary, onClick: startLogin, disabled: logging },
                  logging ? L('等待授权…', 'Waiting for authorization…') : L('登录 OpenAI 账号', 'Sign in to OpenAI'),
                ),
                h('span', { style: styles.hint }, L('点击后会打开 OpenAI 官网，登录并同意授权即可；无需手动填写 API Key。', 'Opens the OpenAI website; sign in and approve. No API key needed.')),
              ),
          h(
            'div',
            { style: styles.hint },
            L('登录使用与 Codex CLI 相同的官方 OAuth 客户端，凭证只保存在本机（$DSH_HOME/dsh-codex-auth.json）。', 'Uses the same official OAuth client as Codex CLI; credentials stay on this machine ($DSH_HOME/dsh-codex-auth.json).'),
          ),
          h(
            'div',
            { style: styles.row },
            h(
              'button',
              { type: 'button', style: styles.button, onClick: checkNetwork, disabled: checking },
              checking ? L('检查中…', 'Checking…') : L('外网连通性检查', 'Connectivity check'),
            ),
            h(
              'button',
              { type: 'button', style: styles.button, onClick: startLogin, disabled: logging || !loggedIn },
              L('重新登录', 'Sign in again'),
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
                    title: L('复制完整授权链接（链接较长，桌面端窗口里放不下）', 'Copy full authorization link (too long for the desktop window)'),
                  },
                  L('🔗 点我复制授权链接', '🔗 Copy authorization link'),
                ),
                h('span', { style: styles.hint }, L('复制后粘贴到浏览器地址栏即可完成授权。', 'Paste it into your browser\'s address bar to finish authorization.')),
              )
            : null,
          network
            ? h(
                'div',
                { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
                h(
                  'div',
                  { style: styles.hint },
                  L(`外网连通性：${network.reachable}/${network.total} 条链路可达（能拿到 HTTP 响应即算可达）`, `Connectivity: ${network.reachable}/${network.total} endpoints reachable (any HTTP response counts)`),
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
                        ? L(`可达 · HTTP ${target.status} · ${target.latencyMs}ms`, `Reachable · HTTP ${target.status} · ${target.latencyMs}ms`)
                        : L(
                            `不可达 · ${target.error || '连接失败'}（${target.latencyMs}ms）`,
                            `Unreachable · ${target.error || 'connection failed'} (${target.latencyMs}ms)`,
                          ),
                    ),
                  ),
                ),
              )
            : null,
        ),
        ]),
        // ── Codex 设置 ──────────────────────────────────────────────
        ...(dashboardOnly ? [] : [
        h(
          'div',
          { style: styles.card },
          h('div', { style: styles.title }, L('🛠️ ChatGPT 设置', '🛠️ ChatGPT settings')),
          h(
            'div',
            { style: styles.row },
            h('span', { style: styles.label }, L('默认模型', 'Default model')),
            h(
              'select',
              {
                style: styles.select,
                value: defaultModel,
                onChange: (event) => setDefaultModel(event.target.value),
                disabled: !loggedIn,
              },
              h('option', { value: '' }, L('自动选择（按任务自动挑）', 'Auto (pick by task)')),
              modelOptions.length === 0
                ? h('option', { value: '__none__', disabled: true }, L('登录后自动获取', 'Fetched after sign-in'))
                : modelOptions.map((slug) => h('option', { key: slug, value: slug }, slug)),
            ),
            h(
              'button',
              { type: 'button', style: styles.button, onClick: refreshModels, disabled: !loggedIn },
              L('刷新模型列表', 'Refresh models'),
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
              ? h('div', { style: styles.error }, L('模型列表不可用：', 'Model list unavailable: ') + modelsError)
              : null,
          h(
            'div',
            { style: styles.row },
            h('span', { style: styles.label }, L('自主调用', 'Autonomous calls')),
            h(
              'label',
              { style: { display: 'inline-flex', alignItems: 'center', gap: '8px', cursor: 'pointer' } },
              h(ToggleBox, { on: autoConsult, onClick: () => setAutoConsult(!autoConsult) }),
              h(
                'span',
                { onClick: () => setAutoConsult(!autoConsult), style: { fontSize: '13px' } },
                autoConsult ? L('已授权会话可按任务强度自主调用', 'Authorized sessions may call Codex based on task difficulty') : L('仅在用户明确要求时调用', 'Only when the user explicitly asks'),
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
              L('允许局域网设备只读查看本插件状态（写操作始终仅限本机）', 'Allow LAN devices to read this plugin\'s status (writes stay local-only)'),
            ),
          ),
          h(
            'div',
            { style: styles.row },
            h(ToggleBox, { on: delegateLight, onClick: () => setDelegateLight(!delegateLight) }),
            h(
              'span',
              { onClick: () => setDelegateLight(!delegateLight), style: { fontSize: '13px', cursor: 'pointer' } },
              L('GPT 模式下轻任务交 DeepSeek V4.1 收尾（独立开关）', 'In GPT mode, hand light tasks to DeepSeek V4.1 (separate switch)'),
            ),
          ),
          delegateLight
            ? h(
                'div',
                { style: styles.hint },
                L('开启后，ChatGPT 处理会话时可以把格式化、整理、检索归纳、润色等轻任务交给 DeepSeek V4.1 完成，再整合进回答；复杂任务仍由 GPT 直接处理。', 'When enabled, ChatGPT can hand formatting, cleanup, retrieval summaries and polishing to DeepSeek V4.1, then merge the result; complex work still goes to GPT.'),
              )
            : null,
          delegateLight
            ? h(
                'div',
                { style: styles.row },
                h('span', { style: styles.label }, L('DeepSeek 模型', 'DeepSeek model')),
                h(
                  'select',
                  {
                    style: styles.select,
                    value: deepseekModel,
                    onChange: (event) => setDeepseekModel(event.target.value),
                  },
                  h('option', { value: '' }, L('自动选择（按任务自动挑）', 'Auto (pick by task)')),
                  deepseekModel && !deepseekModels.some((item) => item.id === deepseekModel)
                    ? h('option', { value: deepseekModel }, deepseekModel)
                    : null,
                  deepseekModels.length === 0
                    ? h('option', { value: '__none__', disabled: true }, deepseekModelsError || L('加载中…', 'Loading…'))
                    : deepseekModels.map((item) =>
                        h('option', { key: item.id, value: item.id }, item.name || item.id),
                      ),
                ),
                h('button', { type: 'button', style: styles.button, onClick: loadDeepseekModels }, L('刷新', 'Refresh')),
              )
            : null,
          h(
            'div',
            { style: styles.row },
            h(ToggleBox, { on: gptNameDetect, onClick: () => setGptNameDetect(!gptNameDetect) }),
            h(
              'span',
              { onClick: () => setGptNameDetect(!gptNameDetect), style: { fontSize: '13px', cursor: 'pointer' } },
              L('按模型名识别 GPT（保险开关，默认关闭）', 'Detect GPT by model name (safety switch, off by default)'),
            ),
          ),
          h(
            'div',
            { style: styles.hint },
            gptNameDetect
              ? L('已开启：即使模型来自其他 provider，只要模型 id 形如 gpt-* / o3-*，输入框胶囊也会按「GPT」识别（显示 DeepSeek）。', 'Enabled: model ids like gpt-* / o3-* are treated as GPT (capsule shows DeepSeek) even from other providers.')
              : L('关闭时只认本插件的 ChatGPT provider；开启后才会额外按模型名判断，避免把别家同名模型误认成本插件的 GPT。', 'When off, only this plugin\'s ChatGPT provider counts; when on, model-name matching is added so other providers\' models are not misidentified.'),
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
              busy ? L('保存中…', 'Saving…') : L('保存', 'Save'),
            ),
          ),
          notice ? h('div', { style: styles.notice }, notice) : null,
          error ? h('div', { style: styles.error }, error) : null,
        ),
        ]),
        // ── 重置额度（重置卡） ──────────────────────────────────────
        ...(dashboardOnly ? [] : [
        h(
          'div',
          { style: styles.card },
          h('div', { style: styles.title }, L('🎟️ 重置额度（重置卡）', '🎟️ Reset credits')),
          h(
            'div',
            { style: styles.hint },
            loggedIn
              ? resetInfo
                ? `当前可用 ${Number(resetInfo.availableCount) || 0} 张重置卡${
                    resetInfo.credits && resetInfo.credits[0] && resetInfo.credits[0].expiresAt
                      ? L(`，最近一张 ${formatDate(resetInfo.credits[0].expiresAt)} 过期`, `, earliest expires ${formatDate(resetInfo.credits[0].expiresAt)}`)
                      : ''
                  }。`
                : L('正在读取重置卡…', 'Reading reset credits…')
              : L('登录 OpenAI 账号后可以查看和使用重置卡。', 'Sign in to OpenAI to view and use reset credits.'),
          ),
          resetInfo && Array.isArray(resetInfo.credits) && resetInfo.credits.length > 0
            ? h(
                'div',
                { style: { display: 'flex', flexDirection: 'column', gap: '3px' } },
                resetInfo.credits.slice(0, 3).map((credit) =>
                  h(
                    'div',
                    { key: credit.id, style: { fontSize: '12px', opacity: 0.7 } },
                    `· ${credit.title}${credit.expiresAt ? L(`（${formatDate(credit.expiresAt)} 过期）`, ` (expires ${formatDate(credit.expiresAt)})`) : ''}`,
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
              resetting ? L('重置中…', 'Resetting…') : L('使用一张重置额度', 'Use one reset credit'),
            ),
            h(
              'button',
              { type: 'button', style: styles.button, onClick: loadResets, disabled: !loggedIn },
              L('刷新重置卡', 'Refresh reset credits'),
            ),
          ),
          h(
            'div',
            { style: styles.hint },
            L('重置会立即恢复 5 小时 / 每周的限流窗口，操作不可撤销；只在额度确实受限时使用。', 'A reset immediately restores the 5-hour / weekly limits and cannot be undone; only use it when you are actually rate-limited.'),
          ),
        ),
        ]),
        // ── 使用方式 ────────────────────────────────────────────────
        ...(dashboardOnly ? [] : [
        h(
          'div',
          { style: styles.card },
          h('div', { style: styles.title }, L('使用方式', 'How to use')),
          h('div', { style: styles.hint }, L('1. 点「登录 OpenAI 账号」，在官网完成授权（不用填 Key）。', '1. Click "Sign in to OpenAI" and approve on the official site (no key needed).')),
          h('div', { style: styles.hint }, L('2. 登录后模型列表会自动从 OpenAI 拉取，选一个默认模型并保存。', '2. After signing in, the model list is fetched from OpenAI; pick a default model and save.')),
          h('div', { style: styles.hint }, L('3. 回到对话，点输入框左侧胶囊按钮授权当前会话（变蓝 = 已授权）。按钮名随当前模型变化：本插件 ChatGPT 时显示「DeepSeek」，其他模型时显示「ChatGPT」。', '3. Back in the conversation, click the capsule button left of the input to authorize this session (blue = authorized). Its label follows the current model: "DeepSeek" for this plugin\'s ChatGPT, otherwise "ChatGPT".')),
          h('div', { style: styles.hint }, L('4. 之后遇到高难度任务，DeepSeek 会自主调用 ChatGPT；未授权的会话不产生任何额度消耗。', '4. For hard tasks, DeepSeek then calls ChatGPT on its own; unauthorized sessions never consume quota.')),
        ),
        ]),
      )
    }

    return {
      name: 'codex-client',
      inject: ['slots'],
      // 仅供测试：校验第三方积分解析与文案字典（不影响运行时）。
      __test: { parseConnectPoints, formatPoints, I18N, translate, detectLang, normalizeLang },
      apply(ctx) {
        // slots 服务：优先用注入的 ctx.slots，取不到再通过 ctx.get('slots') 兜底。
        // 都拿不到就安静退出——不能让一个 slot 依赖把整个客户端插件（含其它 UI）带崩。
        const slots = (() => {
          try {
            if (ctx && ctx.slots && typeof ctx.slots.inject === 'function') return ctx.slots
          } catch {
            // 忽略，继续尝试 ctx.get
          }
          try {
            const service = ctx && typeof ctx.get === 'function' ? ctx.get('slots') : null
            if (service && typeof service.inject === 'function') return service
          } catch {
            // 读不到就当中没有
          }
          return null
        })()
        if (!slots) return
        // locale 服务只取一次：渲染时不再访问 ctx 上的 getter，避免取值本身把渲染弄崩。
        // 拿不到就回退中文（组件内另有 <html lang> 兜底探测）。
        const localeService = (() => {
          try {
            return ctx.locale || null
          } catch {
            return null
          }
        })()
        // 输入框胶囊：仅看板模式开启时要能把它摘掉，所以保留 register 的句柄。
        let toggleHandle = null
        const disposeToggle = () => {
          const handle = toggleHandle
          toggleHandle = null
          try {
            if (handle && typeof handle.dispose === 'function') handle.dispose()
            else if (typeof handle === 'function') handle()
          } catch {
            // 摘不掉也不影响其它 UI
          }
        }
        slots.inject('conversation.input.left', () => {
          toggleHandle = slots.register(
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
            (props) =>
              h(CodexToggle, { ...(props || {}), locale: (props && props.locale) || localeService }),
          )
          return toggleHandle
        })
        // 读一次配置：仅看板模式下不保留输入框胶囊（GPT 相关 UI 全部让位给看板）。
        if (typeof fetch === 'function') {
          Promise.resolve()
            .then(() => fetch(API + '?meta=1', { headers: { Accept: 'application/json' }, cache: 'no-store' }))
            .then((response) => (response && response.ok ? response.json() : null))
            .then((data) => {
              if (data && data.dashboardOnly === true) disposeToggle()
              if (data && data.hideDashboard === true) disposeCard()
            })
            .catch(() => {
              // 读不到就保持默认（胶囊/卡片留着，用户可再打开设置检查）
            })
        }
        slots.inject('settings.section', () =>
          slots.register(
            {
              name: 'settings.section',
              id: 'dsh-codex',
              order: 60,
              label: 'ChatGPT',
            },
            (props) => h(CodexSettings, { locale: (props && props.locale) || localeService }),
          ),
        )
        // 侧边栏用量卡：「关闭看板」开关打开时把它摘掉（只影响看板，不影响 GPT 功能）。
        let cardHandle = null
        const disposeCard = () => {
          const handle = cardHandle
          cardHandle = null
          try {
            if (handle && typeof handle.dispose === 'function') handle.dispose()
            else if (typeof handle === 'function') handle()
          } catch {
            // 摘不掉也不影响其它 UI
          }
        }
        slots.inject('sidebar.footer.action', () => {
          cardHandle = slots.register(
            {
              name: 'sidebar.footer.action',
              id: 'dsh-codex-usage',
              order: 101,
              label: 'ChatGPT usage',
            },
            (props) =>
              h(
                CardBoundary,
                null,
                h(CodexUsageCard, { wide: props && props.wide, locale: (props && props.locale) || localeService }),
              ),
          )
          return cardHandle
        })
      },
    }
  },
})
