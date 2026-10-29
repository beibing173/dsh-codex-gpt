import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = readFileSync(join(root, 'client.js'), 'utf8')

/** 用最小 React 桩加载客户端模块，取到 __test。 */
function loadModule() {
  const noop = () => {}
  const React = {
    createElement: () => null,
    useState: (init) => [typeof init === 'function' ? init() : init, noop],
    useRef: (init) => ({ current: init }),
    useEffect: noop,
    useMemo: (fn) => fn(),
    useCallback: (fn) => fn,
    useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
    Component: class {
      constructor(props) {
        this.props = props
      }
    },
  }
  let loaded
  const windowStub = {
    __ModuleLoader__: {
      load: (mod) => {
        loaded = mod.factory((name) => {
          if (name === 'react') return React
          throw new Error(`unexpected require: ${name}`)
        })
      },
    },
  }
  const run = new Function('window', 'localStorage', 'document', 'fetch', source)
  run(windowStub, undefined, undefined, () => Promise.reject(new Error('no network')))
  return loaded
}

const parse = loadModule().__test.parseConnectPoints

test('Trae：剩余取 credits.available，累计 total 只作说明', () => {
  const doc = {
    status: 'signed-in',
    credits: {
      total: 1450,
      consumed: 1450,
      available: 0,
      workAvailable: 0,
      generalAvailable: 0,
      accounts: [],
    },
    checkin: { checkedIn: true },
  }
  const points = parse('trae', doc)
  assert.equal(points.total, 0, '剩余积分为 0 时不能显示成总量 1450')
  assert.match(points.sub, /1450/)
  assert.match(points.checkin, /签到/)
})

test('Trae：没给 available 时退 work+general 之和', () => {
  const points = parse('trae', {
    status: 'signed-in',
    credits: { total: 900, workAvailable: 120, generalAvailable: 30 },
  })
  assert.equal(points.total, 150)
})

test('WorkBuddy：total 就是剩余合计，附带即将过期提示', () => {
  const doc = {
    status: 'signed-in',
    credits: {
      total: 5600,
      packages: [
        { packageName: 'p1', remain: 100, size: 100 },
        { packageName: 'p2', remain: 5000, size: 5000 },
        { packageName: 'p3', remain: 500, size: 500 },
      ],
      expiringSoon: 100,
      nearestExpiryMs: 1795948370000,
    },
    checkin: { todayCheckedIn: true },
  }
  const points = parse('workbuddy', doc)
  assert.equal(points.total, 5600)
  assert.match(points.sub, /100/)
  assert.match(points.checkin, /签到/)
})

test('未登录 / 形状不对时返回 null（卡片不显示 0 误导）', () => {
  assert.equal(parse('trae', { status: 'signed-out' }), null)
  assert.equal(parse('trae', { status: 'signed-in' }), null)
  assert.equal(parse('workbuddy', { status: 'signed-in', credits: null }), null)
  assert.equal(parse('workbuddy', null), null)
  assert.equal(parse('unknown', { status: 'signed-in', credits: { total: 1 } }), null)
})

test('cards：卡片把 Trae / WorkBuddy 接进了切换列表（端点与 provider 都登记了）', () => {
  assert.ok(source.includes('/plugins/dsh-connect-trae/usage'), '缺少 Trae 用量端点')
  assert.ok(source.includes('/plugins/dsh-connect-workbuddy/usage'), '缺少 WorkBuddy 用量端点')
  assert.ok(source.includes("providers: ['trae', 'trae-enterprise']"), 'Trae provider 未登记')
  assert.ok(source.includes("providers: ['workbuddy', 'workbuddy-global']"), 'WorkBuddy provider 未登记')
})

test('企业版读不到个人积分时返回 null（不显示成 0）', () => {
  const doc = {
    status: 'signed-in',
    creditsUnavailable: 'enterprise',
    credits: { total: 0, available: 0, workAvailable: 0, generalAvailable: 0 },
  }
  assert.equal(parse('trae', doc), null)
})

test('第三方积分的加载用独立请求序号（不能和供应商列表互相丢弃结果）', () => {
  assert.ok(source.includes('const connectSeq = useRef(0)'), '缺少独立序号')
  const start = source.indexOf('const loadConnectPoints = useCallback')
  const end = source.indexOf('const loadPreferred = useCallback', start)
  assert.ok(start > 0 && end > start, '定位不到 loadConnectPoints')
  const body = source.slice(start, end)
  assert.ok(body.includes('connectSeq.current'), '应该用 connectSeq')
  assert.equal(body.includes('providersSeq.current'), false, '不应和供应商列表共用序号')
  assert.ok(body.includes('AbortSignal.timeout'), '应有请求超时，避免卡住刷新')
})

test('卡片页顺序：DeepSeek → ChatGPT → 其它 AI → WorkBuddy → Trae', () => {
  const tabsBlock = source.slice(source.indexOf('const tabs = useMemo'), source.indexOf('const autoTabId'))
  const ds = tabsBlock.indexOf("{ id: 'deepseek'")
  const gpt = tabsBlock.indexOf("{ id: 'chatgpt'")
  assert.ok(ds >= 0 && gpt >= 0, '缺少 deepseek / chatgpt 页')
  assert.ok(ds < gpt, 'DeepSeek 应排在 ChatGPT 之前')
  // 其它 AI 在循环里 push（位置在 connect 之前），connect 数组顺序决定 WB / TE
  const connectBlock = source.slice(source.indexOf('const CONNECT_PLUGINS = ['), source.indexOf('/**', source.indexOf('const CONNECT_PLUGINS = [')))
  const wb = connectBlock.indexOf("id: 'workbuddy'")
  const te = connectBlock.indexOf("id: 'trae'")
  assert.ok(wb >= 0 && te >= 0, 'connect 配置缺少 workbuddy / trae')
  assert.ok(wb < te, 'WorkBuddy 应排在 Trae 之前')
  assert.ok(tabsBlock.indexOf('CONNECT_PLUGINS') > tabsBlock.indexOf('for (const row of rows)'), '第三方积分应排在其它 AI 之后')
})
