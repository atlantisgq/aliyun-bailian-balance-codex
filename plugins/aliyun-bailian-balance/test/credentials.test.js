import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  createCredentialStore,
  validateCredentials,
} from '../server/credential-store.js'
import {
  getCredentialStatus,
  readCredentials,
} from '../server/credentials.js'
import { TtlCache } from '../server/cache.js'
import {
  clearCredentials,
  getOverviewWithSecrets,
  saveCredentials,
} from '../server/index.js'

const AK = 'AK_CRED_TEST_DO_NOT_ECHO_123456'
const SK = 'SK_CRED_TEST_DO_NOT_ECHO_abcdef'
const AK_2 = 'AK_CRED_TEST_REPLACED_654321'
const SK_2 = 'SK_CRED_TEST_REPLACED_fedcba'
const ENV = {
  ALIYUN_ACCESS_KEY_ID: 'AK_ENV_FALLBACK_DO_NOT_ECHO',
  ALIYUN_ACCESS_KEY_SECRET: 'SK_ENV_FALLBACK_DO_NOT_ECHO',
}
const NOW = Date.UTC(2026, 9, 26, 10, 0, 0)
const NONCE = 'abcdef0123456789abcdef0123456789'

const fakeProtection = {
  async protect(text) {
    return Buffer.from(`test-v1:${text}`, 'utf8').toString('base64')
  },
  async unprotect(payload) {
    const decoded = Buffer.from(String(payload), 'base64').toString('utf8')
    if (!decoded.startsWith('test-v1:')) throw new Error('bad payload')
    return decoded.slice('test-v1:'.length)
  },
}

