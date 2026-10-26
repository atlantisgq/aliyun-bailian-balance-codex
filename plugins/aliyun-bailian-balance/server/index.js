// 阿里云 BSS 只读查询的最小 MCP stdio 服务端，同时提供 Codex 全局面板。
// stdout 只用于 JSON-RPC；不要在这里写日志、密钥或阿里云原始错误正文。
import { createInterface } from 'node:readline'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

import { BSS_ENDPOINT, buildSignedRequest, createNonce } from './sign.js'
import {
  readCredentials,
  getCredentialStatus,
  canSaveCredentials,
} from './credentials.js'
import { defaultCredentialStore } from './credential-store.js'
import { TtlCache, credentialFingerprint } from './cache.js'
import {
  BssError,
  missingCredentialsError,
  redact,
  toUserError,
} from './errors.js'
import {
  buildOverview,
  normalizeBalance,
  normalizeCoupons,
  renderOverviewText,
} from './normalize.js'

export const SERVER_NAME = 'aliyun_balance'
export const SERVER_VERSION = '0.2.0'
export const TOOL_NAME = 'get_aliyun_overview'
export const DASHBOARD_TOOL_NAME = 'open_aliyun_dashboard'
export const STATUS_TOOL_NAME = 'get_credential_status'
export const SAVE_TOOL_NAME = 'save_aliyun_credentials'
export const CLEAR_TOOL_NAME = 'clear_aliyun_credentials'
export const DASHBOARD_URI = 'ui://aliyun-bailian-balance/dashboard'
export const DASHBOARD_MIME_TYPE = 'text/html;profile=mcp-app'
export const DEFAULT_TIMEOUT_MS = 10_000
export const CACHE_TTL_MS = 30_000
export const MCP_PROTOCOL_VERSION = '2024-11-05'
export const UI_PROTOCOL_VERSION = '2026-01-26'

const defaultCache = new TtlCache(CACHE_TTL_MS)

const APP_ONLY = {
  ui: { resourceUri: DASHBOARD_URI, visibility: ['app'] },
  'ui/resourceUri': DASHBOARD_URI,
}

