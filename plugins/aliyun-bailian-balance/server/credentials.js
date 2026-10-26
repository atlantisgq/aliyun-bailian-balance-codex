/** 只从进程环境变量读取只读 RAM AccessKey，绝不接受聊天参数。 */
export const CREDENTIAL_KEYS = ['ALIYUN_ACCESS_KEY_ID', 'ALIYUN_ACCESS_KEY_SECRET']

export function readCredentials(env = process.env) {
  const source = env && typeof env === 'object' ? env : {}
  const accessKeyId = String(source.ALIYUN_ACCESS_KEY_ID || '').trim()
  const accessKeySecret = String(source.ALIYUN_ACCESS_KEY_SECRET || '').trim()
  const missing = []
  if (!accessKeyId) missing.push('ALIYUN_ACCESS_KEY_ID')
  if (!accessKeySecret) missing.push('ALIYUN_ACCESS_KEY_SECRET')
  if (missing.length) return { ok: false, missing }
  return { ok: true, accessKeyId, accessKeySecret }
}
