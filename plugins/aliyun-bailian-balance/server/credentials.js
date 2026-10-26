// 凭据来源解析：优先使用本机 Windows DPAPI 加密保存的凭据，
// 其次回退到进程环境变量。绝不接受聊天工具参数中的凭据。
import { defaultCredentialStore } from './credential-store.js'

export const CREDENTIAL_KEYS = ['ALIYUN_ACCESS_KEY_ID', 'ALIYUN_ACCESS_KEY_SECRET']

export const SOURCE_DPAPI = 'dpapi'
export const SOURCE_ENVIRONMENT = 'environment'
export const SOURCE_NONE = 'none'

export const STORAGE_DPAPI = 'windows-dpapi'
export const STORAGE_ENVIRONMENT = 'process-environment'
export const STORAGE_NONE = 'none'

/** 只从进程环境变量读取只读 RAM AccessKey。 */
export function readEnvCredentials(env = process.env) {
  const source = env && typeof env === 'object' ? env : {}
  const accessKeyId = String(source.ALIYUN_ACCESS_KEY_ID || '').trim()
  const accessKeySecret = String(source.ALIYUN_ACCESS_KEY_SECRET || '').trim()
  const missing = []
  if (!accessKeyId) missing.push('ALIYUN_ACCESS_KEY_ID')
  if (!accessKeySecret) missing.push('ALIYUN_ACCESS_KEY_SECRET')
  if (missing.length) return { ok: false, missing }
  return { ok: true, accessKeyId, accessKeySecret, source: SOURCE_ENVIRONMENT }
}

function resolveStore(options) {
  if (Object.prototype.hasOwnProperty.call(options, 'credentialStore') && options.credentialStore !== undefined) return options.credentialStore
  return defaultCredentialStore
}

/**
 * 解析凭据：DPAPI 存储优先，环境变量作为可选后备。
 * 读取失败（不存在、损坏、DPAPI 不可用）一律安全降级，不抛出底层错误。
 */
export async function readCredentials(env = process.env, options = {}) {
  const store = resolveStore(options || {})

  if (store && typeof store.load === 'function') {
    try {
      const stored = await store.load()
      if (stored && stored.ok && stored.accessKeyId && stored.accessKeySecret) {
        return {
          ok: true,
          accessKeyId: String(stored.accessKeyId),
          accessKeySecret: String(stored.accessKeySecret),
          source: SOURCE_DPAPI,
        }
      }
    } catch {
      // 安全降级到环境变量。
    }
  }

  const fromEnv = readEnvCredentials(env)
  if (fromEnv.ok) return fromEnv
  return { ok: false, source: SOURCE_NONE, missing: CREDENTIAL_KEYS.slice() }
}

/** 是否可以由面板保存凭据：需要 Windows 下的 DPAPI 存储实现。 */
export function canSaveCredentials(options = {}) {
  const store = resolveStore(options || {})
  const platform = options.platform || process.platform
  return platform === 'win32' && !!store && typeof store.save === 'function'
}

/**
 * 供面板展示的凭据状态；不返回 AK/SK、文件路径或 DPAPI 底层错误。
 */
export async function getCredentialStatus(env = process.env, options = {}) {
  const credentials = await readCredentials(env, options)
  const canSave = canSaveCredentials(options)

  if (credentials.ok) {
    const isDpapi = credentials.source === SOURCE_DPAPI
    return {
      configured: true,
      source: isDpapi ? SOURCE_DPAPI : SOURCE_ENVIRONMENT,
      storage: isDpapi ? STORAGE_DPAPI : STORAGE_ENVIRONMENT,
      canSave,
      missing: [],
    }
  }

  return {
    configured: false,
    source: SOURCE_NONE,
    storage: STORAGE_NONE,
    canSave,
    missing: CREDENTIAL_KEYS.slice(),
  }
}