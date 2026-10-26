import test from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough, Readable } from 'node:stream'

import {
  MCP_PROTOCOL_VERSION,
  SERVER_NAME,
  TOOL_NAME,
  startServer,
} from '../server/index.js'
import { TtlCache } from '../server/cache.js'

const ENV_AK = 'AK_MCP_ENV_DO_NOT_ECHO_123456'
const ENV_SK = 'SK_MCP_ENV_DO_NOT_ECHO_abcdef'
const CHAT_AK = 'AK_CHAT_FAKE_MUST_BE_IGNORED'
const CHAT_SK = 'SK_CHAT_FAKE_MUST_BE_IGNORED'
const NOW = Date.UTC(2026, 9, 26, 10, 0, 0)
const NONCE = 'fedcba9876543210fedcba9876543210'

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

function successfulFetch(calls = []) {
  return async (url, options) => {
    calls.push({ url, options })
    if (actionOf(options) === 'QueryAccountBalance') {
      return jsonResponse({
        Success: true,
        Data: {
          Currency: 'CNY',
          AvailableAmount: '66.60',
          AvailableCashAmount: '40.00',
          CreditAmount: '0.00',
        },
      })
    }
    return jsonResponse({
      Success: true,
      Data: {
        CashCoupon: [{
          CashCouponId: 'mcp-coupon',
          CashCouponNo: 'MCP-COUPON-1',
          Status: 'Available',
          NominalValue: '20.00',
          Balance: '8.80',
          ExpiryTime: '2026-12-01T00:00:00Z',
          ApplicableProducts: '百炼',
        }],
      },
    })
  }
}

function createHarness(serverOptions = {}) {
  const input = new Readable({ read() {} })
  const output = new PassThrough()
  const messages = []
  let buffer = ''
  output.on('data', (chunk) => {
    buffer += chunk.toString('utf8')
    for (;;) {
      const newline = buffer.indexOf('\n')
      if (newline < 0) break
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      if (line.trim()) messages.push(JSON.parse(line))
    }
  })
  const lines = startServer({
    input,
    output,
    env: {},
    now: () => NOW,
    nonceFactory: () => NONCE,
    ...serverOptions,
  })
  return { input, output, messages, lines }
}

async function waitForMessages(harness, count) {
  const deadline = Date.now() + 3_000
  while (harness.messages.length < count) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${count} MCP messages; got ${harness.messages.length}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return harness.messages
}

function closeHarness(harness) {
  harness.input.push(null)
  harness.output.destroy()
  harness.lines.close()
}

test('MCP initialize and tools/list expose an annotated read-only tool', async () => {
  const harness = createHarness({
    env: {},
    fetchImpl: async () => {
      throw new Error('must not be called')
    },
  })

  harness.input.push(`${JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'test-client', version: '1.0.0' },
    },
  })}\n`)
  harness.input.push(`${JSON.stringify({
    jsonrpc: '2.0',
    method: 'notifications/initialized',
  })}\n`)
  harness.input.push(`${JSON.stringify({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/list',
  })}\n`)

  const [initialize, list] = await waitForMessages(harness, 2)

  assert.equal(initialize.jsonrpc, '2.0')
  assert.equal(initialize.id, 1)
  assert.equal(initialize.result.protocolVersion, MCP_PROTOCOL_VERSION)
  assert.equal(initialize.result.serverInfo.name, SERVER_NAME)
  assert.equal(initialize.result.capabilities.tools.listChanged, false)

  assert.equal(list.id, 2)
  assert.equal(list.result.tools.length, 1)
  const tool = list.result.tools[0]
  assert.equal(tool.name, TOOL_NAME)
  assert.deepEqual(tool.inputSchema, {
    type: 'object',
    properties: {},
    additionalProperties: false,
  })
  assert.deepEqual(tool.annotations, {
    title: '查询阿里云余额与代金券',
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  })

  closeHarness(harness)
})

