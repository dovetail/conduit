/**
 * Graceful server shutdown must hand a started Fargate run to the replacement
 * server rather than fail it. Two modes, both launched by e2e/fargate/run.mjs:
 *
 * - prep (default): start a long-running run and leave it live so the
 *   orchestrator can SIGTERM the server.
 * - adopt (SHUTDOWN_ADOPT_RUN_ID set): against the replacement server, assert
 *   the run is still `running` and its events keep streaming.
 *
 * Env: CONDUIT_URL, SHUTDOWN_ADOPT_RUN_ID, SHUTDOWN_ADOPT_AGENT_ID.
 */
import WebSocket from 'ws'

const BASE = process.env.CONDUIT_URL
const ADOPT_RUN_ID = process.env.SHUTDOWN_ADOPT_RUN_ID
const ADOPT_AGENT_ID = process.env.SHUTDOWN_ADOPT_AGENT_ID
const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
}

const ws = new WebSocket(BASE)
await new Promise((res, rej) => (ws.on('open', res), ws.on('error', rej)))

let nextId = 1
const pending = new Map()
const eventListeners = []

ws.on('message', (data) => {
  const msg = JSON.parse(data.toString())
  if (msg.type === 'response' || msg.type === 'error') {
    const p = pending.get(msg.id)
    if (p) {
      pending.delete(msg.id)
      if (msg.type === 'error') p.reject(new Error(msg.error))
      else p.resolve(msg.result)
    }
  } else if (msg.type === 'event' && msg.channel === 'run:events') {
    for (const fn of eventListeners) fn(msg.payload)
  }
})

const invoke = (channel, ...args) =>
  new Promise((resolve, reject) => {
    const id = nextId++
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ type: 'invoke', id, channel, args }))
    setTimeout(() => pending.has(id) && (pending.delete(id), reject(new Error(`${channel} timed out`))), 30000)
  })

const waitForEvents = (runId, timeoutMs = 30000) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no events streamed within ${timeoutMs}ms`)), timeoutMs)
    eventListeners.push((payload) => {
      if (payload.runId === runId && payload.events?.length > 0) {
        clearTimeout(timer)
        resolve()
      }
    })
  })

try {
  if (ADOPT_RUN_ID) {
    await waitForEvents(ADOPT_RUN_ID)
    check('shutdown-adopt: events resume on the replacement server', true, `runId=${ADOPT_RUN_ID}`)
    const [row] = (await invoke('runs:list', ADOPT_AGENT_ID)).filter((r) => r.id === ADOPT_RUN_ID)
    check('shutdown-adopt: run still running', row?.status === 'running', `status=${row?.status}`)
  } else {
    const agent = await invoke('agents:create', {
      name: 'e2e-fargate-shutdown',
      runner: 'claude',
      prompt: 'E2E_LONG keep going until the server shuts down',
      envVars: {},
      mcpConfig: { mcpServers: {} },
    })
    const run = await invoke('runs:start', agent.id)
    check('shutdown-prep: long run started', run?.status === 'running' && run?.workerKind === 'fargate', `id=${run?.id}`)
    await waitForEvents(run.id)
    check('shutdown-prep: execution is live', true, `runId=${run.id}`)
    console.log(`[fargate] SHUTDOWN_PREP_READY runId=${run.id} agentId=${agent.id}`)
  }

  const failed = results.filter((r) => !r.ok)
  console.log(failed.length === 0 ? `\nALL ${results.length} CHECKS PASSED` : `\n${failed.length} CHECK(S) FAILED`)
  process.exitCode = failed.length === 0 ? 0 : 1
} catch (err) {
  console.error('E2E fargate shutdown driver error:', err)
  process.exitCode = 1
} finally {
  ws.close()
}
