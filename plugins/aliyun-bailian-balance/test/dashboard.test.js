import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  DASHBOARD_MIME_TYPE,
  DASHBOARD_RESOURCE,
  DASHBOARD_URI,
  UI_PROTOCOL_VERSION,
} from '../server/index.js'

const html = readFileSync(new URL('../ui/dashboard.html', import.meta.url), 'utf8')

test('dashboard is a self-contained MCP app with no external or persistent storage', () => {
  assert.equal(DASHBOARD_MIME_TYPE, 'text/html;profile=mcp-app')
  assert.equal(DASHBOARD_URI, 'ui://aliyun-bailian-balance/dashboard')
  assert.deepEqual(DASHBOARD_RESOURCE._meta['openai/ui'].availableDisplayModes, ['fullscreen'])

  assert.match(html, /<meta charset="utf-8"/i)
  assert.match(html, /color-scheme:\s*light dark/)
  assert.doesNotMatch(html, /<script[^>]+\bsrc\s*=/i)
  assert.doesNotMatch(html, /<link[^>]+\bhref\s*=/i)
  assert.doesNotMatch(html, /\b(?:localStorage|sessionStorage|document\.cookie)\b/)
  assert.doesNotMatch(html, /\.innerHTML\b/)
  assert.doesNotMatch(html, /https?:\/\//)
})

test('dashboard initializes the MCP app protocol and reports its size', () => {
  assert.match(html, /ui\/initialize/)
  assert.match(html, new RegExp(UI_PROTOCOL_VERSION.replace(/\./g, '\\.')))
  assert.match(html, /ui\/notifications\/size-changed/)
  assert.match(html, /ResizeObserver/)
})

test('dashboard only accepts host messages and never renders dynamic HTML', () => {
  assert.match(html, /event\.source\s*!==\s*window\.parent/)
  assert.match(html, /window\.parent\.postMessage/)
  assert.doesNotMatch(html, /document\.write\s*\(/)
  assert.doesNotMatch(html, /insertAdjacentHTML/)
  assert.doesNotMatch(html, /eval\s*\(/)
  assert.doesNotMatch(html, /new Function/)
})

test('dashboard calls only the four expected Aliyun tools', () => {
  assert.match(html, /get_aliyun_overview/)
  assert.match(html, /get_credential_status/)
  assert.match(html, /save_aliyun_credentials/)
  assert.match(html, /clear_aliyun_credentials/)

  const names = [...html.matchAll(/'([a-z_]+)'/g)].map((match) => match[1])
  const toolNames = names.filter((name) => /^(?:get|save|clear|open)_/.test(name))
  assert.deepEqual(
    new Set(toolNames),
    new Set(['get_aliyun_overview', 'get_credential_status', 'save_aliyun_credentials', 'clear_aliyun_credentials']),
  )
})