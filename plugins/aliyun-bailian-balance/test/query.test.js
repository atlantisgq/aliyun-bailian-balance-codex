import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  CACHE_TTL_MS,
  DEFAULT_TIMEOUT_MS,
  getOverview,
  queryAliyun,
} from '../server/index.js'
import { TtlCache } from '../server/cache.js'
import { renderOverviewText } from '../server/normalize.js'

const AK = 'AK_QUERY_TEST_DO_NOT_ECHO_123456'
const SK = 'SK_QUERY_TEST_DO_NOT_ECHO_abcdef'
const ENV = {
  ALIYUN_ACCESS_KEY_ID: AK,
  ALIYUN_ACCESS_KEY_SECRET: SK,
}
const CREDENTIALS = { accessKeyId: AK, accessKeySecret: SK }
const NOW = Date.UTC(2026, 9, 26, 10, 0, 0)
const NONCE = '0123456789abcdef0123456789abcdef'

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return JSON.stringify(body)
    },
  }
}

function actionOf(options) {
  return options.headers['x-acs-action'] || options.headers['X-Acs-Action']
}

function balanceBody() {
  return {
    Success: true,
    Data: {
      Currency: 'CNY',
      AvailableAmount: '88.105',
      AvailableCashAmount: '60.10',
      CreditAmount: '20.00',
    },
  }
}

function couponBody() {
  return {
    Success: true,
    Data: {
      CashCoupon: [
        {
          CashCouponId: 'c1',
          CashCouponNo: 'COUPON-1',
          Status: 'Available',
          NominalValue: '30.00',
          Balance: '12.305',
          ExpiryTime: '2026-11-01T00:00:00Z',
        },
        {
          CashCouponId: 'c2',
          CashCouponNo: 'COUPON-2',
          Status: 'Expired',
          NominalValue: '10.00',
          Balance: '0.00',
          ExpiryTime: '2026-09-01T00:00:00Z',
        },
      ],
    },
  }
}

function successFetch(counter) {
  return async (url, options) => {
    if (counter) counter.calls.push({ url, options })
    const action = actionOf(options)
    if (action === 'QueryAccountBalance') return jsonResponse(balanceBody())
    if (action === 'QueryCashCoupons') return jsonResponse(couponBody())
    throw new Error(`unexpected action: ${action}`)
  }
}

test('queries both BSS actions in parallel with signed POST requests', async () => {
  const calls = []
  const resolvers = new Map()
  const fetchImpl = (url, options) => {
    calls.push({ url, options })
    const action = actionOf(options)
    return new Promise((resolve) => {
      resolvers.set(action, () => resolve(
        action === 'QueryAccountBalance'
          ? jsonResponse(balanceBody())
          : jsonResponse(couponBody()),
      ))
    })
  }

  const pending = queryAliyun({
    credentials: CREDENTIALS,
    fetchImpl,
    timeoutMs: 1_000,
    now: () => NOW,
    nonceFactory: () => NONCE,
  })

  assert.equal(calls.length, 2, 'both HTTP requests start before either one finishes')
  assert.deepEqual(
    new Set(calls.map((call) => actionOf(call.options))),
    new Set(['QueryAccountBalance', 'QueryCashCoupons']),
  )

  for (const call of calls) {
    assert.equal(call.url, 'https://business.aliyuncs.com/')
    assert.equal(call.options.method, 'POST')
    assert.equal(call.options.body, undefined)
    assert.equal(call.options.headers['x-acs-version'], '2017-12-14')
    assert.equal(call.options.headers['x-acs-date'], '2026-10-26T10:00:00Z')
    assert.equal(call.options.headers['x-acs-signature-nonce'], NONCE)
    assert.match(
      call.options.headers.authorization,
      /^ACS3-HMAC-SHA256 Credential=AK_QUERY_TEST_DO_NOT_ECHO_123456,SignedHeaders=/,
    )
  }

  resolvers.get('QueryAccountBalance')()
  resolvers.get('QueryCashCoupons')()
  const result = await pending

  assert.deepEqual(result.accountBalance, {
    currency: 'CNY',
    availableAmount: '88.11',
    cashAmount: '60.10',
    creditAmount: '20.00',
  })
  assert.equal(result.cashCoupons.availableCount, 1)
  assert.equal(result.cashCoupons.availableBalance, '12.31')
  assert.equal(result.cashCoupons.nearestExpiryTime, '2026-11-01T00:00:00.000Z')
  assert.deepEqual(result.errors, [])
})

