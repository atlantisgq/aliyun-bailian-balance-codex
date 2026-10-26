import test from 'node:test'
import assert from 'node:assert/strict'

import {
  BSS_ENDPOINT,
  BSS_VERSION,
  EMPTY_SHA256,
  buildSignedRequest,
  canonicalQuery,
  encodeRfc3986,
  isoUtc,
} from '../server/sign.js'

const AT_MS = Date.parse('2026-10-02T18:43:14Z')

function signed(action, nonce) {
  return buildSignedRequest({
    ak: 'AKIDEXAMPLE',
    sk: 'SECRETEXAMPLE',
    action,
    params: {},
    atMs: AT_MS,
    nonce,
  })
}

test('ACS3 golden fixture: QueryCashCoupons canonical request hash', () => {
  const request = signed('QueryCashCoupons', '5f43cbdada74105f329391f0de02e0d0')
  assert.equal(
    request.canonicalRequestHash,
    '05697a12923d5070b61e2145f59509bc01693d7eed967f51f3e10809bbf3d846',
  )
})

test('ACS3 golden fixture: QueryAccountBalance canonical request hash', () => {
  const request = signed('QueryAccountBalance', 'ed5b9e1d797dda0041263873b5accbc7')
  assert.equal(
    request.canonicalRequestHash,
    '1b12f48fe6dbe3a7b4ad2fafa881c34d53438812a506ce0dc0cb9327257fdca1',
  )
})

test('ACS3 canonical headers end with exactly one newline before the blank separator', () => {
  const request = signed('QueryCashCoupons', '5f43cbdada74105f329391f0de02e0d0')
  assert.equal(request.method, 'POST')
  assert.equal(request.url, `https://${BSS_ENDPOINT}/`)
  assert.equal(request.body, '')
  assert.match(request.canonicalRequest, /x-acs-version:2017-12-14\n\nhost;x-acs-action;/)
  assert.ok(request.canonicalRequest.endsWith(EMPTY_SHA256))
  assert.equal(request.headers['x-acs-version'], BSS_VERSION)
  assert.equal(request.headers.host, BSS_ENDPOINT)
  assert.match(request.headers.authorization, /^ACS3-HMAC-SHA256 Credential=AKIDEXAMPLE,/)
})

test('RFC3986 encoding, parameter sorting, and UTC timestamp are deterministic', () => {
  assert.equal(encodeRfc3986("a b!'()*~"), 'a%20b%21%27%28%29%2A~')
  assert.equal(canonicalQuery({ z: 'last', a: '中文 1', skip: undefined }), 'a=%E4%B8%AD%E6%96%87%201&z=last')
  assert.equal(isoUtc(AT_MS), '2026-10-02T18:43:14Z')
})

test('action and credentials are required', () => {
  assert.throws(() => buildSignedRequest({ ak: 'a', sk: 's' }), /action is required/)
  assert.throws(() => buildSignedRequest({ action: 'QueryAccountBalance', ak: 'a' }), /access key is required/)
})
