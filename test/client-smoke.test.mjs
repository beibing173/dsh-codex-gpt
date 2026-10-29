import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = readFileSync(join(root, 'client.js'), 'utf8')

/** 极简 React 桩：只做形状检查，不跑真实渲染。 */
function makeReact() {
  const noop = () => {}
  return {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: (init) => [typeof init === 'function' ? init() : init, noop],
    useRef: (init) => ({ current: init }),
    useEffect: noop,
    useMemo: (fn) => fn(),
    useCallback: (fn) => fn,
    useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
    Component: class {
      constructor(props) {
        this.props = props
        this.state = {}
      }
    },
  }
}

/** 在 Node 里执行客户端模块，返回它导出的模块对象。 */
function loadClientModule() {
  const registered = []
  const renderers = []
  const localeStore = {
    active: 'zh',
    listeners: new Set(),
    register() {
      return () => {}
    },
    subscribe(cb) {
      this.listeners.add(cb)
      return () => this.listeners.delete(cb)
    },
    getSnapshot() {
      return { active: this.active, locales: ['zh', 'en'], revision: 1 }
    },
  }
  const ctx = {
    locale: localeStore,
    effect: (fn) => {
      fn()
      return () => {}
    },
    slots: {
      inject: (name, fn) => fn(),
      register: (meta, Component) => {
        registered.push(meta)
        renderers.push({ meta, Component })
        return { dispose: () => {} }
      },
    },
    get: () => undefined,
  }

  const windowStub = {
    __ModuleLoader__: {
      load: (mod) => {
        const React = makeReact()
        const requireStub = (name) => {
          if (name === 'react') return React
          throw new Error(`unexpected require: ${name}`)
        }
        windowStub.__loaded = mod.factory(requireStub)
      },
    },
  }

  const run = new Function('window', 'localStorage', 'document', 'fetch', source)
  run(windowStub, undefined, undefined, () => Promise.reject(new Error('no network in smoke test')))

  const loaded = windowStub.__loaded
  assert.ok(loaded && typeof loaded.apply === 'function', '客户端模块应导出 apply')
  loaded.apply(ctx)
  return { loaded, registered, renderers, localeStore, ctx }
}

test('客户端模块能在 Node 里加载并完成 slot 注册（不会在加载/注册阶段崩）', () => {
  const { loaded, registered } = loadClientModule()
  assert.equal(loaded.name, 'codex-client')
  const names = registered.map((item) => item.name).sort()
  assert.deepEqual(names, ['conversation.input.left', 'settings.section', 'sidebar.footer.action'])
})

test('侧边栏卡片用 CardBoundary 包裹，渲染函数只建元素不执行组件', () => {
  const { renderers } = loadClientModule()
  const sidebar = renderers.find((item) => item.meta.name === 'sidebar.footer.action')
  assert.ok(sidebar, '缺少侧边栏 slot')
  const element = sidebar.Component({ wide: true })
  assert.equal(typeof element, 'object')
  assert.equal(typeof element.type, 'function', '外层应是兜底组件')
  assert.ok(element.children && element.children.length === 1, '兜底组件里应包着用量卡')
  assert.equal(typeof element.children[0].type, 'function')
})

test('设置页渲染函数能建元素（locale 服务缺失也不崩）', () => {
  const { renderers } = loadClientModule()
  const settings = renderers.find((item) => item.meta.name === 'settings.section')
  assert.ok(settings, '缺少设置页 slot')
  const element = settings.Component({})
  assert.equal(typeof element, 'object')
})

test('locale 快照不稳定时不会抛错（返回值被复用）', () => {
  const { renderers } = loadClientModule()
  const sidebar = renderers.find((item) => item.meta.name === 'sidebar.footer.action')
  // 只是确认反复建元素不会抛：真正的 getSnapshot 稳定性由组件内部缓存保证。
  for (let i = 0; i < 3; i += 1) {
    const element = sidebar.Component({ wide: true })
    assert.ok(element)
  }
})

test('客户端声明了 slots 依赖', () => {
  const { loaded } = loadClientModule()
  assert.ok(Array.isArray(loaded.inject), 'inject 应为数组')
  assert.ok(loaded.inject.includes('slots'), 'inject 应包含 slots')
})
test('没有 slots 服务时安静退出，不抛错（不能把整个客户端插件带崩）', () => {
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  const noop = () => {}
  const ReactStub = {
    createElement: () => null,
    useState: (init) => [typeof init === 'function' ? init() : init, noop],
    useRef: (init) => ({ current: init }),
    useEffect: noop,
    useMemo: (fn) => fn(),
    useCallback: (fn) => fn,
    useSyncExternalStore: (s, g) => g(),
    Component: class {},
  }
  let loaded
  const windowStub = {
    __ModuleLoader__: {
      load: (mod) => {
        loaded = mod.factory((name) => (name === 'react' ? ReactStub : (() => { throw new Error(name) })()))
      },
    },
  }
  new Function('window', 'localStorage', 'document', 'fetch', source)(windowStub, undefined, undefined, () => Promise.reject(new Error('no net')))
  const ctx = { get: () => undefined }
  assert.doesNotThrow(() => loaded.apply(ctx), 'ctx 没有 slots 时 apply 不应抛错')
})