export const TOOL_DEFINITION = Object.freeze({
  name: TOOL_NAME,
  title: '查询阿里云余额与代金券',
  description:
    '只读查询当前阿里云账户的可用金额、现金余额、信控额度及现金代金券。凭据来自 Codex 面板中保存的只读 RAM AccessKey（或可选的环境变量），不接受聊天参数中的 AccessKey。',
  inputSchema: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
  annotations: {
    title: '查询阿里云余额与代金券',
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
})

export const DASHBOARD_TOOL_DEFINITION = Object.freeze({
  name: DASHBOARD_TOOL_NAME,
  title: '打开阿里云余额面板',
  description: '打开“阿里云余额与代金券”常驻面板，用于保存只读凭据并查看余额与代金券。',
  inputSchema: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
  annotations: {
    title: '打开阿里云余额面板',
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  _meta: {
    ...APP_ONLY,
    'openai/ui': { entrypoints: [{ type: 'global' }] },
  },
})

export const STATUS_TOOL_DEFINITION = Object.freeze({
  name: STATUS_TOOL_NAME,
  title: '读取 AccessKey 配置状态',
  description: '返回是否已在本机保存阿里云只读 AccessKey；不返回任何密钥内容。',
  inputSchema: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
  annotations: {
    title: '读取 AccessKey 配置状态',
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  _meta: APP_ONLY,
})

export const SAVE_TOOL_DEFINITION = Object.freeze({
  name: SAVE_TOOL_NAME,
  title: '保存阿里云 AccessKey',
  description:
    '把只读 RAM AccessKey 用当前 Windows 用户的 DPAPI 加密后保存在本机，仅在面板内使用。',
  inputSchema: {
    type: 'object',
    properties: {
      accessKeyId: { type: 'string', minLength: 8, maxLength: 256 },
      accessKeySecret: { type: 'string', minLength: 8, maxLength: 256 },
    },
    required: ['accessKeyId', 'accessKeySecret'],
    additionalProperties: false,
  },
  annotations: {
    title: '保存阿里云 AccessKey',
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  _meta: APP_ONLY,
})

export const CLEAR_TOOL_DEFINITION = Object.freeze({
  name: CLEAR_TOOL_NAME,
  title: '清除已保存的 AccessKey',
  description: '删除本机保存的阿里云 AccessKey 密文文件。',
  inputSchema: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
  annotations: {
    title: '清除已保存的 AccessKey',
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  _meta: APP_ONLY,
})

export const TOOL_DEFINITIONS = Object.freeze([
  TOOL_DEFINITION,
  DASHBOARD_TOOL_DEFINITION,
  STATUS_TOOL_DEFINITION,
  SAVE_TOOL_DEFINITION,
  CLEAR_TOOL_DEFINITION,
])

export const DASHBOARD_RESOURCE = Object.freeze({
  uri: DASHBOARD_URI,
  name: 'aliyun-bailian-balance-dashboard',
  title: '阿里云余额与代金券',
  description: '阿里云账户余额与现金代金券面板，可在其中保存只读 AccessKey。',
  mimeType: DASHBOARD_MIME_TYPE,
  _meta: {
    ui: {
      prefersBorder: true,
      csp: { connectDomains: [], resourceDomains: [] },
    },
    'openai/ui': { availableDisplayModes: ['fullscreen'] },
  },
})

function readNowMs(now) {
  const value = typeof now === 'function' ? now() : now
  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric : Date.now()
}

function actionDefinitions() {
  return [
    {
      scope: 'balance',
      action: 'QueryAccountBalance',
      normalize: normalizeBalance,
      assign: 'accountBalance',
    },
    {
      scope: 'coupons',
      action: 'QueryCashCoupons',
      normalize: normalizeCoupons,
      assign: 'cashCoupons',
    },
  ]
}

async function fetchBssJson(options) {
  const {
    accessKeyId,
    accessKeySecret,
    action,
    fetchImpl,
    timeoutMs,
    atMs,
    nonceFactory,
  } = options

  const signed = buildSignedRequest({
    ak: accessKeyId,
    sk: accessKeySecret,
    action,
    params: {},
    endpoint: BSS_ENDPOINT,
    atMs,
    nonce: nonceFactory(),
  })

  const headers = { ...signed.headers }
  // fetch 会自行设置 Host；显式传入可能在部分运行环境造成签名不一致。
  delete headers.host
  delete headers.Host

  const url = signed.url + (signed.queryString ? `?${signed.queryString}` : '')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  timer.unref?.()

  const operation = (async () => {
    const response = await fetchImpl(url, {
      method: signed.method,
      headers,
      body: signed.body || undefined,
      signal: controller.signal,
    })

    const status = Number(response && response.status) || 0
    const ok = response && typeof response.ok === 'boolean'
      ? response.ok
      : status >= 200 && status < 300

    const text = await response.text()
    let json = null
    try {
      json = text ? JSON.parse(text) : null
    } catch {
      json = null
    }

    if (!ok) {
      // 保留稳定的阿里云错误码用于中文提示，但绝不保留或输出原始 Message。
      throw new BssError('http', {
        status,
        code: json && typeof json === 'object' ? json.Code : '',
      })
    }

    if (!json || typeof json !== 'object' || Array.isArray(json)) {
      throw new BssError('invalid-response', { status })
    }
    if (json.Success === false || (json.Code && json.Success !== true && json.Data === undefined)) {
      throw new BssError('api', {
        status,
        code: json.Code,
      })
    }
    return json
  })()

  const timeout = new Promise((_, reject) => {
    const fail = () => reject(new BssError('timeout'))
    if (controller.signal.aborted) fail()
    else controller.signal.addEventListener('abort', fail, { once: true })
  })

  try {
    return await Promise.race([operation, timeout])
  } catch (error) {
    if (error instanceof BssError) throw error
    if (controller.signal.aborted || error?.name === 'TimeoutError' || error?.name === 'AbortError') {
      throw new BssError('timeout')
    }
    throw new BssError('network')
  } finally {
    clearTimeout(timer)
  }
}

/** 并行读取两个只读接口；任一接口失败不会阻止另一个结果。 */
export async function queryAliyun(options = {}) {
  const credentials = options.credentials || {}
  const accessKeyId = String(credentials.accessKeyId || '')
  const accessKeySecret = String(credentials.accessKeySecret || '')
  if (!accessKeyId || !accessKeySecret) throw new BssError('credentials')

  const fetchImpl = options.fetchImpl || globalThis.fetch
  const timeoutMs = Math.max(1, Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS)
  const atMs = readNowMs(options.now)
  const nextNonce = typeof options.nonceFactory === 'function'
    ? options.nonceFactory
    : createNonce

  const definitions = actionDefinitions()
  const settled = await Promise.allSettled(definitions.map(async (definition) => {
    const json = await fetchBssJson({
      accessKeyId,
      accessKeySecret,
      action: definition.action,
      fetchImpl,
      timeoutMs,
      atMs,
      nonceFactory: nextNonce,
    })
    return {
      scope: definition.scope,
      assign: definition.assign,
      value: definition.normalize(json),
    }
  }))

  const result = {
    accountBalance: null,
    cashCoupons: null,
    errors: [],
  }

  settled.forEach((entry, index) => {
    const definition = definitions[index]
    if (entry.status === 'fulfilled') {
      result[entry.value.assign] = entry.value.value
      return
    }
    const error = entry.reason instanceof BssError
      ? entry.reason
      : new BssError('unknown')
    result.errors.push(toUserError(definition.scope, error))
  })

  return result
}

function resolveStore(options = {}) {
  if (options && Object.prototype.hasOwnProperty.call(options, 'credentialStore')) {
    return options.credentialStore
  }
  return defaultCredentialStore
}

/** 保存或清除凭据后必须丢弃旧缓存，避免继续展示上一个 AccessKey 的结果。 */
export function clearOverviewCache(options = {}) {
  const cache = options && options.cache ? options.cache : null
  try {
    if (cache && typeof cache.clear === 'function') cache.clear()
  } catch {}
  try {
    defaultCache.clear()
  } catch {}
}

async function loadCredentials(options = {}) {
  const env = options.env || process.env
  return readCredentials(env, {
    credentialStore: resolveStore(options),
    platform: options.platform,
  })
}

/**
 * 获取可公开返回的账户概览（附带本次实际使用的密钥，仅用于输出前脱敏）。
 * 缺少凭据时不发起网络请求；缓存键只使用凭据指纹，不保存明文。
 */
export async function getOverviewWithSecrets(options = {}) {
  const cache = options.cache || defaultCache
  const now = options.now
  const atMs = readNowMs(now)
  const fetchedAt = new Date(atMs).toISOString()
  const credentials = await loadCredentials(options)

  if (!credentials.ok) {
    return {
      overview: buildOverview({
        fetchedAt,
        errors: [missingCredentialsError()],
        cached: false,
      }),
      secrets: [],
      credentials,
    }
  }

  const secrets = [credentials.accessKeyId, credentials.accessKeySecret].filter(Boolean)
  const cacheKey = credentialFingerprint(
    credentials.accessKeyId,
    credentials.accessKeySecret,
  )
  const cached = cache.get(cacheKey, atMs)
  if (cached) {
    return { overview: { ...cached.value, cached: true }, secrets, credentials }
  }

  let queried
  try {
    queried = await queryAliyun({
      credentials,
      fetchImpl: options.fetchImpl,
      timeoutMs: options.timeoutMs,
      now: () => atMs,
      nonceFactory: options.nonceFactory,
    })
  } catch (error) {
    const normalized = error instanceof BssError ? error : new BssError('unknown')
    queried = {
      accountBalance: null,
      cashCoupons: null,
      errors: [
        toUserError('balance', normalized),
        toUserError('coupons', normalized),
      ],
    }
  }

  const overview = buildOverview({
    ...queried,
    fetchedAt,
    cached: false,
  })

  if (overview.accountBalance !== null || overview.cashCoupons !== null) {
    cache.set(cacheKey, overview, atMs)
  }
  return { overview, secrets, credentials }
}

/** 兼容旧调用：只返回概览本身。 */
export async function getOverview(options = {}) {
  const { overview } = await getOverviewWithSecrets(options)
  return overview
}

function resultForTool(overview, secrets = []) {
  const text = redact(renderOverviewText(overview, { secrets }), secrets)
  return {
    content: [{ type: 'text', text }],
    structuredContent: overview,
    isError: !overview.ok,
  }
}

function appResult(structuredContent, isError = false) {
  const result = { content: [], structuredContent }
  if (isError) result.isError = true
  return result
}

const SAVE_MESSAGES = {
  missing: 'AccessKey ID 与 AccessKey Secret 都不能为空。',
  invalid: 'AccessKey 格式不正确，请粘贴完整的 AccessKey ID 和 Secret（仅限可见 ASCII 字符）。',
  'unsupported-platform': '当前系统不支持本机加密保存，请在受支持的 Windows 用户环境中使用面板。',
  'protect-failed': '无法使用 Windows 当前用户凭据加密保存，请确认不是受限账户或只读沙箱环境。',
  unreadable: '保存 AccessKey 时发生本机文件错误，请稍后重试。',
}

function trimmedField(value) {
  if (typeof value !== 'string') return ''
  return value.trim().slice(0, 256)
}

/** 保存只读 AccessKey；任何情况下都不回显密钥内容。 */
export async function saveCredentials(args = {}, options = {}) {
  const store = resolveStore(options)
  const platform = options.platform || process.platform
  if (!canSaveCredentials({ credentialStore: store, platform }) || !store || typeof store.save !== 'function') {
    return { ok: false, code: 'UnsupportedPlatform', message: SAVE_MESSAGES['unsupported-platform'] }
  }

  const accessKeyId = trimmedField(args.accessKeyId)
  const accessKeySecret = trimmedField(args.accessKeySecret)
  if (!accessKeyId || !accessKeySecret) {
    return { ok: false, code: 'MissingCredential', message: SAVE_MESSAGES.missing }
  }

  let saved
  try {
    saved = await store.save({ accessKeyId, accessKeySecret })
  } catch {
    saved = { ok: false, reason: 'protect-failed' }
  }

  if (!saved || !saved.ok) {
    const reason = saved && saved.reason ? String(saved.reason) : 'protect-failed'
    const code = reason === 'missing'
      ? 'MissingCredential'
      : reason === 'invalid' ? 'InvalidCredential' : 'SaveFailed'
    return {
      ok: false,
      code,
      message: SAVE_MESSAGES[reason] || SAVE_MESSAGES['protect-failed'],
    }
  }

  clearOverviewCache(options)
  return {
    ok: true,
    configured: true,
    source: 'dpapi',
    storage: 'windows-dpapi',
    canSave: true,
    missing: [],
    message: 'AccessKey 已用当前 Windows 用户加密保存，可以立即查询。',
  }
}

/** 删除本机保存的 AccessKey 密文，并清空缓存。 */
export async function clearCredentials(options = {}) {
  const store = resolveStore(options)
  const platform = options.platform || process.platform
  if (!store || typeof store.clear !== 'function') {
    return { ok: false, code: 'UnsupportedPlatform', message: SAVE_MESSAGES['unsupported-platform'] }
  }

  let cleared
  try {
    cleared = await store.clear()
  } catch {
    cleared = { ok: false, reason: 'unreadable' }
  }

  if (!cleared || !cleared.ok) {
    return { ok: false, code: 'ClearFailed', message: '清除本机 AccessKey 失败，请稍后重试。' }
  }

  clearOverviewCache(options)
  const status = await getCredentialStatus(options.env || process.env, {
    credentialStore: store,
    platform,
  })
  return {
    ...status,
    ok: true,
    removed: !!cleared.removed,
    message: cleared.removed
      ? '本机保存的 AccessKey 已删除。'
      : '本机没有保存的 AccessKey，无需删除。',
  }
}

let dashboardHtmlCache = null

async function readDashboardHtml(options = {}) {
  if (typeof options.readDashboard === 'function') {
    return String(await options.readDashboard())
  }
  if (dashboardHtmlCache !== null) return dashboardHtmlCache
  const text = await readFile(new URL('../ui/dashboard.html', import.meta.url), 'utf8')
  dashboardHtmlCache = text
  return text
}

function jsonRpcError(id, code, message, data) {
  const error = { code, message }
  if (data !== undefined) error.data = data
  return { jsonrpc: '2.0', id: id === undefined ? null : id, error }
}

async function callTool(name, args, options) {
  if (name === TOOL_NAME) {
    const { overview, secrets } = await getOverviewWithSecrets(options)
    return resultForTool(overview, secrets)
  }

  if (name === DASHBOARD_TOOL_NAME) {
    return appResult({ initialView: 'dashboard' })
  }

  if (name === STATUS_TOOL_NAME) {
    const status = await getCredentialStatus(options.env || process.env, {
      credentialStore: resolveStore(options),
      platform: options.platform,
    })
    return appResult(status)
  }

  if (name === SAVE_TOOL_NAME) {
    const saved = await saveCredentials(args, options)
    return appResult(saved, !saved.ok)
  }

  if (name === CLEAR_TOOL_NAME) {
    const cleared = await clearCredentials(options)
    return appResult(cleared, !cleared.ok)
  }

  return null
}

/** 处理一条已解析的 JSON-RPC 请求；notification 返回 null。 */
export async function handleRequest(message, options = {}) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    return jsonRpcError(null, -32600, 'Invalid Request')
  }

  const isNotification = message.id === undefined
  const id = message.id
  const method = String(message.method || '')

  if (isNotification) {
    // notifications/initialized 等通知无需响应，也不触发任何查询。
    return null
  }

  try {
    if (method === 'initialize') {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {
            tools: { listChanged: false },
            resources: { listChanged: false },
          },
          serverInfo: {
            name: SERVER_NAME,
            title: '阿里云余额与代金券',
            version: SERVER_VERSION,
          },
          instructions:
            '查询阿里云账户级余额与现金代金券。凭据可在 Codex 左侧“阿里云余额与代金券”面板中保存；不要把账户余额与代金券相加。',
        },
      }
    }

    if (method === 'ping') {
      return { jsonrpc: '2.0', id, result: {} }
    }

    if (method === 'tools/list') {
      return {
        jsonrpc: '2.0',
        id,
        result: { tools: TOOL_DEFINITIONS },
      }
    }

    if (method === 'resources/list') {
      return {
        jsonrpc: '2.0',
        id,
        result: { resources: [DASHBOARD_RESOURCE] },
      }
    }

    if (method === 'resources/templates/list') {
      return { jsonrpc: '2.0', id, result: { resourceTemplates: [] } }
    }

    if (method === 'resources/read') {
      const uri = String((message.params && message.params.uri) || '')
      if (uri !== DASHBOARD_URI) {
        return jsonRpcError(id, -32002, 'Resource not found', { uri })
      }
      const text = await readDashboardHtml(options)
      return {
        jsonrpc: '2.0',
        id,
        result: {
          contents: [{
            uri: DASHBOARD_URI,
            mimeType: DASHBOARD_MIME_TYPE,
            text,
            _meta: DASHBOARD_RESOURCE._meta,
          }],
        },
      }
    }

    if (method === 'tools/call') {
      const params = message.params && typeof message.params === 'object' ? message.params : {}
      const name = String(params.name || '')
      const args = params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments)
        ? params.arguments
        : {}

      // 只有写入类工具读取参数；查询工具刻意忽略聊天里附带的任何“密钥”字段。
      const result = await callTool(name, args, options)
      if (!result) return jsonRpcError(id, -32602, `Unknown tool: ${name}`)
      return { jsonrpc: '2.0', id, result }
    }

    return jsonRpcError(id, -32601, `Method not found: ${method}`)
  } catch {
    return jsonRpcError(id, -32603, 'Internal error')
  }
}

