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
    const { useCallback, useEffect, useRef, useState, useSyncExternalStore } = React
    const h = React.createElement

    const API = '/dsh-codex-api'

    /** 没有模型目录时用的恒定订阅/取值，保证 hook 调用顺序稳定。 */
    const noopSubscribe = () => () => {}
    const emptyProviderValue = () => ''
    /** 本插件 ChatGPT provider 的内部 id；其余 provider 一律视为「DeepSeek」。 */
    const CHATGPT_PROVIDER_ID = 'chatgpt-codex'
    /** 保险开关开启时，用来判断「其他 provider 提供的模型名看起来像 GPT」。 */
    const LOOKS_LIKE_GPT_RE = /^(?:gpt|o[0-9]|chatgpt)/i

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
      return payload
    }

    function loadState(sessionId) {
      const query = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ''
      return request(API + query, { headers: { Accept: 'application/json' }, cache: 'no-store' })
    }

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
          role: 'switch',
          'aria-checked': on ? 'true' : 'false',
          onClick: props.onClick,
          style: {
            ...styles.toggleTrack,
            cursor: props.onClick ? 'pointer' : undefined,
            background: on ? 'var(--dsw-specific-accent, #4d6bfe)' : styles.toggleTrack.background,
          },
        },
        h('span', { style: { ...styles.toggleKnob, left: on ? '19px' : '3px' } }),
      )
    }

    /** 输入框左侧的授权胶囊按钮（会话作用域）。 */
    function CodexToggle(props) {
      const injected = props && props.sessionId ? props.sessionId : props && props.inject && props.inject.sessionId
      const sessionId = injected ? String(injected) : ''
      const [state, setState] = useState({ status: 'loading', session: null, auth: null, global: null, error: '' })
      const [busy, setBusy] = useState(false)

      // 只读当前会话的 provider / model（不切换、不写入），仅用于决定胶囊显示的名字。
      const directoryStore = props && props.directoryStore
      const loadModels = props && props.loadModels
      const selection = useSyncExternalStore(
        directoryStore ? (listener) => directoryStore.subscribe(listener) : noopSubscribe,
        directoryStore
          ? () => {
              const snapshot = directoryStore.getSnapshot()
              const current = snapshot && snapshot.current
              return current ? `${current.provider || ''}\u0000${current.model || ''}` : ''
            }
          : emptyProviderValue,
      )
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

      const enabled = Boolean(state.session && state.session.enabled === true)
      const loggedIn = Boolean(state.auth && state.auth.loggedIn === true)
      const unavailable = state.status === 'error' || state.status === 'unavailable'
      const model = (state.session && state.session.model) || (state.auth && state.auth.planLabel) || ''
      // 显示名规则（仅显示，不影响点击行为）：
      //   默认：当前 provider 是本插件 ChatGPT → 显示 DeepSeek，其他 → 显示 ChatGPT
      //   保险开关 gptNameDetect 开启后：其他 provider 但模型 id 形如 gpt-*/o3-* 也按 GPT 识别 → 显示 DeepSeek
      const nameDetect = Boolean(state.global && state.global.gptNameDetect === true)
      const isOwnChatGpt = provider === CHATGPT_PROVIDER_ID
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
        if (!wide) return undefined
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
      }, [load, wide])

      if (!wide || !usage) return null

      const windows = Array.isArray(usage.windows) ? usage.windows : []
      const planText = usage.planLabel || ''
      const subscription = usage.subscription || {}
      const untilDate = formatDate(subscription.activeUntil)
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
          title: 'ChatGPT 用量：点击刷新',
          role: 'status',
          style: usageStyles.card,
        },
        h(
          'div',
          { style: usageStyles.head },
          h('span', { style: usageStyles.brand }, 'ChatGPT'),
          planText ? h('span', { style: usageStyles.badge }, planText) : null,
          resetCredits > 0
            ? h('span', { style: { marginLeft: 'auto', fontSize: '10px', opacity: 0.55 } }, `${resetCredits} 次重置`)
            : null,
        ),
        ...windows.map((window) => {
          const used = Math.max(0, Math.min(100, Number(window.usedPercent) || 0))
          const remaining = 100 - used
          const low = remaining <= 15
          return h(
            'div',
            {
              key: window.id || window.label,
              style: usageStyles.row,
              title: `${window.label || ''}：已用 ${Math.round(used)}%，剩余 ${Math.round(remaining)}%${
                window.resetAt ? `，${formatReset(window.resetAt)} 重置` : ''
              }`,
            },
            h('span', { style: usageStyles.label }, window.label || ''),
            h(
              'div',
              { style: usageStyles.track },
              h('div', {
                style: {
                  ...usageStyles.fill,
                  width: `${remaining}%`,
                  background: low ? '#d9534f' : 'var(--dsw-specific-accent, #4d6bfe)',
                },
              }),
            ),
            h('span', { style: usageStyles.percent }, `剩 ${Math.round(remaining)}%`),
          )
        }),
        untilText ? h('div', { style: usageStyles.hint }, untilText) : null,
      )
    }

    /** 设置 →「ChatGPT」页。 */
    function CodexSettings() {
      const [auth, setAuth] = useState(null)
      const [defaultModel, setDefaultModel] = useState('')
      const [autoConsult, setAutoConsult] = useState(true)
      const [allowLan, setAllowLan] = useState(false)
      const [delegateLight, setDelegateLight] = useState(false)
      const [gptNameDetect, setGptNameDetect] = useState(false)
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
          const path = force ? API + '?models=1' : API + '?models=1'
          const data = await request(path, { headers: { Accept: 'application/json' }, cache: 'no-store' })
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

      const loadAll = useCallback(async () => {
        try {
          const data = await loadState('')
          setAuth(data.auth || { loggedIn: false })
          if (!initialized.current) {
            initialized.current = true
            setDefaultModel(data.global.defaultModel || '')
            setAutoConsult(data.global.autoConsult !== false)
            setAllowLan(data.global.allowLanAccess === true)
            setDelegateLight(data.global.delegateLightTasks === true)
            setGptNameDetect(data.global.gptNameDetect === true)
            setDeepseekModel(data.global.deepseekModel || '')
          }
          if (data.auth && data.auth.loggedIn) {
            await loadModels(false)
            await loadResets()
          }
          await loadDeepseekModels()
        } catch (loadFailure) {
          setError(String(loadFailure.message || loadFailure))
        }
      }, [loadModels, loadResets, loadDeepseekModels])

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
            const opened = window.open(url, '_blank', 'noopener')
            if (!opened) setNotice('浏览器拦截了弹窗：点下方「点我复制授权链接」，粘贴到浏览器打开即可。')
            else setNotice('已打开 OpenAI 登录页；完成授权后本页会自动更新。')
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
            patch: { defaultModel, autoConsult, allowLanAccess: allowLan, delegateLightTasks: delegateLight, deepseekModel, gptNameDetect },
          })
          setNotice('已保存并生效。')
        } catch (saveFailure) {
          setError(String(saveFailure.message || saveFailure))
        } finally {
          setBusy(false)
        }
      }, [defaultModel, autoConsult, allowLan, delegateLight, deepseekModel, gptNameDetect])

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

      if (!auth) return h('div', { style: styles.hint }, 'ChatGPT 设置加载中…')

      const loggedIn = auth.loggedIn === true
      const untilDate = formatDate(auth.activeUntil)
      const today = new Date().toISOString().slice(0, 10)
      const untilText = untilDate
        ? untilDate >= today
          ? `订阅有效至 ${untilDate}`
          : `订阅周期至 ${untilDate}（已结束）`
        : ''
      const modelOptions = [...new Set([...(defaultModel ? [defaultModel] : []), ...models.map((item) => item.slug)])]

      return h(
        'div',
        { style: styles.page },
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
        /**
         * 只读解析当前会话的模型目录（用于决定胶囊显示名）。
         * modelDirectories 可能尚未就绪或未安装，失败时返回 null，胶囊回落到「ChatGPT」。
         */
        const resolveModelDirectory = (sessionId) => {
          if (!sessionId) return null
          try {
            const service = ctx.get('modelDirectories')
            if (!service || typeof service.directoryFor !== 'function') return null
            const directory = service.directoryFor(sessionId)
            return directory && directory.store ? directory : null
          } catch {
            return null
          }
        }

        ctx.slots.inject('conversation.input.left', () =>
          ctx.slots.register(
            {
              name: 'conversation.input.left',
              id: 'codex-toggle',
              order: 4,
              inject: (sessionId) => {
                const directory = resolveModelDirectory(sessionId)
                return {
                  sessionId,
                  directoryStore: directory ? directory.store : null,
                  loadModels: directory ? () => directory.load().catch(() => {}) : null,
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
            CodexSettings,
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
            (props) => h(CodexUsageCard, { wide: props && props.wide }),
          ),
        )
      },
    }
  },
})
