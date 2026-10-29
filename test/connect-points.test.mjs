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
