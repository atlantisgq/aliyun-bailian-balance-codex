import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildOverview,
  classifyStatus,
  extractCouponItems,
  formatCents,
  formatMoney,
  normalizeBalance,
  normalizeCoupons,
  renderOverviewText,
  toCents,
} from '../server/normalize.js'

test('money conversion is exact to cents and accepts formatted strings', () => {
  assert.equal(toCents('0.1'), 10)
  assert.equal(toCents('0.2'), 20)
  assert.equal(toCents('1.005'), 101)
  assert.equal(toCents('1,234.567'), 123457)
  assert.equal(toCents('¥ 12.30'), 1230)
  assert.equal(toCents(-1.005), -101)
  assert.equal(toCents(''), null)
  assert.equal(toCents('not money'), null)
  assert.equal(toCents('1e3'), null)
  assert.equal(formatCents(131), '1.31')
  assert.equal(formatCents(-131), '-1.31')
  assert.equal(formatMoney(undefined), '0.00')
  assert.equal(formatMoney('bad'), '0.00')
})

test('account balance normalizes fields and safely defaults missing values', () => {
  assert.deepEqual(normalizeBalance({
    Data: {
      Currency: 'CNY',
      AvailableAmount: '1.005',
      AvailableCashAmount: '0.10',
      CreditAmount: '20',
    },
  }), {
    currency: 'CNY',
    availableAmount: '1.01',
    cashAmount: '0.10',
    creditAmount: '20.00',
  })

  assert.deepEqual(normalizeBalance({ data: { availableAmount: '0.2' } }), {
    currency: 'CNY',
    availableAmount: '0.20',
    cashAmount: '0.00',
    creditAmount: '0.00',
  })
  assert.deepEqual(normalizeBalance(null), {
    currency: 'CNY',
    availableAmount: '0.00',
    cashAmount: '0.00',
    creditAmount: '0.00',
  })
})

test('coupon extraction supports the documented BSS nesting variants', () => {
  const one = { CashCouponId: 'one' }
  const two = { CashCouponId: 'two' }
  assert.deepEqual(extractCouponItems({ Data: { CashCoupon: [one] } }), [one])
  assert.deepEqual(extractCouponItems({ Data: { CashCoupons: { CashCoupon: [one, two] } } }), [one, two])
  assert.deepEqual(extractCouponItems({ CashCouponList: [one] }), [one])
  assert.deepEqual(extractCouponItems({ Data: [one, null, two] }), [one, two])
  assert.deepEqual(extractCouponItems({ Data: {} }), [])
})

test('coupon statuses map to available, expired, cancelled, and other', () => {
  assert.equal(classifyStatus('Available'), 'available')
  assert.equal(classifyStatus('availabletouse'), 'available')
  assert.equal(classifyStatus('Effective'), 'available')
  assert.equal(classifyStatus('Expired'), 'expired')
  assert.equal(classifyStatus('Cancelled'), 'cancelled')
  assert.equal(classifyStatus('Canceled'), 'cancelled')
  assert.equal(classifyStatus('Used'), 'other')
  assert.equal(classifyStatus(undefined), 'other')
})

test('coupon normalization filters status summaries, sums in cents, deduplicates, and sorts by expiry', () => {
  const response = {
    Success: true,
    Data: {
      CashCoupon: [
        {
          CashCouponId: 'a', CashCouponNo: 'A', Status: 'Available',
          NominalValue: '100', Balance: '0.10', ExpiryTime: '2026-11-05T00:00:00Z',
          EffectiveTime: '2026-10-01T00:00:00Z', ApplicableProducts: '百炼',
        },
        {
          CashCouponId: 'b', CashCouponNo: 'B', Status: 'AvailableToUse',
          NominalValue: '50', Balance: '0.20', ExpiryTime: '2026-10-30T00:00:00Z',
        },
        {
          CashCouponId: 'c', CashCouponNo: 'C', Status: 'Available',
          NominalValue: '2.555', Balance: '1.005', ExpiryTime: null,
        },
        {
          CashCouponId: 'd', CashCouponNo: 'D', Status: 'Expired',
          NominalValue: '10', Balance: '0', ExpiryTime: '2026-09-01T00:00:00Z',
        },
        {
          CashCouponId: 'e', CashCouponNo: 'E', Status: 'Cancelled',
          NominalValue: '20', Balance: '5', ExpiryTime: '2027-01-01T00:00:00Z',
        },
        {
          CashCouponId: 'f', CashCouponNo: 'F', Status: 'Used',
          NominalValue: '30', Balance: '0', ExpiryTime: 'invalid-date',
        },
        {
          CashCouponId: 'a', CashCouponNo: 'A', Status: 'Available',
          NominalValue: '100', Balance: '0.10', ExpiryTime: '2026-11-05T00:00:00Z',
        },
      ],
    },
  }

  const result = normalizeCoupons(response)
  assert.deepEqual(result.counts, { total: 6, available: 3, expired: 1, cancelled: 1, other: 1 })
  assert.equal(result.availableCount, 3)
  assert.equal(result.availableBalance, '1.31')
  assert.equal(result.availableNominalValue, '152.56')
  assert.equal(result.nearestExpiryTime, '2026-10-30T00:00:00.000Z')
  assert.deepEqual(result.items.map((item) => item.no), ['B', 'A', 'C', 'D', 'E', 'F'])
  assert.equal(result.items[2].expiryTime, null)
  assert.equal(result.items[3].statusLabel, '已过期')
  assert.equal(result.items[0].statusLabel, '可用')
  assert.equal(result.items[0].applicableProducts, '通用')
  assert.equal(result.items[1].applicableProducts, '百炼')
})

