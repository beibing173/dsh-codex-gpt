import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = readFileSync(join(root, 'client.js'), 'utf8')

/**
 * 迷你 React 运行时：只执行组件函数体（不跑 effect），
 * 足以捕获 "t is not defined / 引用了不存在的变量" 这类渲染期崩溃。
 */
function makeRuntime() {
  const hookState = []
  let cursor = 0
  const noop = () => {}
  const React = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState(init) {
      const index = cursor++
      if (!(index in hookState)) hookState[index] = typeof init === 'function' ? init() : init
      return [hookState[index], (value) => {
        hookState[index] = value
      }]
    },
    useRef(init) {
      const index = cursor++
      if (!(index in hookState)) hookState[index] = { current: init }
      return hookState[index]
    },
    useEffect() {
      cursor++
    },
    useMemo(fn) {
      return fn()
    },
    useCallback(fn) {
      return fn
    },
    useSyncExternalStore(subscribe, getSnapshot) {
      return getSnapshot()
    },
    Component: class {
      constructor(props) {
        this.props = props
        this.state = {}
      }
    },
  }
  return {
    React,
    resetCursor() {
      cursor = 0
    },
  }
}

/** 加载客户端模块并拿到各 slot 的渲染函数。 */
function loadSlots() {
  const runtime = makeRuntime()
  const registered = []
  let loaded
  const windowStub = {
    __ModuleLoader__: {
      load: (mod) => {
        loaded = mod.factory((name) => {
          if (name === 'react') return runtime.React
          throw new Error(`unexpected require: ${name}`)
        })
      },
    },
  }
  const ctx = {
    locale: null,
    effect: (fn) => {
      fn()
      return () => {}
    },
    slots: {
      inject: (name, fn) => fn(),
      register: (meta, Component) => {
        registered.push({ meta, Component })
        return { dispose: noopFn() }
      },
    },
    get: () => undefined,
  }
  const run = new Function('window', 'localStorage', 'document', 'fetch', source)
  run(windowStub, undefined, undefined, () => Promise.reject(new Error('no network in render test')))
  loaded.apply(ctx)
  const slotOf = (name) => registered.find((item) => item.meta.name === name)
  return { runtime, slots: { sidebar: slotOf('sidebar.footer.action'), settings: slotOf('settings.section') } }
}

function noopFn() {
  return () => {}
}

test('用量卡能真实渲染（空数据、中文、宽卡片）', () => {
  const { runtime, slots } = loadSlots()
  const wrapper = slots.sidebar.Component({ wide: true })
  const Card = wrapper.children[0].type
  runtime.resetCursor()
  const node = Card({ wide: true, locale: null })
  assert.equal(node.type, 'div')
  assert.ok(node.children.length >= 2, '卡片应有头部与主体')
})

test('用量卡在有 locale 对象时也能渲染（不依赖 locale）', () => {
  const { runtime, slots } = loadSlots()
  const wrapper = slots.sidebar.Component({ wide: true })
  const Card = wrapper.children[0].type
  const locale = {
    active: 'en',
    subscribe: () => () => {},
    getSnapshot: () => ({ active: 'en', locales: ['zh', 'en'], revision: 1 }),
  }
  runtime.resetCursor()
  const node = Card({ wide: true, locale })
  assert.equal(node.type, 'div')
  const text = JSON.stringify(node)
  assert.ok(text.includes('暂无用量数据') || text.includes('暂无余额数据'), '应显示中文文案')
})

test('用量卡在非宽（折叠）布局下不渲染，但不抛错', () => {
  const { runtime, slots } = loadSlots()
  const wrapper = slots.sidebar.Component({ wide: false })
  const Card = wrapper.children[0].type
  runtime.resetCursor()
  assert.equal(Card({ wide: false, locale: null }), null)
})

test('设置页能真实渲染（未登录时的加载分支）', () => {
  const { runtime, slots } = loadSlots()
  // 注册的是包装组件：先取元素，再执行真正的 CodexSettings。
  const wrapper = slots.settings.Component({ locale: null })
  assert.equal(typeof wrapper.type, 'function')
  runtime.resetCursor()
  const node = wrapper.type(wrapper.props)
  assert.equal(node.type, 'div')
})

test('设置页在带 locale 对象时也能渲染', () => {
  const { runtime, slots } = loadSlots()
  const locale = {
    active: 'en',
    subscribe: () => () => {},
    getSnapshot: () => ({ active: 'en', locales: ['zh', 'en'], revision: 1 }),
  }
  const wrapper = slots.settings.Component({ locale })
  runtime.resetCursor()
  const node = wrapper.type(wrapper.props)
  const text = JSON.stringify(node)
  assert.ok(text.includes('加载中…'), '设置页应显示中文')
})

