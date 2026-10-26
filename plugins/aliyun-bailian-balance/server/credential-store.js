// Windows DPAPI（CurrentUser）凭据存储。
// 明文只存在于进程内存与本机 DPAPI 密文中；命令行参数、日志和返回值都不包含 AK/SK。
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const STORE_VERSION = 1
export const STORE_PROTECTION = 'dpapi-current-user'
export const DPAPI_ENTROPY = 'aliyun-bailian-balance-codex-v1'
export const MAX_POWERSHELL_OUTPUT = 64 * 1024
export const POWERSHELL_TIMEOUT_MS = 15_000

const PROTECT_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$inputText = [Console]::In.ReadToEnd().Trim()
$plainBytes = [Convert]::FromBase64String($inputText)
$entropy = [Text.Encoding]::UTF8.GetBytes('${DPAPI_ENTROPY}')
$cipherBytes = [Security.Cryptography.ProtectedData]::Protect(
  $plainBytes,
  $entropy,
  [Security.Cryptography.DataProtectionScope]::CurrentUser
)
[Console]::Out.Write([Convert]::ToBase64String($cipherBytes))
`

const UNPROTECT_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$inputText = [Console]::In.ReadToEnd().Trim()
$cipherBytes = [Convert]::FromBase64String($inputText)
$entropy = [Text.Encoding]::UTF8.GetBytes('${DPAPI_ENTROPY}')
$plainBytes = [Security.Cryptography.ProtectedData]::Unprotect(
  $cipherBytes,
  $entropy,
  [Security.Cryptography.DataProtectionScope]::CurrentUser
)
[Console]::Out.Write([Convert]::ToBase64String($plainBytes))
`

function encodedPowerShell(script) {
  return Buffer.from(String(script), 'utf16le').toString('base64')
}

function powershellPath(env) {
  const root = env.SystemRoot || env.windir || 'C:\\Windows'
  return join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

/** 执行固定脚本；stdin 只传 base64，敏感内容不会进入命令行或进程参数。 */
export function runPowerShell(script, inputBase64, options = {}) {
  const env = options.env || process.env
  const timeoutMs = Math.max(1, Number(options.timeoutMs) || POWERSHELL_TIMEOUT_MS)
  const executable = options.executable || powershellPath(env)
  const childEnv = { ...env }
  // 最小化暴露面：PowerShell 子进程不需要、也不应该看到阿里云环境变量。
  delete childEnv.ALIYUN_ACCESS_KEY_ID
  delete childEnv.ALIYUN_ACCESS_KEY_SECRET

  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(
        executable,
        ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodedPowerShell(script)],
        {
          env: childEnv,
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      )
    } catch {
      reject(new Error('powershell-unavailable'))
      return
    }

    let stdout = ''
    let stderrSize = 0
    let settled = false
    const finish = (fn, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { child.kill() } catch {}
      fn(value)
    }
    const timer = setTimeout(() => finish(reject, new Error('powershell-timeout')), timeoutMs)
    timer.unref?.()

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdout += chunk
      if (stdout.length > MAX_POWERSHELL_OUTPUT) {
        finish(reject, new Error('powershell-output-too-large'))
      }
    })
    child.stderr.on('data', (chunk) => {
      stderrSize += chunk.length
      if (stderrSize > MAX_POWERSHELL_OUTPUT) {
        finish(reject, new Error('powershell-output-too-large'))
      }
    })
    child.on('error', () => finish(reject, new Error('powershell-unavailable')))
    child.on('close', (code) => {
      if (code !== 0) {
        finish(reject, new Error('powershell-failed'))
        return
      }
      const value = stdout.trim()
      if (!value) {
        finish(reject, new Error('powershell-empty'))
        return
      }
      finish(resolve, value)
    })

    child.stdin.on('error', () => {})
    child.stdin.end(String(inputBase64 || ''))
  })
}

/** 默认 DPAPI 保护器；测试可以注入同形状的假实现。 */
export function createDpapiProtection(options = {}) {
  const runner = options.runPowerShell || runPowerShell
  return {
    async protect(text) {
      const input = Buffer.from(String(text), 'utf8').toString('base64')
      return runner(PROTECT_SCRIPT, input, options)
    },
    async unprotect(cipherBase64) {
      const output = await runner(UNPROTECT_SCRIPT, String(cipherBase64 || ''), options)
      return Buffer.from(String(output), 'base64').toString('utf8')
    },
  }
}