/** 解析单行 JSON-RPC；解析失败只返回稳定的协议错误，不回显原文。 */
export async function handleLine(line, options = {}) {
  const value = String(line == null ? '' : line).trim()
  if (!value) return null
  let message
  try {
    message = JSON.parse(value)
  } catch {
    return jsonRpcError(null, -32700, 'Parse error')
  }
  return handleRequest(message, options)
}

/** 启动逐行 JSON-RPC stdio 服务；这个函数不会写日志或回显输入。 */
export function startServer(options = {}) {
  const input = options.input || process.stdin
  const output = options.output || process.stdout
  const serverOptions = {
    env: options.env,
    platform: options.platform,
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs,
    now: options.now,
    cache: options.cache,
    credentialStore: options.credentialStore,
    readDashboard: options.readDashboard,
    nonceFactory: options.nonceFactory,
  }
  const lines = createInterface({ input, crlfDelay: Infinity })
  let queue = Promise.resolve()

  lines.on('line', (line) => {
    queue = queue.then(async () => {
      const response = await handleLine(line, serverOptions)
      if (response) output.write(`${JSON.stringify(response)}\n`)
    }).catch(() => {
      // 保持 stdio 纯净；协议层已返回稳定错误，不输出内部异常。
    })
  })

  return lines
}

const thisFile = fileURLToPath(import.meta.url)
const invokedFile = process.argv[1] ? resolve(process.argv[1]) : ''
if (invokedFile && thisFile.toLowerCase() === invokedFile.toLowerCase()) {
  startServer()
}
