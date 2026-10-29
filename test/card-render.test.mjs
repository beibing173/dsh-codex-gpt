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