test('multiple coupon responses are merged and unknown coupon fields do not throw', () => {
  const result = normalizeCoupons([
    { Data: { CashCoupon: [{ CashCouponId: '1', Status: 'Available' }] } },
    { Data: { CashCoupon: [{ CashCouponId: '2', Status: 'Available' }] } },
  ])
  assert.equal(result.counts.total, 2)
  assert.equal(result.items[0].nominalValue, '0.00')
  assert.equal(result.items[0].balance, '0.00')
})

test('overview success is partial-friendly but false when both sections fail', () => {
  const balance = { currency: 'CNY', availableAmount: '1.00', cashAmount: '1.00', creditAmount: '0.00' }
  const coupons = { availableCount: 0, availableBalance: '0.00' }
  const oneError = [{ scope: 'coupons', code: 'NetworkError', message: '网络失败' }]

  assert.equal(buildOverview({ accountBalance: balance, cashCoupons: null, errors: oneError }).ok, true)
  assert.equal(buildOverview({ accountBalance: balance, cashCoupons: coupons, errors: oneError }).ok, true)
  assert.equal(buildOverview({ accountBalance: null, cashCoupons: null, errors: [
    { scope: 'balance', code: 'X', message: 'x' },
    { scope: 'coupons', code: 'Y', message: 'y' },
  ] }).ok, false)
  assert.equal(buildOverview({}).ok, false)
})

test('Chinese summary keeps account and coupon balances separate, shows partial errors, and redacts secrets', () => {
  const overview = buildOverview({
    fetchedAt: '2026-10-26T10:00:00.000Z',
    cached: true,
    accountBalance: {
      currency: 'CNY', availableAmount: '88.10', cashAmount: '60.00', creditAmount: '20.00',
    },
    cashCoupons: {
      counts: { total: 6, available: 6, expired: 0, cancelled: 0, other: 0 },
      availableCount: 6,
      availableBalance: '12.30',
      availableNominalValue: '30.00',
      nearestExpiryTime: '2026-11-01T00:00:00.000Z',
      items: Array.from({ length: 6 }, (_, index) => ({
        id: `id${index}`, no: `NO${index}`, status: 'available', statusLabel: '可用',
        balance: '6.15', nominalValue: '10.00', expiryTime: '2026-11-01T00:00:00.000Z',
        applicableProducts: '通用',
      })),
    },
    errors: [{ scope: 'coupons', code: 'NetworkError', message: '代金券接口暂时不可用' }],
  })
  const text = renderOverviewText(overview, { secrets: ['FAKE_SECRET_VALUE'] })
  assert.match(text, /【阿里云账户概览】/)
  assert.match(text, /30 秒缓存/)
  assert.match(text, /账户余额/)
  assert.match(text, /可用金额：¥88\.10/)
  assert.match(text, /现金代金券/)
  assert.match(text, /可用券：6 张，可用余额 ¥12\.30/)
  assert.match(text, /查询提示/)
  assert.match(text, /代金券接口暂时不可用/)
  assert.match(text, /另有 1 张可用券未逐条列出/)
  assert.match(text, /不等同于百炼 Token 配额/)
  assert.doesNotMatch(text, /总计：¥100\.40/)
  assert.doesNotMatch(text, /FAKE_SECRET_VALUE/)
})
