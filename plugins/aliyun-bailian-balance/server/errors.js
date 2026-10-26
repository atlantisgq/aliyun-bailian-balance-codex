// 错误类型与中文操作提示。
// 这里只输出我们自己的中文文案与稳定的机器码，绝不拼接阿里云原始错误正文。
export class BssError extends Error {
  constructor(kind, options = {}) {
    super(String(kind || 'unknown'))
    this.name = 'BssError'
    this.kind = String(kind || 'unknown')
    this.code = options.code ? String(options.code) : ''
    this.status = Number(options.status) || 0
  }
}

export const MISSING_CREDENTIALS_MESSAGE =
  '未检测到阿里云 AccessKey。请打开 Codex 左侧“阿里云余额与代金券”面板，填写只读 RAM AccessKey ID 和 AccessKey Secret。'

const HINTS = {
  InvalidAccessKey: 'AccessKey ID 无效或已被禁用。请在左侧面板重新填写有效 RAM 用户的 AccessKey。',
  SignatureMismatch: 'AccessKey Secret 不正确，或本机系统时间偏差过大，导致签名校验失败。请在左侧面板核对 Secret，并检查本机系统时间。',
  PermissionDenied: '当前 RAM 用户缺少查询余额或代金券的只读权限。请为该 RAM 用户授予 AliyunBSSReadOnlyAccess 后重试。',
  Throttled: '阿里云请求过于频繁，请稍等片刻再试。',
  ServiceUnavailable: '阿里云服务暂时不可用，请稍后重试。',
  NetworkError: '无法连接阿里云接口。请检查网络、代理、防火墙或 DNS 设置后重试。',
  QueryTimeout: '查询阿里云超时（10 秒内未返回）。请检查网络质量后重试。',
  InvalidResponse: '阿里云返回了无法解析的结果，请稍后重试。',
  BadRequest: '阿里云拒绝了查询请求。请确认 AccessKey 有效、RAM 权限正确后重试。',
  UnknownError: '查询阿里云时发生未知错误，请稍后重试；若持续失败，请检查 AccessKey 状态与 RAM 权限。',
}

export function codeFromRaw(rawCode) {
  const code = String(rawCode || '')
  if (!code) return ''
  if (/InvalidAccessKeyId|InvalidAccessKey|AccessKeyNotFound/i.test(code)) return 'InvalidAccessKey'
  if (/SignatureDoesNotMatch|InvalidSignature|IncompleteSignature|SignatureNonceUsed/i.test(code)) return 'SignatureMismatch'
  if (/NoPermission|Forbidden|AccessDenied|UnauthorizedOperation|NotAuthorized/i.test(code)) return 'PermissionDenied'
  if (/Throttl|TooManyRequests|RequestLimit/i.test(code)) return 'Throttled'
  if (/ServiceUnavailable|InternalError|InternalFailure/i.test(code)) return 'ServiceUnavailable'
  if (/InvalidParameter|MissingParameter|InvalidAction|InvalidVersion/i.test(code)) return 'BadRequest'
  return ''
}

function statusFallback(status) {
  if (status === 401 || status === 403) return 'PermissionDenied'
  if (status === 429) return 'Throttled'
  if (status === 408 || status === 504) return 'QueryTimeout'
  if (status >= 500) return 'ServiceUnavailable'
  return 'BadRequest'
}

/**
 * 把内部错误转换成可直接展示给用户的中文条目。
 * 返回 { scope, code, message }，不含任何密钥、Authorization 或签名。
 */
export function toUserError(scope, error) {
  const kind = error instanceof BssError ? error.kind : 'unknown'
  let code = ''

  if (kind === 'timeout') code = 'QueryTimeout'
  else if (kind === 'network') code = 'NetworkError'
  else if (kind === 'invalid-response') code = 'InvalidResponse'
  else if (kind === 'http') code = codeFromRaw(error.code) || statusFallback(error.status)
  else if (kind === 'api') code = codeFromRaw(error.code) || 'UnknownError'
  else code = 'UnknownError'

  return {
    scope: String(scope || 'unknown'),
    code,
    message: HINTS[code] || HINTS.UnknownError,
  }
}

export function missingCredentialsError() {
  return {
    scope: 'credentials',
    code: 'MissingCredentials',
    message: MISSING_CREDENTIALS_MESSAGE,
  }
}

/**
 * 纵深防御：把可能出现的密钥、Authorization 头与签名字段整体替换掉。
 * 注意：这里连字段名一起移除，保证输出里不会留下 "Authorization"/"Signature" 等线索。
 */
export function redact(text, secrets = []) {
  let out = String(text == null ? '' : text)
  for (const secret of secrets) {
    const value = String(secret == null ? '' : secret)
    if (value.length >= 4) out = out.split(value).join('[已隐藏]')
  }
  return out
    // 整行 Authorization 头（到行尾）。
    .replace(/[ \t]*authorization[ \t]*[:=][^\r\n]*/gi, ' [已隐藏]')
    // 任何 ACS3 授权串或签名字段。
    .replace(/\bACS3-HMAC-SHA256\b[^\r\n]*/gi, '[已隐藏]')
    .replace(/\b(?:Credential|SignedHeaders|Signature|SignatureNonce|SecurityToken)\s*=\s*[^\s,;]+/gi, '[已隐藏]')
    // 孤立的 32/64 位十六进制串（nonce / 签名 / 哈希）。
    .replace(/\b[A-Fa-f0-9]{32,128}\b/g, '[已隐藏]')
}