test('a single failed interface still returns the other section with a Chinese hint', async () => {
  const calls = []
  const fetchImpl = async (url, options) => {
    calls.push({ url, options })
    if (actionOf(options) === 'QueryAccountBalance') return jsonResponse(balanceBody())
    return jsonResponse({ Code: 'NoPermission', Success: false }, 403)
  }

  const overview = await getOverview({
    env: ENV,
    fetchImpl,
    cache: new TtlCache(CACHE_TTL_MS),
    now: () => NOW,
    nonceFactory: () => NONCE,
  })

  assert.equal(calls.length, 2)
  assert.equal(overview.ok, true)
  assert.equal(overview.accountBalance.availableAmount, '88.11')
  assert.equal(overview.cashCoupons, null)
  assert.equal(overview.errors.length, 1)
  assert.equal(overview.errors[0].scope, 'coupons')
  assert.equal(overview.errors[0].code, 'PermissionDenied')
  assert.match(overview.errors[0].message, /AliyunBSSReadOnlyAccess/)
})

test('both failed interfaces produce ok false and two safe errors', async () => {
  const overview = await getOverview({
    env: ENV,
    fetchImpl: async () => jsonResponse({ Code: 'InternalError', Success: false }, 500),
    cache: new TtlCache(CACHE_TTL_MS),
    now: () => NOW,
    nonceFactory: () => NONCE,
  })

  assert.equal(overview.ok, false)
  assert.equal(overview.accountBalance, null)
  assert.equal(overview.cashCoupons, null)
  assert.deepEqual(overview.errors.map((error) => error.code), [
    'ServiceUnavailable',
    'ServiceUnavailable',
  ])
})

test('missing credentials fail fast without calling fetch', async () => {
  let calls = 0
  const overview = await getOverview({
    env: {},
    fetchImpl: async () => {
      calls += 1
      throw new Error('must not be called')
    },
    cache: new TtlCache(CACHE_TTL_MS),
    now: () => NOW,
  })

  assert.equal(calls, 0)
  assert.equal(overview.ok, false)
  assert.equal(overview.errors.length, 1)
  assert.equal(overview.errors[0].code, 'MissingCredentials')
  assert.match(overview.errors[0].message, /ALIYUN_ACCESS_KEY_ID/)
  assert.match(overview.errors[0].message, /ALIYUN_ACCESS_KEY_SECRET/)
})

test('30-second cache prevents repeated requests and expires on time', async () => {
  const counter = { calls: [] }
  const cache = new TtlCache(CACHE_TTL_MS)
  let nowMs = NOW
  const options = () => ({
    env: ENV,
    fetchImpl: successFetch(counter),
    cache,
    timeoutMs: 1_000,
    now: () => nowMs,
    nonceFactory: () => NONCE,
  })

  const first = await getOverview(options())
  assert.equal(first.cached, false)
  assert.equal(counter.calls.length, 2)

  nowMs += CACHE_TTL_MS - 1
  const second = await getOverview(options())
  assert.equal(second.cached, true)
  assert.equal(second.fetchedAt, first.fetchedAt)
  assert.equal(counter.calls.length, 2)

  nowMs += 2
  const third = await getOverview(options())
  assert.equal(third.cached, false)
  assert.equal(counter.calls.length, 4)
})

