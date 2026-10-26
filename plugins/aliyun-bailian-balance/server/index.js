// 阿里云 BSS 只读查询与最小 MCP stdio 服务端。
// stdout 只用于 JSON-RPC；不要在这里写日志、密钥或阿里云原始错误正文。
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

import { BSS_ENDPOINT, buildSignedRequest, createNonce } from './sign.js'
import { readCredentials } from './credentials.js'
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
export const SERVER_VERSION = '0.1.0'
export const TOOL_NAME = 'get_aliyun_overview'
export const DEFAULT_TIMEOUT_MS = 10_000
export const CACHE_TTL_MS = 30_000
export const MCP_PROTOCOL_VERSION = '2024-11-05'

const defaultCache = new TtlCache(CACHE_TTL_MS)

export const TOOL_DEFINITION = Object.freeze({
  name: TOOL_NAME,
  title: '查询阿里云余额与代金券',
  description:
    '只读查询当前阿里云账户的可用金额、现金余额、信控额度及现金代金券。凭据只从系统环境变量读取，不接受聊天参数中的 AccessKey。',
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

/**
 * 获取可公开返回的账户概览。
 * 缺少凭据时不发起网络请求；缓存键只使用凭据指纹，不保存明文。
 */
export async function getOverview(options = {}) {
  const env = options.env || process.env
  const cache = options.cache || defaultCache
  const now = options.now
  const atMs = readNowMs(now)
  const fetchedAt = new Date(atMs).toISOString()
  const credentials = readCredentials(env)

  if (!credentials.ok) {
    return buildOverview({
      fetchedAt,
      errors: [missingCredentialsError()],
      cached: false,
    })
  }

  const cacheKey = credentialFingerprint(
    credentials.accessKeyId,
    credentials.accessKeySecret,
  )
  const cached = cache.get(cacheKey, atMs)
  if (cached) {
    return { ...cached.value, cached: true }
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

function jsonRpcError(id, code, message, data) {
  const error = { code, message }
  if (data !== undefined) error.data = data
  return { jsonrpc: '2.0', id: id === undefined ? null : id, error }
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
          capabilities: { tools: { listChanged: false } },
          serverInfo: {
            name: SERVER_NAME,
            title: '阿里云余额与代金券',
            version: SERVER_VERSION,
          },
          instructions:
            '查询阿里云账户级余额与现金代金券。凭据只从系统环境变量读取；不要把账户余额与代金券相加。',
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
        result: { tools: [TOOL_DEFINITION] },
      }
    }

    if (method === 'tools/call') {
      const name = message.params && message.params.name
      if (name !== TOOL_NAME) {
        return jsonRpcError(id, -32602, `Unknown tool: ${String(name || '')}`)
      }

      // 刻意忽略 params.arguments。凭据只能来自进程环境变量。
      const overview = await getOverview(options)
      const env = options.env || process.env
      const secrets = [
        env.ALIYUN_ACCESS_KEY_ID,
        env.ALIYUN_ACCESS_KEY_SECRET,
      ].filter(Boolean)
      return {
        jsonrpc: '2.0',
        id,
        result: resultForTool(overview, secrets),
      }
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
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs,
    now: options.now,
    cache: options.cache,
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

