/**
 * MCP server e2e (`npm run e2e:mcp`): boots the built server against Postgres
 * with tokens required (CONDUIT_MCP_REQUIRE_TOKEN=true) and the stub `claude`
 * CLI on PATH, mints tokens over the browser WebSocket like the Settings UI
 * does, then drives /api/mcp with the official MCP SDK client — over Streamable
 * HTTP and through the stdio bridge.
 *
 * Env overrides: CONDUIT_E2E_MCP_PORT (default 7561), CONDUIT_E2E_MCP_DB,
 * CONDUIT_E2E_PG. Requires `npm run build` and a reachable Postgres.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import WebSocket from 'ws'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import {
  repoRoot,
  stubBinDir,
  PG_BASE,
  ensureDatabase,
  requireBuild,
  startProcess,
  waitForOutput,
  stopProcess,
} from '../lib/harness.mjs'

const PORT = Number(process.env.CONDUIT_E2E_MCP_PORT) || 7561
const DB_NAME = process.env.CONDUIT_E2E_MCP_DB || 'conduit_e2e_mcp'
const BASE = `http://localhost:${PORT}`
const MCP_URL = `${BASE}/api/mcp`

let passed = 0
async function step(name, fn) {
  process.stdout.write(`[e2e:mcp] ${name} … `)
  await fn()
  passed++
  console.log('ok')
}

function openBrowserSocket() {
  const ws = new WebSocket(`ws://localhost:${PORT}/ws`)
  const pending = new Map()
  const events = []
  let nextId = 1
  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString())
    if (msg.type === 'event') events.push(msg)
    const p = msg.id && pending.get(msg.id)
    if (!p) return
    pending.delete(msg.id)
    if (msg.type === 'error') p.reject(new Error(msg.error))
    else p.resolve(msg.result)
  })
  const ready = new Promise((res, rej) => (ws.on('open', res), ws.on('error', rej)))
  const invoke = (channel, ...args) =>
    new Promise((resolve, reject) => {
      const id = String(nextId++)
      pending.set(id, { resolve, reject })
      ws.send(JSON.stringify({ type: 'invoke', id, channel, args }))
    })
  return { ws, ready, invoke, events }
}

async function httpClient(token) {
  const client = new Client({ name: 'conduit-e2e', version: '1' })
  await client.connect(
    new StreamableHTTPClientTransport(new URL(MCP_URL), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    })
  )
  return client
}

async function callJson(client, name, args = {}) {
  const res = await client.callTool({ name, arguments: args })
  const text = res.content[0].text
  if (res.isError) throw new Error(`${name} failed: ${text}`)
  return JSON.parse(text)
}

async function waitForRun(client, runId, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const { run } = await callJson(client, 'get_run', { runId })
    if (run.status !== 'running' && run.status !== 'launched') return run
    await new Promise((r) => setTimeout(r, 300))
  }
  throw new Error(`run ${runId} did not finish within ${timeoutMs}ms`)
}

function rawPost(headers = {}, body = { jsonrpc: '2.0', id: 1, method: 'ping' }) {
  return fetch(MCP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify(body),
  })
}

async function drive() {
  const browser = openBrowserSocket()
  await browser.ready

  let writeToken
  let readToken
  await step('mint read and write tokens over the browser WebSocket', async () => {
    const write = await browser.invoke('mcpTokens:create', { name: 'e2e write', scope: 'write', expiresInDays: 1 })
    const read = await browser.invoke('mcpTokens:create', { name: 'e2e read', scope: 'read' })
    assert.match(write.plaintext, /^cdt_/)
    assert.equal(write.token.tokenPrefix, write.plaintext.slice(0, 10))
    assert.equal(write.token.plaintext, undefined)
    writeToken = write.plaintext
    readToken = read
    const listed = await browser.invoke('mcpTokens:list')
    assert.equal(listed.length, 2)
    assert.ok(listed.every((t) => !('tokenHash' in t) && !('plaintext' in t)))
  })

  await step('reject missing/invalid tokens, GET, and cross-origin requests', async () => {
    const none = await rawPost()
    assert.equal(none.status, 401)
    assert.match(none.headers.get('www-authenticate') ?? '', /Bearer/)
    assert.equal((await rawPost({ Authorization: 'Bearer cdt_bogus' })).status, 401)
    assert.equal((await fetch(MCP_URL, { headers: { Authorization: `Bearer ${writeToken}` } })).status, 405)
    assert.equal((await rawPost({ Authorization: `Bearer ${writeToken}`, Origin: 'https://evil.example' })).status, 403)
  })

  const client = await httpClient(writeToken)

  await step('handshake advertises tools, prompts, resources, and instructions', async () => {
    assert.equal(client.getServerVersion()?.name, 'conduit')
    assert.match(client.getInstructions() ?? '', /get_conduit_status/)
    const tools = (await client.listTools()).tools.map((t) => t.name)
    assert.ok(tools.length >= 29, `expected ≥29 tools, got ${tools.length}`)
    const prompts = (await client.listPrompts()).prompts.map((p) => p.name)
    assert.deepEqual(prompts, ['investigate-run', 'improve-agent-prompt', 'triage-failures', 'design-agent'])
  })

  await step('get_conduit_status identifies the token', async () => {
    const status = await callJson(client, 'get_conduit_status')
    assert.equal(status.caller.scope, 'write')
    assert.equal(status.caller.tokenName, 'e2e write')
    assert.equal(status.workers.factory, 'local')
    assert.ok(status.runnerClis.find((c) => c.runner === 'claude')?.installed)
  })

  let agentId
  await step('create an agent and configure an MCP server with a secret header', async () => {
    const agent = await callJson(client, 'create_agent', {
      name: 'MCP e2e agent',
      runner: 'claude',
      prompt: 'Say hello.\nKeep it short.',
      envVars: { API_TOKEN: 'super-secret-value' },
    })
    agentId = agent.id
    assert.deepEqual(agent.envVars, { API_TOKEN: '[redacted]' })
    await callJson(client, 'set_agent_mcp_server', {
      agentId,
      key: 'e2e_remote',
      server: { type: 'http', url: 'https://mcp.example.com/mcp', headers: { Authorization: 'Bearer hunter2' } },
    })
    const detail = await client.callTool({ name: 'get_agent', arguments: { agentId } })
    const text = detail.content[0].text
    assert.ok(!text.includes('hunter2') && !text.includes('super-secret-value'), 'secrets must not leak')
    await callJson(client, 'set_agent_mcp_server', {
      agentId,
      key: 'e2e_remote',
      server: { type: 'http', url: 'https://mcp.example.com/mcp', headers: { Authorization: '[redacted]', 'X-Extra': '1' } },
    })
    const stored = await browser.invoke('agents:get', agentId)
    assert.equal(stored.mcpConfig.mcpServers.e2e_remote.headers.Authorization, 'Bearer hunter2')
    assert.equal(stored.mcpConfig.mcpServers.e2e_remote.headers['X-Extra'], '1')
  })

  await step('MCP writes broadcast entity:changed to open browsers', async () => {
    assert.ok(browser.events.some((e) => e.channel === 'entity:changed' && e.payload.id === agentId))
  })

  await step('start a run and read its digest and log', async () => {
    const started = await callJson(client, 'start_run', { agentId })
    const run = await waitForRun(client, started.id)
    assert.equal(run.status, 'completed')
    const { digest } = await callJson(client, 'get_run', { runId: started.id })
    assert.match(digest.lastAssistantMessages[0], /stub-claude received prompt: Say hello/)
    const page = await callJson(client, 'get_run_log', { runId: started.id, kinds: ['assistant'], tail: 5 })
    assert.ok(page.returned >= 1)
    const log = await client.readResource({ uri: `conduit://runs/${started.id}/log` })
    assert.match(log.contents[0].text, /assistant: stub-claude received prompt/)
  })

  let failingRevisionId
  await step('edit the prompt, record revisions, and attribute a failure to it', async () => {
    const edit = await callJson(client, 'edit_agent_prompt', {
      agentId,
      oldText: 'Keep it short.',
      newText: 'Keep it short. E2E_FAIL',
      note: 'e2e: introduce a failing instruction',
    })
    assert.match(edit.diff, /\+ Keep it short\. E2E_FAIL/)
    failingRevisionId = edit.revisionId
    const revisions = await callJson(client, 'list_prompt_revisions', { agentId })
    assert.deepEqual(revisions.map((r) => r.source), ['mcp', 'baseline'])
    assert.equal(revisions[0].isCurrent, true)

    const started = await callJson(client, 'start_run', { agentId })
    const run = await waitForRun(client, started.id)
    assert.equal(run.status, 'failed')
    const detail = await callJson(client, 'get_run', { runId: started.id })
    assert.equal(detail.failureKind, 'agent_error')
    assert.equal(detail.digest.result.isError, true)

    const perf = await callJson(client, 'get_prompt_performance', { agentId })
    const current = perf.revisions.find((r) => r.revisionId === failingRevisionId)
    assert.equal(current.byStatus.failed, 1)
    assert.equal(current.successRate, 0)
    const baseline = perf.revisions.find((r) => r.source === 'baseline')
    assert.equal(baseline.byStatus.completed, 1)

    const failed = await callJson(client, 'list_runs', { agentId, status: 'failed' })
    assert.equal(failed.runs[0].id, started.id)
  })

  await step('restore the baseline revision', async () => {
    const revisions = await callJson(client, 'list_prompt_revisions', { agentId })
    const baseline = revisions.find((r) => r.source === 'baseline')
    await callJson(client, 'restore_prompt_revision', { agentId, revisionId: baseline.id })
    const { prompt } = await callJson(client, 'get_agent_prompt', { agentId })
    assert.equal(prompt, 'Say hello.\nKeep it short.')
  })

  await step('UI prompt edits are recorded as revisions too', async () => {
    await browser.invoke('agents:update', agentId, { prompt: 'Say hello from the UI.' })
    await browser.invoke('agents:update', agentId, { prompt: 'Say hello from the UI!' })
    const revisions = await callJson(client, 'list_prompt_revisions', { agentId })
    assert.equal(revisions[0].source, 'ui')
    assert.equal(revisions.filter((r) => r.source === 'ui').length, 1, 'a burst of UI saves coalesces')
  })

  await step('create, update, and delete a cron trigger', async () => {
    const trigger = await callJson(client, 'create_trigger', {
      agentId, name: 'nightly', type: 'cron', cronExpression: '0 3 * * *', timezone: 'UTC', enabled: false,
    })
    const updated = await callJson(client, 'update_trigger', { triggerId: trigger.id, cronExpression: '30 3 * * *' })
    assert.deepEqual(updated.config, { expression: '30 3 * * *', timezone: 'UTC' })
    assert.equal((await callJson(client, 'list_triggers', { agentId })).length, 1)
    await callJson(client, 'delete_trigger', { triggerId: trigger.id })
    assert.equal((await callJson(client, 'list_triggers', { agentId })).length, 0)
  })

  await step('protocol prompts embed live context', async () => {
    const p = await client.getPrompt({ name: 'improve-agent-prompt', arguments: { agentId } })
    assert.match(p.messages[0].content.text, /<prompt>\nSay hello from the UI!\n<\/prompt>/)
    const t = await client.getPrompt({ name: 'triage-failures', arguments: { agentId, hours: '1' } })
    assert.match(t.messages[0].content.text, /1 failed Conduit run/)
  })

  await step('read-scoped token cannot see or call write tools', async () => {
    const reader = await httpClient(readToken.plaintext)
    const names = (await reader.listTools()).tools.map((t) => t.name)
    assert.ok(names.includes('get_run_log') && !names.includes('create_agent') && !names.includes('start_run'))
    const res = await reader.callTool({ name: 'delete_agent', arguments: { agentId, confirmName: 'MCP e2e agent' } })
    assert.equal(res.isError, true)
    assert.ok((await browser.invoke('agents:get', agentId)), 'agent must still exist')
    await reader.close()
  })

  await step('revoked tokens stop working immediately', async () => {
    await browser.invoke('mcpTokens:revoke', readToken.token.id)
    assert.equal((await rawPost({ Authorization: `Bearer ${readToken.plaintext}` })).status, 401)
  })

  await step('stdio bridge relays to the HTTP endpoint', async () => {
    const bridged = new Client({ name: 'conduit-e2e-stdio', version: '1' })
    await bridged.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [path.join(repoRoot, 'out/mcpBridge/index.js')],
        env: { PATH: process.env.PATH ?? '', CONDUIT_MCP_URL: MCP_URL, CONDUIT_MCP_TOKEN: writeToken },
        stderr: 'ignore',
      })
    )
    const { agents } = await callJson(bridged, 'list_agents', { query: 'mcp e2e' })
    assert.deepEqual(agents.map((a) => a.id), [agentId])
    await bridged.close()
  })

  await step('delete the agent (owner, name-confirmed)', async () => {
    assert.deepEqual(await callJson(client, 'delete_agent', { agentId, confirmName: 'MCP e2e agent' }), {
      deleted: true,
      agentId,
    })
    assert.equal((await callJson(client, 'list_agents', { query: 'mcp e2e' })).count, 0)
  })

  await client.close()
  browser.ws.close()
}

async function main() {
  requireBuild('out/server/index.js', 'out/mcpBridge/index.js')
  await ensureDatabase(DB_NAME)
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'conduit-e2e-mcp-'))
  const server = startProcess('server', 'node', [path.join(repoRoot, 'out/server/index.js')], {
    env: {
      PATH: `${stubBinDir}${path.delimiter}${process.env.PATH}`,
      PORT: String(PORT),
      CONDUIT_DATA_DIR: dataDir,
      CONDUIT_MCP_REQUIRE_TOKEN: 'true',
      DATABASE_URL: `${PG_BASE}/${DB_NAME}`,
      DATABASE_SSL: 'disable',
    },
  })
  let exitCode = 1
  try {
    await waitForOutput(server, 'running at')
    console.log(`[e2e:mcp] Server up on port ${PORT}`)
    await drive()
    console.log(`[e2e:mcp] All ${passed} steps passed`)
    exitCode = 0
  } catch (err) {
    console.log('FAILED')
    console.error(err)
    console.error('--- server output ---\n' + server.getOutput().slice(-4000))
  } finally {
    await stopProcess(server)
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
  process.exit(exitCode)
}

main()
