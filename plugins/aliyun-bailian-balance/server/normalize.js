// 阿里云 BSS 响应归一化与中文摘要渲染。
// 约定：金额一律为两位小数字符串；求和先转成整数「分」，避免浮点误差。
import { redact } from './errors.js'

const STATUS_LABELS = {
  available: '可用',
  expired: '已过期',
  cancelled: '已作废',
  other: '其他',
}

const SCOPE_LABELS = {
  balance: '账户余额',
  coupons: '代金券',
  credentials: '凭据',
  unknown: '查询',
}

/** 任意金额表示 → 整数分；无法解析返回 null。 */
export function toCents(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? toCents(String(value)) : null
  }
  if (typeof value !== 'string') return null

  const s = value.trim().replace(/[,\s\u00a5\uffe5]/g, '')
  if (!s) return null
  const match = /^([+-])?(\d*)(?:\.(\d*))?$/.exec(s)
  if (!match) return null
  const intPart = match[2] || ''
  const fracPart = match[3] || ''
  if (!intPart && !fracPart) return null

  const sign = match[1] === '-' ? -1 : 1
  let cents = BigInt(intPart || '0') * 100n + BigInt((fracPart + '00').slice(0, 2))
  const third = fracPart.length > 2 ? Number(fracPart[2]) : 0
  if (third >= 5) cents += 1n
  const max = BigInt(Number.MAX_SAFE_INTEGER)
  if (cents > max) cents = max
  return sign * Number(cents)
}

/** 整数分 → 两位小数字符串。 */
export function formatCents(cents) {
  const n = Number.isFinite(Number(cents)) ? Math.round(Number(cents)) : 0
  const sign = n < 0 ? '-' : ''
  const abs = Math.abs(n)
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`
}

/** 任意金额表示 → 两位小数字符串，缺失或非法按 0.00。 */
export function formatMoney(value) {
  const cents = toCents(value)
  return formatCents(cents === null ? 0 : cents)
}

function pickFirst(source, keys) {
  for (const key of keys) {
    if (source[key] !== undefined && source[key] !== null && source[key] !== '') return source[key]
  }
  return undefined
}

function payloadData(res) {
  if (!res || typeof res !== 'object') return {}
  const data = res.Data !== undefined ? res.Data : res.data
  return data && typeof data === 'object' ? data : {}
}

/** QueryAccountBalance → 账户级余额。 */
export function normalizeBalance(res) {
  const data = payloadData(res)
  return {
    currency: String(pickFirst(data, ['Currency', 'currency']) || 'CNY'),
    availableAmount: formatMoney(pickFirst(data, ['AvailableAmount', 'availableAmount'])),
    cashAmount: formatMoney(pickFirst(data, ['AvailableCashAmount', 'AvailableCash', 'cashAmount'])),
    creditAmount: formatMoney(pickFirst(data, ['CreditAmount', 'Credit', 'creditAmount'])),
  }
}

/** 从各种可能嵌套中取出代金券原始数组。 */
export function extractCouponItems(res) {
  if (!res || typeof res !== 'object') return []
  const data = payloadData(res)
  const candidates = [
    data.CashCoupons && data.CashCoupons.CashCoupon,
    data.CashCoupon,
    data.CashCoupons,
    data.CashCouponList,
    res.CashCoupon,
    res.CashCoupons && res.CashCoupons.CashCoupon,
    res.CashCoupons && res.CashCoupons.CashCoupons,
    res.CashCouponList,
    res.CashCoupons,
    data,
  ]
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate.filter((item) => item && typeof item === 'object')
  }
  return []
}

export function classifyStatus(status) {
  const s = String(status == null ? '' : status).trim().toLowerCase()
  if (s === 'available' || s === 'availabletouse' || s === 'effective') return 'available'
  if (s === 'expired') return 'expired'
  if (s === 'cancelled' || s === 'canceled' || s === 'invalid') return 'cancelled'
  return 'other'
}

function toIsoOrNull(value) {
  if (value === null || value === undefined || value === '') return null
  const ts = Date.parse(String(value))
  return Number.isFinite(ts) ? new Date(ts).toISOString() : null
}

function textOrEmpty(value) {
  return value === null || value === undefined ? '' : String(value).trim()
}

function expiryTs(item) {
  const ts = Date.parse(item && item.expiryTime ? item.expiryTime : '')
  return Number.isFinite(ts) ? ts : Infinity
}

/**
 * QueryCashCoupons → 代金券明细与统计。
 * 入参可以是单个响应，也可以是多个响应组成的数组（用于合并 EffectiveOrNot 两次查询）。
 */
export function normalizeCoupons(res) {
  const responses = Array.isArray(res) ? res : [res]
  const raw = responses.flatMap((item) => extractCouponItems(item))

  const seen = new Set()
  const items = []
  for (const source of raw) {
    const id = textOrEmpty(source.CashCouponId)
    const no = textOrEmpty(source.CashCouponNo)
    if (id || no) {
      const key = `${id}|${no}`
      if (seen.has(key)) continue
      seen.add(key)
    }
    const status = classifyStatus(source.Status)
    items.push({
      id,
      no,
      nominalValue: formatMoney(source.NominalValue),
      balance: formatMoney(source.Balance),
      status,
      statusLabel: STATUS_LABELS[status],
      effectiveTime: toIsoOrNull(source.EffectiveTime),
      expiryTime: toIsoOrNull(source.ExpiryTime),
      grantedTime: toIsoOrNull(source.GrantedTime),
      applicableProducts: textOrEmpty(source.ApplicableProducts) || '通用',
      applicableScenarios: textOrEmpty(source.ApplicableScenarios),
      description: textOrEmpty(source.Description),
    })
  }

  items.sort((a, b) => {
    const rank = (item) => (item.status === 'available' ? 0 : 1)
    const byStatus = rank(a) - rank(b)
    if (byStatus !== 0) return byStatus
    const byExpiry = expiryTs(a) - expiryTs(b)
    if (byExpiry !== 0) return byExpiry
    return a.no.localeCompare(b.no)
  })

  const counts = { total: items.length, available: 0, expired: 0, cancelled: 0, other: 0 }
  for (const item of items) counts[item.status] += 1

  const availableItems = items.filter((item) => item.status === 'available')
  const sumCents = (list, field) => list.reduce((acc, item) => acc + (toCents(item[field]) ?? 0), 0)
  const nearest = availableItems
    .map((item) => item.expiryTime)
    .filter(Boolean)
    .sort((a, b) => Date.parse(a) - Date.parse(b))[0] || null

  return {
    counts,
    availableCount: availableItems.length,
    availableBalance: formatCents(sumCents(availableItems, 'balance')),
    availableNominalValue: formatCents(sumCents(availableItems, 'nominalValue')),
    nearestExpiryTime: nearest,
    items,
  }
}

/** 组装公开响应契约。 */
export function buildOverview(input = {}) {
  const accountBalance = input.accountBalance === undefined ? null : input.accountBalance
  const cashCoupons = input.cashCoupons === undefined ? null : input.cashCoupons
  const errors = Array.isArray(input.errors)
    ? input.errors.map((item) => ({
      scope: String((item && item.scope) || 'unknown'),
      code: String((item && item.code) || 'UnknownError'),
      message: String((item && item.message) || ''),
    }))
    : []
  return {
    ok: (accountBalance !== null || cashCoupons !== null) && errors.length < 2,
    fetchedAt: String(input.fetchedAt || new Date().toISOString()),
    cached: !!input.cached,
    accountBalance,
    cashCoupons,
    errors,
  }
}

function formatChinaTime(iso) {
  if (!iso) return '未提供'
  const date = new Date(iso)
  if (!Number.isFinite(date.getTime())) return String(iso)
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date)
  const get = (type) => (parts.find((part) => part.type === type) || {}).value || ''
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`
}

