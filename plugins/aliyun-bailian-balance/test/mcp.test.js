import test from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough, Readable } from 'node:stream'

import {
  CLEAR_TOOL_NAME,
  DASHBOARD_MIME_TYPE,
  DASHBOARD_TOOL_NAME,
  DASHBOARD_URI,
  MCP_PROTOCOL_VERSION,
  SAVE_TOOL_NAME,
  SERVER_NAME,
  SERVER_VERSION,
  STATUS_TOOL_NAME,
  TOOL_NAME,
  startServer,
} from '../server/index.js'
import { TtlCache } from '../server/cache.js'

const ENV_AK = 'AK_MCP_ENV_DO_NOT_ECHO_123456'
const ENV_SK = 'SK_MCP_ENV_DO_NOT_ECHO_abcdef'
const SAVED_AK = 'AK_MCP_SAVED_DO_NOT_ECHO_654321'
const SAVED_SK = 'SK_MCP_SAVED_DO_NOT_ECHO_fedcba'
const SAVED_AK_2 = 'AK_MCP_REPLACED_DO_NOT_ECHO_112233'
const SAVED_SK_2 = 'SK_MCP_REPLACED_DO_NOT_ECHO_445566'
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

function createMemoryStore(initial = null) {
  let value = initial ? { ...initial } : null
  return {
    get value() {
      return value ? { ...value } : null
    },
    async load() {
      return value
        ? { ok: true, accessKeyId: value.accessKeyId, accessKeySecret: value.accessKeySecret }
        : { ok: false, reason: 'missing' }
    },
    async save(input) {
      const accessKeyId = String(input && input.accessKeyId || '').trim()
      const accessKeySecret = String(input && input.accessKeySecret || '').trim()
      if (!accessKeyId || !accessKeySecret) return { ok: false, reason: 'missing' }
      value = { accessKeyId, accessKeySecret }
      return { ok: true }
    },
    async clear() {
      const removed = Boolean(value)
      value = null
      return { ok: true, removed }
    },
  }
}

function createHarness(serverOptions = {}) {
  const input = new Readable({ read() {} })
  const output = new PassThrough()
  const messages = []
  const store = serverOptions.credentialStore || createMemoryStore()
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
    platform: 'win32',
    now: () => NOW,
    nonceFactory: () => NONCE,
    credentialStore: store,
    ...serverOptions,
  })
  return { input, output, messages, lines, store }
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