async function withTempStore(run) {
  const dir = await mkdtemp(join(tmpdir(), 'aliyun-cred-test-'))
  const filePath = join(dir, 'credentials.json')
  try {
    return await run({ dir, filePath })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

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

function successFetch(calls) {
  return async (url, options) => {
    calls.push({ url, options })
    if (actionOf(options) === 'QueryAccountBalance') {
      return jsonResponse({
        Success: true,
        Data: {
          Currency: 'CNY',
          AvailableAmount: '12.34',
          AvailableCashAmount: '12.34',
          CreditAmount: '0.00',
        },
      })
    }
    return jsonResponse({
      Success: true,
      Data: {
        CashCoupon: [{
          CashCouponId: 'cred-coupon',
          CashCouponNo: 'CRED-COUPON',
          Status: 'Available',
          NominalValue: '50.00',
          Balance: '20.00',
          ExpiryTime: '2027-01-01T00:00:00Z',
        }],
      },
    })
  }
}

test('credential file stores only protected payload and supports save/load/clear', async () => {
  await withTempStore(async ({ filePath }) => {
    const store = createCredentialStore({
      env: {},
      platform: 'win32',
      filePath,
      protection: fakeProtection,
    })

    assert.deepEqual(await store.load(), { ok: false, reason: 'missing' })
    assert.equal((await store.save({ accessKeyId: AK, accessKeySecret: SK })).ok, true)

    const raw = await readFile(filePath, 'utf8')
    assert.doesNotMatch(raw, new RegExp(`${AK}|${SK}`))
    assert.match(raw, /dpapi-current-user/)
    assert.match(raw, /"payload"/)

    const loaded = await store.load()
    assert.equal(loaded.ok, true)
    assert.equal(loaded.accessKeyId, AK)
    assert.equal(loaded.accessKeySecret, SK)

    assert.deepEqual(await store.clear(), { ok: true, removed: true })
    assert.deepEqual(await store.clear(), { ok: true, removed: false })
    assert.deepEqual(await store.load(), { ok: false, reason: 'missing' })
  })
})

test('saved DPAPI credentials take priority over environment variables', async () => {
  await withTempStore(async ({ filePath }) => {
    const store = createCredentialStore({
      env: {},
      platform: 'win32',
      filePath,
      protection: fakeProtection,
    })
    await store.save({ accessKeyId: AK, accessKeySecret: SK })

    const credentials = await readCredentials(ENV, { credentialStore: store, platform: 'win32' })
    assert.equal(credentials.ok, true)
    assert.equal(credentials.source, 'dpapi')
    assert.equal(credentials.accessKeyId, AK)
    assert.equal(credentials.accessKeySecret, SK)

    await store.clear()
    const fallback = await readCredentials(ENV, { credentialStore: store, platform: 'win32' })
    assert.equal(fallback.ok, true)
    assert.equal(fallback.source, 'environment')
    assert.equal(fallback.accessKeyId, ENV.ALIYUN_ACCESS_KEY_ID)
  })
})

test('a corrupted credential file degrades safely to environment variables', async () => {
  await withTempStore(async ({ filePath }) => {
    await writeFile(filePath, '{not valid json', 'utf8')
    const store = createCredentialStore({
      env: {},
      platform: 'win32',
      filePath,
      protection: fakeProtection,
    })

    const loaded = await store.load()
    assert.deepEqual(loaded, { ok: false, reason: 'unreadable' })

    const credentials = await readCredentials(ENV, { credentialStore: store, platform: 'win32' })
    assert.equal(credentials.ok, true)
    assert.equal(credentials.source, 'environment')

    const status = await getCredentialStatus(ENV, { credentialStore: store, platform: 'win32' })
    assert.equal(status.configured, true)
    assert.equal(status.source, 'environment')
  })
})

test('credential status never returns keys, paths, or storage errors', async () => {
  await withTempStore(async ({ filePath }) => {
    const store = createCredentialStore({
      env: {},
      platform: 'win32',
      filePath,
      protection: fakeProtection,
    })
    await store.save({ accessKeyId: AK, accessKeySecret: SK })

    const status = await getCredentialStatus({}, { credentialStore: store, platform: 'win32' })
    assert.deepEqual(status, {
      configured: true,
      source: 'dpapi',
      storage: 'windows-dpapi',
      canSave: true,
      missing: [],
    })

    const serialized = JSON.stringify(status)
    assert.doesNotMatch(serialized, new RegExp(`${AK}|${SK}`))
    assert.doesNotMatch(serialized, /credentials\.json|reason|error|path/i)
  })
})

test('save and clear invalidate the 30-second overview cache', async () => {
  await withTempStore(async ({ filePath }) => {
    const store = createCredentialStore({
      env: {},
      platform: 'win32',
      filePath,
      protection: fakeProtection,
    })
    const cache = new TtlCache(30_000)
    const calls = []
    const fetchImpl = successFetch(calls)
    const queryOptions = () => ({
      env: {},
      credentialStore: store,
      platform: 'win32',
      cache,
      fetchImpl,
      timeoutMs: 1_000,
      now: () => NOW,
      nonceFactory: () => NONCE,
    })

    const saved = await saveCredentials(
      { accessKeyId: AK, accessKeySecret: SK },
      { credentialStore: store, platform: 'win32', cache },
    )
    assert.equal(saved.ok, true)

    const first = await getOverviewWithSecrets(queryOptions())
    assert.equal(first.overview.ok, true)
    assert.equal(first.overview.cached, false)
    assert.equal(calls.length, 2)
    assert.match(calls[0].options.headers.authorization, new RegExp(`Credential=${AK},`))

    const replaced = await saveCredentials(
      { accessKeyId: AK_2, accessKeySecret: SK_2 },
      { credentialStore: store, platform: 'win32', cache },
    )
    assert.equal(replaced.ok, true)

    const second = await getOverviewWithSecrets(queryOptions())
    assert.equal(second.overview.cached, false)
    assert.equal(calls.length, 4)
    assert.match(calls[2].options.headers.authorization, new RegExp(`Credential=${AK_2},`))

    const cleared = await clearCredentials({
      env: {},
      credentialStore: store,
      platform: 'win32',
      cache,
    })
    assert.equal(cleared.ok, true)
    assert.equal(cleared.removed, true)

    const third = await getOverviewWithSecrets(queryOptions())
    assert.equal(third.overview.ok, false)
    assert.equal(third.overview.errors[0].code, 'MissingCredentials')
    assert.equal(calls.length, 4)

    const serialized = JSON.stringify([saved, replaced, cleared, first.overview, second.overview])
    for (const secret of [AK, SK, AK_2, SK_2]) {
      assert.doesNotMatch(serialized, new RegExp(secret))
    }
  })
})

test('credential validation rejects empty and non-ASCII values', () => {
  assert.equal(validateCredentials({ accessKeyId: '', accessKeySecret: SK }).reason, 'missing')
  assert.equal(validateCredentials({ accessKeyId: AK, accessKeySecret: '' }).reason, 'missing')
  assert.equal(validateCredentials({ accessKeyId: 'AK WITH SPACE', accessKeySecret: SK }).reason, 'invalid')
  assert.equal(validateCredentials({ accessKeyId: AK, accessKeySecret: '中文密钥' }).reason, 'invalid')
  const valid = validateCredentials({ accessKeyId: AK, accessKeySecret: SK })
  assert.equal(valid.ok, true)
})

// 命令沙箱内没有加载当前用户配置文件，DPAPI 会被系统拒绝；
// 单独用 ALIYUN_TEST_DPAPI=1 在正常用户上下文运行这项集成测试。
test('Windows DPAPI round-trips a fake credential and removes the file', {
  skip: process.platform !== 'win32' || process.env.ALIYUN_TEST_DPAPI !== '1',
  timeout: 60_000,
}, async () => {
  await withTempStore(async ({ filePath }) => {
    const store = createCredentialStore({ env: {}, platform: 'win32', filePath })
    const saved = await store.save({ accessKeyId: AK, accessKeySecret: SK })
    assert.equal(saved.ok, true, saved.reason)

    const loaded = await store.load()
    assert.equal(loaded.ok, true, loaded.reason)
    assert.equal(loaded.accessKeyId, AK)
    assert.equal(loaded.accessKeySecret, SK)

    const raw = await readFile(filePath, 'utf8')
    assert.doesNotMatch(raw, new RegExp(`${AK}|${SK}`))

    assert.deepEqual(await store.clear(), { ok: true, removed: true })
    assert.deepEqual(await store.load(), { ok: false, reason: 'missing' })
  })
})
