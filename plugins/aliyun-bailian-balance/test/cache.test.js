import test from 'node:test'
import assert from 'node:assert/strict'

import { TtlCache, credentialFingerprint } from '../server/cache.js'

test('cache expires only after the 30-second TTL', () => {
  const cache = new TtlCache(30_000)
  cache.set('account', { value: 1 }, 1_000_000)

  assert.deepEqual(cache.get('account', 1_000_000), { value: { value: 1 }, ageMs: 0 })
  assert.deepEqual(cache.get('account', 1_029_999), { value: { value: 1 }, ageMs: 29_999 })
  assert.deepEqual(cache.get('account', 1_030_000), { value: { value: 1 }, ageMs: 30_000 })
  assert.equal(cache.get('account', 1_030_001), null)
  assert.equal(cache.size, 0)
})

test('cache evicts the least recently inserted entry and refreshes existing keys', () => {
  const cache = new TtlCache(30_000, 2)
  cache.set('a', 1, 1)
  cache.set('b', 2, 2)
  cache.set('a', 3, 3)
  cache.set('c', 4, 4)

  assert.equal(cache.get('a', 4).value, 3)
  assert.equal(cache.get('b', 4), null)
  assert.equal(cache.get('c', 4).value, 4)
  assert.equal(cache.size, 2)
})

test('credential fingerprints are stable, distinct, and never contain plaintext', () => {
  const one = credentialFingerprint('AK_FINGERPRINT_TEST', 'SK_FINGERPRINT_TEST')
  const same = credentialFingerprint('AK_FINGERPRINT_TEST', 'SK_FINGERPRINT_TEST')
  const otherAk = credentialFingerprint('AK_OTHER_TEST', 'SK_FINGERPRINT_TEST')
  const otherSk = credentialFingerprint('AK_FINGERPRINT_TEST', 'SK_OTHER_TEST')

  assert.equal(one, same)
  assert.notEqual(one, otherAk)
  assert.notEqual(one, otherSk)
  assert.match(one, /^[a-f0-9]{64}$/)
  assert.doesNotMatch(one, /AK_FINGERPRINT_TEST|SK_FINGERPRINT_TEST/)
})
