// 阿里云 BSS OpenAPI 的 ACS3-HMAC-SHA256 请求签名。
// 纯函数，无网络副作用；黄金用例见 test/sign.test.js。
import { createHash, createHmac, randomBytes } from 'node:crypto'

export const BSS_VERSION = '2017-12-14'
export const BSS_ENDPOINT = 'business.aliyuncs.com'
export const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'

/** RFC3986 编码：encodeURIComponent 之外再处理 !'()* 与 ~。 */
export function encodeRfc3986(value) {
  return encodeURIComponent(String(value))
    .replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())
    .replace(/%7E/g, '~')
}

export function sha256Hex(input) {
  return createHash('sha256').update(input).digest('hex')
}

export function hmacSha256Hex(key, input) {
  return createHmac('sha256', key).update(input).digest('hex')
}

/** ISO-8601 UTC，秒级精度，例如 2026-10-02T18:43:14Z。 */
export function isoUtc(ms) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')
}

export function createNonce() {
  return randomBytes(16).toString('hex')
}

/** 业务参数按名称排序后做 RFC3986 编码，并以 & 连接。 */
export function canonicalQuery(params = {}) {
  return Object.keys(params)
    .filter((key) => params[key] !== undefined && params[key] !== null)
    .sort()
    .map((key) => `${encodeRfc3986(key)}=${encodeRfc3986(params[key])}`)
    .join('&')
}

/**
 * 构造已签名的 POST 请求。
 * 业务参数默认放在 query，Action/Version 等走 x-acs-* 头。
 */
export function buildSignedRequest(options = {}) {
  const {
    ak,
    sk,
    action,
    params = {},
    endpoint = BSS_ENDPOINT,
    atMs = Date.now(),
    nonce = createNonce(),
    method = 'POST',
    uri = '/',
  } = options

  if (!action) throw new Error('action is required')
  if (!ak || !sk) throw new Error('access key is required')

  const queryString = canonicalQuery(params)
  const body = ''
  const headers = {
    host: endpoint,
    'x-acs-action': String(action),
    'x-acs-version': BSS_VERSION,
    'x-acs-date': isoUtc(atMs),
    'x-acs-signature-nonce': String(nonce),
    'x-acs-content-sha256': sha256Hex(body),
  }

  const names = Object.keys(headers).sort()
  const signedHeaders = names.join(';')
  // 每一行（含最后一行）都以 \n 结尾，随后由 join('\n') 补上字段间换行。
  const canonicalHeaders = names.map((name) => `${name}:${String(headers[name]).trim()}\n`).join('')
  const canonicalRequest = [method, uri, queryString, canonicalHeaders, signedHeaders, headers['x-acs-content-sha256']].join('\n')
  const canonicalRequestHash = sha256Hex(canonicalRequest)
  const stringToSign = `ACS3-HMAC-SHA256\n${canonicalRequestHash}`
  const signature = hmacSha256Hex(sk, stringToSign)

  return {
    method,
    url: `https://${endpoint}${uri}`,
    queryString,
    body,
    canonicalRequest,
    canonicalRequestHash,
    stringToSign,
    signature,
    headers: {
      ...headers,
      authorization: `ACS3-HMAC-SHA256 Credential=${ak},SignedHeaders=${signedHeaders},Signature=${signature}`,
    },
  }
}