export function defaultCredentialPath(env = process.env) {
  const localAppData = String(
    env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'),
  )
  return join(localAppData, 'aliyun-bailian-balance', 'credentials.json')
}

export function validateCredentials(input) {
  const accessKeyId = String(input && input.accessKeyId || '').trim()
  const accessKeySecret = String(input && input.accessKeySecret || '').trim()
  const missing = []
  if (!accessKeyId) missing.push('accessKeyId')
  if (!accessKeySecret) missing.push('accessKeySecret')
  if (missing.length) return { ok: false, reason: 'missing', missing }

  const safe = /^[\x21-\x7e]{8,256}$/
  if (!safe.test(accessKeyId) || !safe.test(accessKeySecret)) {
    return { ok: false, reason: 'invalid' }
  }
  return { ok: true, accessKeyId, accessKeySecret }
}

function parseStoredFile(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  if (value.version !== STORE_VERSION) return null
  if (value.protection !== STORE_PROTECTION) return null
  if (typeof value.payload !== 'string' || !value.payload) return null
  return value
}

async function writeAtomic(filePath, contents) {
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 })
  const temporary = `${filePath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  let handle
  try {
    handle = await open(temporary, 'wx', 0o600)
    await handle.writeFile(contents, 'utf8')
    await handle.sync()
    await handle.close()
    handle = null
    await rename(temporary, filePath)
  } catch (error) {
    if (handle) {
      try { await handle.close() } catch {}
    }
    try { await unlink(temporary) } catch {}
    throw error
  }
}

/**
 * 创建凭据仓库。读取失败（不存在、损坏、DPAPI 不可用）一律安全降级，
 * 不把底层错误或密文返回给上层。
 */
export function createCredentialStore(options = {}) {
  const env = options.env || process.env
  const platform = options.platform || process.platform
  const filePath = options.filePath || defaultCredentialPath(env)
  const protection = options.protection || createDpapiProtection({
    env,
    runPowerShell: options.runPowerShell,
    timeoutMs: options.timeoutMs,
  })

  async function load() {
    if (platform !== 'win32') return { ok: false, reason: 'unsupported-platform' }
    let raw
    try {
      raw = await readFile(filePath, 'utf8')
    } catch (error) {
      return {
        ok: false,
        reason: error && error.code === 'ENOENT' ? 'missing' : 'unreadable',
      }
    }

    let stored
    try {
      stored = parseStoredFile(JSON.parse(raw))
    } catch {
      stored = null
    }
    if (!stored) return { ok: false, reason: 'unreadable' }

    try {
      const plaintext = await protection.unprotect(stored.payload)
      const parsed = JSON.parse(plaintext)
      const validated = validateCredentials(parsed)
      if (!validated.ok) return { ok: false, reason: 'unreadable' }
      return {
        ok: true,
        accessKeyId: validated.accessKeyId,
        accessKeySecret: validated.accessKeySecret,
        updatedAt: typeof stored.updatedAt === 'string' ? stored.updatedAt : null,
        path: filePath,
      }
    } catch {
      return { ok: false, reason: 'unreadable' }
    }
  }

  async function save(credentials) {
    const validated = validateCredentials(credentials)
    if (!validated.ok) return validated
    if (platform !== 'win32') return { ok: false, reason: 'unsupported-platform' }

    try {
      const plaintext = JSON.stringify({
        accessKeyId: validated.accessKeyId,
        accessKeySecret: validated.accessKeySecret,
      })
      const payload = await protection.protect(plaintext)
      if (typeof payload !== 'string' || !payload.trim()) {
        return { ok: false, reason: 'protect-failed' }
      }
      const document = {
        version: STORE_VERSION,
        protection: STORE_PROTECTION,
        updatedAt: new Date().toISOString(),
        payload: payload.trim(),
      }
      await writeAtomic(filePath, `${JSON.stringify(document)}\n`)
      return { ok: true, path: filePath }
    } catch {
      return { ok: false, reason: 'protect-failed' }
    }
  }

  async function clear() {
    if (platform !== 'win32') return { ok: false, reason: 'unsupported-platform' }
    try {
      await unlink(filePath)
      return { ok: true, removed: true }
    } catch (error) {
      if (error && error.code === 'ENOENT') return { ok: true, removed: false }
      return { ok: false, reason: 'unreadable' }
    }
  }

  return { load, save, clear, filePath }
}

export const defaultCredentialStore = createCredentialStore()