test('tools/call returns a Chinese summary and ignores credentials supplied in chat arguments', async () => {
  const calls = []
  const harness = createHarness({
    env: {
      ALIYUN_ACCESS_KEY_ID: ENV_AK,
      ALIYUN_ACCESS_KEY_SECRET: ENV_SK,
    },
    fetchImpl: successfulFetch(calls),
    cache: new TtlCache(30_000),
    timeoutMs: 1_000,
  })

  harness.input.push(`${JSON.stringify({
    jsonrpc: '2.0',
    id: 7,
    method: 'tools/call',
    params: {
      name: TOOL_NAME,
      arguments: {
        ALIYUN_ACCESS_KEY_ID: CHAT_AK,
        ALIYUN_ACCESS_KEY_SECRET: CHAT_SK,
      },
    },
  })}\n`)

  const [response] = await waitForMessages(harness, 1)
  assert.equal(response.id, 7)
  assert.equal(response.result.isError, false)
  assert.equal(response.result.structuredContent.ok, true)
  assert.equal(response.result.structuredContent.accountBalance.availableAmount, '66.60')
  assert.equal(response.result.structuredContent.cashCoupons.availableCount, 1)
  assert.equal(response.result.structuredContent.cashCoupons.availableBalance, '8.80')
  assert.match(response.result.content[0].text, /【阿里云账户概览】/)
  assert.match(response.result.content[0].text, /账户余额/)
  assert.match(response.result.content[0].text, /现金代金券/)
  assert.match(response.result.content[0].text, /百炼/)
  assert.match(response.result.content[0].text, /不等同于百炼 Token 配额/)

  assert.equal(calls.length, 2)
  for (const call of calls) {
    const authorization = call.options.headers.authorization
    assert.match(authorization, new RegExp(`Credential=${ENV_AK},`))
    assert.doesNotMatch(authorization, new RegExp(CHAT_AK))
    assert.doesNotMatch(authorization, new RegExp(CHAT_SK))
  }

  const serialized = JSON.stringify(response)
  for (const secret of [ENV_AK, ENV_SK, CHAT_AK, CHAT_SK]) {
    assert.doesNotMatch(serialized, new RegExp(secret))
  }
  assert.doesNotMatch(serialized, /Authorization|Credential=|SignedHeaders=|Signature=|ACS3-HMAC-SHA256/)

  closeHarness(harness)
})

test('tools/call reports missing credentials as an MCP tool error without network access', async () => {
  let calls = 0
  const harness = createHarness({
    env: {},
    fetchImpl: async () => {
      calls += 1
      throw new Error('must not be called')
    },
  })

  harness.input.push(`${JSON.stringify({
    jsonrpc: '2.0',
    id: 9,
    method: 'tools/call',
    params: { name: TOOL_NAME, arguments: {} },
  })}\n`)

  const [response] = await waitForMessages(harness, 1)
  assert.equal(calls, 0)
  assert.equal(response.id, 9)
  assert.equal(response.result.isError, true)
  assert.equal(response.result.structuredContent.ok, false)
  assert.equal(response.result.structuredContent.errors[0].code, 'MissingCredentials')
  assert.match(response.result.content[0].text, /ALIYUN_ACCESS_KEY_ID/)
  assert.match(response.result.content[0].text, /完全退出并重启 Codex/)

  closeHarness(harness)
})

test('unknown tools return a JSON-RPC error without running a query', async () => {
  let calls = 0
  const harness = createHarness({
    env: {
      ALIYUN_ACCESS_KEY_ID: ENV_AK,
      ALIYUN_ACCESS_KEY_SECRET: ENV_SK,
    },
    fetchImpl: async () => {
      calls += 1
      return jsonResponse({ Success: true, Data: {} })
    },
  })

  harness.input.push(`${JSON.stringify({
    jsonrpc: '2.0',
    id: 11,
    method: 'tools/call',
    params: { name: 'not_a_tool', arguments: {} },
  })}\n`)

  const [response] = await waitForMessages(harness, 1)
  assert.equal(calls, 0)
  assert.equal(response.id, 11)
  assert.equal(response.error.code, -32602)
  assert.match(response.error.message, /Unknown tool/)
  assert.equal(response.result, undefined)

  closeHarness(harness)
})