function request(harness, message) {
  harness.input.push(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
}

test('MCP initialize exposes the balance tools, dashboard resource, and global entrypoint', async () => {
  const harness = createHarness({
    env: {},
    fetchImpl: async () => {
      throw new Error('must not be called')
    },
  })

  request(harness, {
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'test-client', version: '1.0.0' },
    },
  })
  request(harness, { method: 'notifications/initialized' })
  request(harness, { id: 2, method: 'tools/list' })
  request(harness, { id: 3, method: 'resources/list' })
  request(harness, { id: 4, method: 'resources/templates/list' })
  request(harness, { id: 5, method: 'resources/read', params: { uri: DASHBOARD_URI } })

  const [initialize, list, resources, templates, read] = await waitForMessages(harness, 5)

  assert.equal(initialize.jsonrpc, '2.0')
  assert.equal(initialize.id, 1)
  assert.equal(initialize.result.protocolVersion, MCP_PROTOCOL_VERSION)
  assert.equal(initialize.result.serverInfo.name, SERVER_NAME)
  assert.equal(initialize.result.serverInfo.version, SERVER_VERSION)
  assert.equal(initialize.result.capabilities.tools.listChanged, false)
  assert.equal(initialize.result.capabilities.resources.listChanged, false)

  assert.equal(list.id, 2)
  assert.deepEqual(
    list.result.tools.map((tool) => tool.name),
    [TOOL_NAME, DASHBOARD_TOOL_NAME, STATUS_TOOL_NAME, SAVE_TOOL_NAME, CLEAR_TOOL_NAME],
  )

  const overviewTool = list.result.tools.find((tool) => tool.name === TOOL_NAME)
  assert.deepEqual(overviewTool.inputSchema, {
    type: 'object',
    properties: {},
    additionalProperties: false,
  })
  assert.deepEqual(overviewTool.annotations, {
    title: '查询阿里云余额与代金券',
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  })

  const dashboardTool = list.result.tools.find((tool) => tool.name === DASHBOARD_TOOL_NAME)
  assert.equal(dashboardTool._meta['ui/resourceUri'], DASHBOARD_URI)
  assert.deepEqual(dashboardTool._meta.ui.visibility, ['app'])
  assert.deepEqual(dashboardTool._meta['openai/ui'].entrypoints, [{ type: 'global' }])

  const saveTool = list.result.tools.find((tool) => tool.name === SAVE_TOOL_NAME)
  assert.equal(saveTool.annotations.readOnlyHint, false)
  assert.deepEqual(saveTool.inputSchema.required, ['accessKeyId', 'accessKeySecret'])

  const clearTool = list.result.tools.find((tool) => tool.name === CLEAR_TOOL_NAME)
  assert.equal(clearTool.annotations.destructiveHint, true)

  assert.equal(resources.id, 3)
  assert.equal(resources.result.resources.length, 1)
  const resource = resources.result.resources[0]
  assert.equal(resource.uri, DASHBOARD_URI)
  assert.equal(resource.mimeType, DASHBOARD_MIME_TYPE)
  assert.deepEqual(resource._meta['openai/ui'].availableDisplayModes, ['fullscreen'])

  assert.equal(templates.id, 4)
  assert.deepEqual(templates.result.resourceTemplates, [])

  assert.equal(read.id, 5)
  assert.equal(read.result.contents.length, 1)
  assert.equal(read.result.contents[0].uri, DASHBOARD_URI)
  assert.equal(read.result.contents[0].mimeType, DASHBOARD_MIME_TYPE)
  assert.match(read.result.contents[0].text, /<!DOCTYPE html>/)
  assert.match(read.result.contents[0].text, /ui\/initialize/)

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

  request(harness, {
    id: 7,
    method: 'tools/call',
    params: {
      name: TOOL_NAME,
      arguments: {
        ALIYUN_ACCESS_KEY_ID: CHAT_AK,
        ALIYUN_ACCESS_KEY_SECRET: CHAT_SK,
      },
    },
  })

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

test('dashboard tool returns the app view without querying', async () => {
  let calls = 0
  const harness = createHarness({
    env: {},
    fetchImpl: async () => {
      calls += 1
      throw new Error('must not be called')
    },
  })

  request(harness, {
    id: 8,
    method: 'tools/call',
    params: { name: DASHBOARD_TOOL_NAME, arguments: {} },
  })

  const [response] = await waitForMessages(harness, 1)
  assert.equal(response.id, 8)
  assert.equal(response.result.isError, undefined)
  assert.deepEqual(response.result.structuredContent, { initialView: 'dashboard' })
  assert.equal(calls, 0)

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

  request(harness, {
    id: 9,
    method: 'tools/call',
    params: { name: TOOL_NAME, arguments: {} },
  })

  const [response] = await waitForMessages(harness, 1)
  assert.equal(calls, 0)
  assert.equal(response.id, 9)
  assert.equal(response.result.isError, true)
  assert.equal(response.result.structuredContent.ok, false)
  assert.equal(response.result.structuredContent.errors[0].code, 'MissingCredentials')
  assert.match(response.result.content[0].text, /Codex 左侧/)
  assert.match(response.result.content[0].text, /只读 RAM AccessKey/)
  assert.doesNotMatch(response.result.content[0].text, /ALIYUN_ACCESS_KEY_ID|系统属性|重启 Codex/)

  closeHarness(harness)
})

test('credential status, save, replace, clear, and query cache invalidation work through MCP', async () => {
  const calls = []
  const harness = createHarness({
    env: {},
    fetchImpl: successfulFetch(calls),
    cache: new TtlCache(30_000),
    timeoutMs: 1_000,
  })

  request(harness, { id: 20, method: 'tools/call', params: { name: STATUS_TOOL_NAME, arguments: {} } })
  let [status] = await waitForMessages(harness, 1)
  assert.equal(status.result.structuredContent.configured, false)
  assert.equal(status.result.structuredContent.canSave, true)

  request(harness, {
    id: 21,
    method: 'tools/call',
    params: {
      name: SAVE_TOOL_NAME,
      arguments: { accessKeyId: SAVED_AK, accessKeySecret: SAVED_SK },
    },
  })
  const [saved] = await waitForMessages(harness, 2).then((messages) => messages.slice(1))
  assert.equal(saved.result.structuredContent.ok, true)
  assert.equal(saved.result.structuredContent.storage, 'windows-dpapi')
  assert.deepEqual(harness.store.value, { accessKeyId: SAVED_AK, accessKeySecret: SAVED_SK })
  assert.doesNotMatch(JSON.stringify(saved), new RegExp(`${SAVED_AK}|${SAVED_SK}`))

  request(harness, { id: 22, method: 'tools/call', params: { name: STATUS_TOOL_NAME, arguments: {} } })
  const [, , status2] = await waitForMessages(harness, 3)
  assert.equal(status2.result.structuredContent.configured, true)
  assert.equal(status2.result.structuredContent.source, 'dpapi')

  request(harness, { id: 23, method: 'tools/call', params: { name: TOOL_NAME, arguments: {} } })
  const messages = await waitForMessages(harness, 4)
  const firstOverview = messages[3]
  assert.equal(firstOverview.result.structuredContent.accountBalance.availableAmount, '66.60')
  assert.equal(calls.length, 2)
  assert.match(calls[0].options.headers.authorization, new RegExp(`Credential=${SAVED_AK},`))

  request(harness, {
    id: 24,
    method: 'tools/call',
    params: {
      name: SAVE_TOOL_NAME,
      arguments: { accessKeyId: SAVED_AK_2, accessKeySecret: SAVED_SK_2 },
    },
  })
  await waitForMessages(harness, 5)

  request(harness, { id: 25, method: 'tools/call', params: { name: TOOL_NAME, arguments: {} } })
  const afterReplace = await waitForMessages(harness, 6)
  assert.equal(afterReplace[5].result.structuredContent.cached, false)
  assert.equal(calls.length, 4)
  assert.match(calls[2].options.headers.authorization, new RegExp(`Credential=${SAVED_AK_2},`))

  request(harness, { id: 26, method: 'tools/call', params: { name: CLEAR_TOOL_NAME, arguments: {} } })
  const cleared = await waitForMessages(harness, 7)
  assert.equal(cleared[6].result.structuredContent.ok, true)
  assert.equal(cleared[6].result.structuredContent.removed, true)
  assert.equal(cleared[6].result.structuredContent.configured, false)
  assert.equal(harness.store.value, null)

  request(harness, { id: 27, method: 'tools/call', params: { name: TOOL_NAME, arguments: {} } })
  const afterClear = await waitForMessages(harness, 8)
  assert.equal(afterClear[7].result.structuredContent.ok, false)
  assert.equal(afterClear[7].result.structuredContent.errors[0].code, 'MissingCredentials')
  assert.equal(calls.length, 4)

  const serialized = JSON.stringify([status, saved, status2, firstOverview, cleared, afterClear[7]])
  for (const secret of [SAVED_AK, SAVED_SK, SAVED_AK_2, SAVED_SK_2]) {
    assert.doesNotMatch(serialized, new RegExp(secret))
  }
  assert.doesNotMatch(serialized, /Authorization|Credential=|SignedHeaders=|Signature=|ACS3-HMAC-SHA256/)

  closeHarness(harness)
})

test('save rejects an incomplete credential pair without storing it', async () => {
  const harness = createHarness({ env: {} })

  request(harness, {
    id: 30,
    method: 'tools/call',
    params: {
      name: SAVE_TOOL_NAME,
      arguments: { accessKeyId: 'AK_ONLY_FOR_TEST' },
    },
  })

  const [response] = await waitForMessages(harness, 1)
  assert.equal(response.result.isError, true)
  assert.equal(response.result.structuredContent.code, 'MissingCredential')
  assert.equal(harness.store.value, null)

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

  request(harness, {
    id: 11,
    method: 'tools/call',
    params: { name: 'not_a_tool', arguments: {} },
  })

  const [response] = await waitForMessages(harness, 1)
  assert.equal(calls, 0)
  assert.equal(response.id, 11)
  assert.equal(response.error.code, -32602)
  assert.match(response.error.message, /Unknown tool/)
  assert.equal(response.result, undefined)

  closeHarness(harness)
})