test('network, permission, and signature failures map to actionable Chinese messages', async () => {
  const cases = [
    {
      name: 'network',
      fetchImpl: async () => {
        throw new TypeError('socket hang up with secret detail')
      },
      code: 'NetworkError',
      hint: /网络、代理、防火墙或 DNS/,
    },
    {
      name: 'permission',
      fetchImpl: async () => jsonResponse({ Code: 'NoPermission' }, 403),
      code: 'PermissionDenied',
      hint: /AliyunBSSReadOnlyAccess/,
    },
    {
      name: 'signature',
      fetchImpl: async () => jsonResponse({ Code: 'SignatureDoesNotMatch' }, 400),
      code: 'SignatureMismatch',
      hint: /AccessKey Secret 不正确/,
    },
  ]

  for (const item of cases) {
    const overview = await getOverview({
      env: ENV,
      fetchImpl: item.fetchImpl,
      cache: new TtlCache(CACHE_TTL_MS),
      now: () => NOW,
      nonceFactory: () => NONCE,
    })
    assert.equal(overview.ok, false, item.name)
    assert.equal(overview.errors[0].code, item.code, item.name)
    assert.match(overview.errors[0].message, item.hint, item.name)
    assert.doesNotMatch(overview.errors[0].message, /socket hang up|secret detail/, item.name)
  }
})

test('a 504 HTTP response is reported as a query timeout', async () => {
  const overview = await getOverview({
    env: ENV,
    fetchImpl: async () => jsonResponse({ Code: 'GatewayTimeout' }, 504),
    cache: new TtlCache(CACHE_TTL_MS),
    now: () => NOW,
    nonceFactory: () => NONCE,
  })

  assert.equal(overview.ok, false)
  assert.deepEqual(overview.errors.map((error) => error.code), [
    'QueryTimeout',
    'QueryTimeout',
  ])
  assert.match(overview.errors[0].message, /10 秒内未返回/)
})

test('the 10-second timeout aborts a hanging request and degrades safely', async () => {
  let signalSeen = null
  const started = Date.now()
  const overview = await getOverview({
    env: ENV,
    fetchImpl: (url, options) => {
      signalSeen = options.signal
      return new Promise(() => {})
    },
    cache: new TtlCache(CACHE_TTL_MS),
    now: () => NOW,
    timeoutMs: 25,
    nonceFactory: () => NONCE,
  })

  assert.equal(DEFAULT_TIMEOUT_MS, 10_000)
  assert.ok(signalSeen)
  assert.ok(Date.now() - started < 1_500, 'test timeout should fire promptly')
  assert.equal(overview.ok, false)
  assert.deepEqual(overview.errors.map((error) => error.code), [
    'QueryTimeout',
    'QueryTimeout',
  ])
})

test('rendered output and normalized data never contain credentials or signing fields', async () => {
  const overview = await getOverview({
    env: ENV,
    fetchImpl: successFetch(),
    cache: new TtlCache(CACHE_TTL_MS),
    now: () => NOW,
    nonceFactory: () => NONCE,
  })
  const serialized = JSON.stringify(overview)
  const text = renderOverviewText(overview, { secrets: [AK, SK] })

  for (const output of [serialized, text]) {
    assert.doesNotMatch(output, new RegExp(AK))
    assert.doesNotMatch(output, new RegExp(SK))
    assert.doesNotMatch(output, /Authorization|Credential=|SignedHeaders=|Signature=|ACS3-HMAC-SHA256/)
  }
  assert.match(text, /账户余额/)
  assert.match(text, /现金代金券/)
  assert.match(text, /不等于百炼 Token 配额|不等同于百炼 Token 配额/)

  const serverDir = new URL('../server/', import.meta.url)
  for (const file of ['index.js', 'sign.js', 'cache.js', 'credentials.js', 'errors.js', 'normalize.js']) {
    const source = readFileSync(new URL(file, serverDir), 'utf8')
    assert.doesNotMatch(source, /\bconsole\.(?:log|info|warn|error|debug)\s*\(/, file)
    assert.doesNotMatch(source, /process\.stderr\b/, file)
  }
})