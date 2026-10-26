import { createHash } from 'node:crypto'

/** 只保留最近几条记录，避免内存无界增长。 */
const MAX_ENTRIES = 8

export class TtlCache {
  constructor(ttlMs = 30_000, maxEntries = MAX_ENTRIES) {
    this.ttlMs = Math.max(0, Number(ttlMs) || 0)
    this.maxEntries = Math.max(1, Number(maxEntries) || MAX_ENTRIES)
    this.entries = new Map()
  }

  /** 命中返回 { value, ageMs }；过期或未命中返回 null。 */
  get(key, nowMs = Date.now()) {
    const entry = this.entries.get(key)
    if (!entry) return null
    const ageMs = Math.max(0, Number(nowMs) - Number(entry.storedAt))
    if (ageMs > this.ttlMs) {
      this.entries.delete(key)
      return null
    }
    return { value: entry.value, ageMs }
  }

  set(key, value, nowMs = Date.now()) {
    if (this.entries.has(key)) this.entries.delete(key)
    this.entries.set(key, { value, storedAt: Number(nowMs) })
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      this.entries.delete(oldest)
    }
  }

  delete(key) {
    this.entries.delete(key)
  }

  clear() {
    this.entries.clear()
  }

  get size() {
    return this.entries.size
  }
}

/** 用 AK/SK 的 SHA-256 指纹作为缓存键，内存里不保存明文凭据。 */
export function credentialFingerprint(accessKeyId, accessKeySecret) {
  return createHash('sha256')
    .update(`${String(accessKeyId || '')}\u0000${String(accessKeySecret || '')}`)
    .digest('hex')
}
