import test from 'node:test'
import assert from 'node:assert/strict'

import {
  BssError,
  MISSING_CREDENTIALS_MESSAGE,
  codeFromRaw,
  missingCredentialsError,
  redact,
  toUserError,
} from '../server/errors.js'

const SECRET_AK = 'AK_FAKE_DO_NOT_ECHO_123456'
const SECRET_SK = 'SK_FAKE_DO_NOT_ECHO_abcdef123456'

test('Aliyun error codes map to safe Chinese guidance', () => {
  const cases = [
    ['InvalidAccessKeyId.NotFound', /AccessKey ID 无效/],
    ['SignatureDoesNotMatch', /AccessKey Secret 不正确/],
    ['NoPermission', /AliyunBSSReadOnlyAccess/],
    ['Throttling.User', /请求过于频繁/],
    ['InternalError', /服务暂时不可用/],
    ['InvalidParameter', /拒绝了查询请求/],
  ]
  for (const [raw, expected] of cases) {
    const error = toUserError('balance', new BssError('http', { status: 400, code: raw }))
    assert.match(error.message, expected)
    assert.doesNotMatch(error.message, /[\u0000-\u001f]/)
  }
})

test('HTTP status fallbacks cover auth, throttling, timeout, and server failure', () => {
  assert.equal(toUserError('x', new BssError('http', { status: 401 })).code, 'PermissionDenied')
  assert.equal(toUserError('x', new BssError('http', { status: 403 })).code, 'PermissionDenied')
  assert.equal(toUserError('x', new BssError('http', { status: 429 })).code, 'Throttled')
  assert.equal(toUserError('x', new BssError('http', { status: 504 })).code, 'QueryTimeout')
  assert.equal(toUserError('x', new BssError('http', { status: 503 })).code, 'ServiceUnavailable')
})

test('transport failures have stable Chinese messages', () => {
  assert.equal(toUserError('balance', new BssError('network')).code, 'NetworkError')
  assert.match(toUserError('balance', new BssError('network')).message, /网络、代理、防火墙或 DNS/)
  assert.equal(toUserError('balance', new BssError('timeout')).code, 'QueryTimeout')
  assert.match(toUserError('balance', new BssError('timeout')).message, /10 秒/)
  assert.equal(toUserError('balance', new BssError('invalid-response')).code, 'InvalidResponse')
})

test('raw error messages, AK/SK, Authorization, and signatures do not leak into user errors', () => {
  const error = new BssError('api', { code: 'SignatureDoesNotMatch' })
  error.message = `Authorization: ACS3-HMAC-SHA256 Credential=${SECRET_AK},Signature=deadbeef ${SECRET_SK}`
  const output = JSON.stringify(toUserError('coupons', error))
  assert.doesNotMatch(output, new RegExp(SECRET_AK))
  assert.doesNotMatch(output, new RegExp(SECRET_SK))
  assert.doesNotMatch(output, /Authorization|Credential=|SignedHeaders=|Signature=|deadbeef|ACS3-HMAC-SHA256/i)

  const redacted = redact(
    `Authorization: ACS3-HMAC-SHA256 Credential=${SECRET_AK},SignedHeaders=host,Signature=0123456789abcdef ${SECRET_SK}`,
    [SECRET_AK, SECRET_SK],
  )
  assert.doesNotMatch(redacted, new RegExp(SECRET_AK))
  assert.doesNotMatch(redacted, new RegExp(SECRET_SK))
  assert.doesNotMatch(redacted, /Authorization|Credential=|SignedHeaders=|Signature=0123456789abcdef|ACS3-HMAC-SHA256/i)
})

test('missing credentials produce an actionable message and stable scope', () => {
  const error = missingCredentialsError()
  assert.equal(error.scope, 'credentials')
  assert.equal(error.code, 'MissingCredentials')
  assert.equal(error.message, MISSING_CREDENTIALS_MESSAGE)
  assert.match(error.message, /Codex 左侧/)
  assert.match(error.message, /只读 RAM AccessKey/)
  assert.match(error.message, /AccessKey Secret/)
  assert.doesNotMatch(error.message, /ALIYUN_ACCESS_KEY_ID|系统属性|环境变量|重启 Codex/)
})

test('code normalizer is case-insensitive and ignores unknown raw codes', () => {
  assert.equal(codeFromRaw('signaturedoesnotmatch'), 'SignatureMismatch')
  assert.equal(codeFromRaw('AccessDenied'), 'PermissionDenied')
  assert.equal(codeFromRaw('SomethingUnmapped'), '')
})