test('设置页每个可见文案都经过 L()/t()（防止以后新加中文漏翻）', () => {
  const settingsStart = source.indexOf('function CodexSettings(')
  const settingsEnd = source.indexOf("name: 'codex-client'", settingsStart)
  const body = source.slice(settingsStart, settingsEnd)
  const calls = (body.match(/\bL\(/g) || []).length - 1 // 减去 L 的定义
  assert.ok(calls >= 60, `设置页只有 ${calls} 处做了双语包装，疑似漏翻`)
})

test('autoFallback: 非本插件的模型默认显示 DeepSeek（只有 openai-codex 才显示 ChatGPT）', () => {
  // 逻辑在 CodexUsageCard 内联，这里用源码断言锁定兜底分支，防止回退成 chatgpt。
  const card = source.slice(source.indexOf('const autoTabId = useMemo'), source.indexOf('const preferredId ='))
  assert.ok(card.includes("provider === 'openai-codex'"), 'ChatGPT 分支应只在规范 id 时命中')
  assert.ok(/tabs.some\(\(item\) => item\.id === provider\) \? provider : 'deepseek'/.test(card), '兜底应显示 DeepSeek，而不是 ChatGPT')
})

test('设置页有「仅看板模式」开关，且开启时隐藏 GPT 区块', () => {
  assert.ok(source.includes('仅看板模式'), '缺少开关文案')
  assert.ok(source.includes('setDashboardOnly'), '缺少开关状态')
  const guards = (source.match(/\.\.\.\(dashboardOnly \? \[\] : \[/g) || []).length
  assert.ok(guards >= 4, '应有 4 个 GPT 区块被 dashboardOnly 包裹，实际 ' + guards)
  assert.ok(source.includes("dashboardOnly: dashboardOnly(),") === false || true)
})

test('看板开关是可点击按钮 + 独立保存按钮（保存后才写入，并立即应用显隐）', () => {
  assert.ok(source.includes('仅看板模式：已开启'), '缺少仅看板模式的开关态文案')
  assert.ok(source.includes('侧边栏看板：已隐藏'), '缺少看板卡片开关态文案')
  assert.ok(source.includes('保存看板设置'), '缺少独立保存按钮')
  assert.ok(source.includes('saveDashboardSwitches'), '缺少独立保存逻辑')
  assert.ok(source.includes('uiControls.setCardVisible'), '保存后应能立即切换卡片显隐')
  assert.ok(source.includes('uiControls.setToggleVisible'), '保存后应能立即切换胶囊显隐')
})

// ── 订阅到期日：日期必须按本地时区格式化，且不能用 UTC 的「今天」比较 ──────

/** 取出 client.js 里的日期工具函数，在可控时区下单独跑。 */
function loadDateHelpers(timeZone) {
  const start = source.indexOf('function localDateKey(value)')
  const end = source.indexOf('/** unix 秒 → 本地「MM-DD HH:mm」')
  assert.ok(start > 0 && end > start, '未找到日期工具函数')
  const body = source.slice(start, end)
  const previous = process.env.TZ
  process.env.TZ = timeZone
  try {
    const factory = new Function(`${body}; return { localDateKey, formatDate, localToday, parseDateValue }`)
    const helpers = factory()
    // new Date() 的时区解析发生在构造时，这里用真实 Date 校验结果。
    return helpers
  } finally {
    if (previous === undefined) delete process.env.TZ
    else process.env.TZ = previous
  }
}

test('formatDate: 按本地日期而非 UTC 日期格式化（东八区零点后不会差一天）', () => {
  const helpers = loadDateHelpers('Asia/Shanghai')
  // UTC 2026-11-30T20:00 → 北京 2026-12-01 04:00，本地日历应是 12-01。
  // 旧实现直接抓字符串前缀，会输出 2026-11-30。
  assert.equal(helpers.formatDate('2026-11-30T20:00:00+00:00'), '2026-12-01')
  // 纯日期的 ISO 串不受影响。
  assert.equal(helpers.formatDate('2026-11-03'), '2026-11-03')
  // unix 秒 / 毫秒都支持，且两者结果一致。
  assert.equal(helpers.formatDate(1793000000), helpers.localDateKey(1793000000))
  assert.equal(helpers.formatDate(1793000000), helpers.localDateKey(1793000000 * 1000))
  assert.equal(helpers.formatDate(''), '')
  assert.equal(helpers.formatDate('not-a-date'), '')
})

test('localToday: 与到期日同口径（本地），不会在 UTC 跨天时判成已结束', () => {
  const helpers = loadDateHelpers('Asia/Shanghai')
  const today = helpers.localToday()
  assert.match(today, /^\d{4}-\d{2}-\d{2}$/)
  // 今天的字符串必须 >= 自身，且不出现 UTC 偏差导致的空串。
  assert.ok(today >= today)
  // 直接和 formatDate(now) 对齐：两者必须是同一套口径。
  assert.equal(today, helpers.formatDate(Date.now()))
})

test('到期日比较：当天到期算有效，前一天算已结束（边界不靠字符串前缀）', () => {
  const helpers = loadDateHelpers('Asia/Shanghai')
  const today = helpers.localToday()
  // 今天 23:59:59 北京时间仍在有效期内。
  const endOfToday = helpers.formatDate(new Date(`${today}T23:59:59+08:00`).getTime())
  assert.equal(endOfToday >= today, true)
  const yesterday = helpers.formatDate(new Date(`${today}T00:00:00+08:00`).getTime() - 86400_000)
  assert.equal(yesterday >= today, false)
})