function moneyText(currency, amount) {
  const unit = !currency || String(currency).toUpperCase() === 'CNY' ? '¥' : `${currency} `
  return `${unit}${amount}`
}

/** 生成供对话展示的中文紧凑摘要。 */
export function renderOverviewText(overview, options = {}) {
  const secrets = Array.isArray(options.secrets) ? options.secrets : []
  const lines = []
  const balance = overview && overview.accountBalance
  const coupons = overview && overview.cashCoupons
  const errors = (overview && overview.errors) || []

  const suffix = overview && overview.cached ? '（30 秒缓存）' : ''
  lines.push(`【阿里云账户概览】数据时间 ${formatChinaTime(overview && overview.fetchedAt)}（北京时间）${suffix}`)
  lines.push('')

  if (balance) {
    const currency = balance.currency || 'CNY'
    lines.push('账户余额')
    lines.push(`- 可用金额：${moneyText(currency, balance.availableAmount)}`)
    lines.push(`- 现金余额：${moneyText(currency, balance.cashAmount)}`)
    lines.push(`- 信控额度：${moneyText(currency, balance.creditAmount)}`)
    lines.push(`- 币种：${currency}`)
  } else {
    lines.push('账户余额：本次未获取（见下方查询提示）')
  }

  lines.push('')

  if (coupons) {
    const currency = (balance && balance.currency) || 'CNY'
    const counts = coupons.counts || { available: 0, expired: 0, cancelled: 0, other: 0, total: 0 }
    lines.push('现金代金券')
    lines.push(`- 可用券：${coupons.availableCount} 张，可用余额 ${moneyText(currency, coupons.availableBalance)}，面额合计 ${moneyText(currency, coupons.availableNominalValue)}`)
    lines.push(`- 最近到期：${formatChinaTime(coupons.nearestExpiryTime)}`)
    let stats = `- 状态统计：可用 ${counts.available} · 已过期 ${counts.expired} · 已作废 ${counts.cancelled}`
    if (counts.other) stats += ` · 其他 ${counts.other}`
    lines.push(stats)

    const availableItems = (coupons.items || []).filter((item) => item.status === 'available')
    if (availableItems.length) {
      lines.push('- 可用券明细：')
      for (const item of availableItems.slice(0, 5)) {
        const label = item.no ? `券号 ${item.no}` : (item.id ? `券 ID ${item.id}` : '未提供券号')
        const scope = item.applicableProducts || '通用'
        lines.push(`  · ${label}：余额 ${moneyText(currency, item.balance)} / 面额 ${moneyText(currency, item.nominalValue)}，至 ${formatChinaTime(item.expiryTime)}（${scope}）`)
      }
      if (availableItems.length > 5) lines.push(`  · 另有 ${availableItems.length - 5} 张可用券未逐条列出`)
    } else {
      lines.push('- 可用券明细：暂无可用券')
    }
  } else {
    lines.push('现金代金券：本次未获取（见下方查询提示）')
  }

  if (errors.length) {
    lines.push('')
    lines.push('查询提示')
    for (const error of errors) {
      const label = SCOPE_LABELS[error.scope] || '查询'
      lines.push(`- ${label}：${error.message}`)
    }
  }

  lines.push('')
  lines.push('说明：以上为阿里云账户级余额与现金券，不等同于百炼 Token 配额或消费明细。')
  return redact(lines.join('\n'), secrets)
}
