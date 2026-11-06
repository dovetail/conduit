/**
 * Orchestrates the simulated-Fargate e2e test (`npm run e2e:fargate`):
 *
 *   server (CONDUIT_WORKER_FACTORY=fargate + fake ECS)  <──WSS Bearer──  spawned workers
 *
 * The fake ECS (e2e/fargate/fakeEcs.cjs) is injected via CONDUIT_FARGATE_E2E_FAKE_ECS
 * and launches real `node out/worker/index.js` processes. No AWS account is used.
 *
 * Phases:
 *   1. drive.mjs — completion, failure, cancel, connect timeout, crash,
 *      parallel agents, same-agent rejection, cleanup/secret/ARN asserts
 *   2. drive-restart.mjs — gated reconnect markers, abrupt SIGKILL of the
 *      server, replacement process with the same DB/data/token/state
 *   3. drive-shutdown.mjs — leave a long run live, SIGTERM the server, assert
 *      its simulated task keeps running and a replacement adopts the run
 *   4. drive-reconnect-expiry.mjs — keep the endpoint down past an injected
 *      short reconnect window; worker exits nonzero; replacement records the
 *      reconnect-timeout diagnostic
 *
 * Env overrides: CONDUIT_E2E_PORT (default 7562), CONDUIT_E2E_DB (default
 * conduit_e2e_fargate), CONDUIT_E2E_PG. Postgres must be reachable — see
 * `npm run db:up`.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import {
  repoRoot,
  stubBinDir,
  PG_BASE,
  ensureDatabase,
  requireBuild,
  startProcess,
  waitForOutput,
  stopProcess,
  runDriver,
} from '../lib/harness.mjs'

const { killRecordedTasks } = createRequire(import.meta.url)('./fakeEcs.cjs')

const PORT = Number(process.env.CONDUIT_E2E_PORT) || 7562
const DB_NAME = process.env.CONDUIT_E2E_DB || 'conduit_e2e_fargate'
const TOKEN = 'e2e-worker-token'
const SERVER_URL = `ws://localhost:${PORT}/ws/worker`
const RESTART_TIMEOUT_MS = 4000
const SHUTDOWN_TIMEOUT_MS = 60_000
const EXPIRY_TIMEOUT_MS = 1200

function readState(stateFile) {
  if (!fs.existsSync(stateFile)) return { runTasks: [], tasks: {} }
  return JSON.parse(fs.readFileSync(stateFile, 'utf8'))
}

function runningCount(state) {
  return Object.values(state.tasks ?? {}).filter((t) => t.lastStatus === 'RUNNING').length
}

async function killAbrupt(proc) {
  if (!proc || proc.child.exitCode !== null || proc.child.signalCode !== null) return
  proc.child.kill('SIGKILL')
  await new Promise((resolve) => proc.child.once('exit', resolve))
}

function startLoggedProcess(name, command, args, opts) {
  const proc = startProcess(name, command, args, opts)
  proc.child.stdout.on('data', (c) => process.stdout.write(c))
  proc.child.stderr.on('data', (c) => process.stderr.write(c))
  return proc
}

function waitForExit(proc, timeoutMs = 120_000) {
  return new Promise((resolve, reject) => {
    if (proc.child.exitCode !== null || proc.child.signalCode !== null) {
      return resolve(proc.child.exitCode ?? 1)
    }
    const timer = setTimeout(() => {
      reject(new Error(`${proc.name} did not exit within ${timeoutMs}ms\n${proc.getOutput()}`))
    }, timeoutMs)
    proc.child.once('exit', (code) => {
      clearTimeout(timer)
      resolve(code ?? 1)
    })
  })
}

async function main() {
  requireBuild('out/server/index.js', 'out/worker/index.js')
  await ensureDatabase(DB_NAME)

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'conduit-e2e-fargate-'))
  const stateFile = path.join(dataDir, 'fake-ecs.json')
  const skipSpawn = path.join(dataDir, 'skip-spawn')
  const fakeEcs = path.join(repoRoot, 'e2e/fargate/fakeEcs.cjs')
  const workerBin = path.join(repoRoot, 'out/worker/index.js')

  const serverEnv = (reconnectTimeoutMs) => ({
    PATH: `${stubBinDir}${path.delimiter}${process.env.PATH}`,
    PORT: String(PORT),
    CONDUIT_DATA_DIR: dataDir,
    DATABASE_URL: `${PG_BASE}/${DB_NAME}`,
    DATABASE_SSL: 'disable',
    CONDUIT_WORKER_FACTORY: 'fargate',
    CONDUIT_WORKER_TOKEN: TOKEN,
    CONDUIT_SERVER_URL: SERVER_URL,
    CONDUIT_FARGATE_CLUSTER: 'conduit-e2e',
    CONDUIT_FARGATE_TASK_DEFINITION: 'conduit-worker:e2e',
    CONDUIT_FARGATE_SUBNETS: 'subnet-e2e0001,subnet-e2e0002',
    CONDUIT_E2E: '1',
    CONDUIT_FARGATE_E2E_FAKE_ECS: fakeEcs,
    CONDUIT_FARGATE_E2E_STATE: stateFile,
    CONDUIT_FARGATE_E2E_SKIP_SPAWN: skipSpawn,
    CONDUIT_FARGATE_E2E_WORKER_BIN: workerBin,
    CONDUIT_WORKER_CONNECT_TIMEOUT_MS: '4000',
    CONDUIT_WORKER_RECONNECT_TIMEOUT_MS: String(reconnectTimeoutMs),
  })

  const startServer = (reconnectTimeoutMs) =>
    startProcess('server', 'node', [path.join(repoRoot, 'out/server/index.js')], {
      env: serverEnv(reconnectTimeoutMs),
    })

  const driverEnv = {
    CONDUIT_URL: `ws://localhost:${PORT}/ws`,
    CONDUIT_DATA_DIR: dataDir,
    CONDUIT_FARGATE_E2E_STATE: stateFile,
    CONDUIT_FARGATE_E2E_SKIP_SPAWN: skipSpawn,
    CONDUIT_E2E_TOKEN: TOKEN,
    EXPECT_WORKER_KIND: 'fargate',
  }

  let server
  let restartDriver
  let expiryDriver
  let exitCode
  try {
    server = startServer(RESTART_TIMEOUT_MS)
    await waitForOutput(server, 'running at')
    console.log(`[e2e] Server up on port ${PORT} (fargate factory + fake ECS, data dir ${dataDir})`)

    console.log('[e2e] Running fargate driver suite')
    exitCode = await runDriver(path.join(repoRoot, 'e2e/fargate/drive.mjs'), driverEnv)
    if (exitCode !== 0) throw new Error('fargate driver suite failed')

    console.log('[e2e] Running server-replacement restart scenario')
    restartDriver = startLoggedProcess('restart-driver', 'node', [path.join(repoRoot, 'e2e/fargate/drive-restart.mjs')], {
      env: driverEnv,
    })
    await waitForOutput(restartDriver, 'RESTART_KILL_SERVER')
    console.log('[e2e] SIGKILL first server (no graceful factory shutdown)')
    await killAbrupt(server)
    server = startServer(RESTART_TIMEOUT_MS)
    await waitForOutput(server, 'running at')
    console.log('[e2e] Replacement server up — waiting for restart assertions')
    exitCode = await waitForExit(restartDriver, 120_000)
    if (exitCode !== 0) {
      console.error(restartDriver.getOutput())
      throw new Error(`restart scenario failed (driver exit ${exitCode})`)
    }
    restartDriver = undefined

    console.log('[e2e] Running server-shutdown handover scenario')
    // A window long enough to outlast a graceful exit plus the replacement's boot.
    await stopProcess(server)
    server = startServer(SHUTDOWN_TIMEOUT_MS)
    await waitForOutput(server, 'running at')
    const prep = startLoggedProcess('shutdown-prep', 'node', [path.join(repoRoot, 'e2e/fargate/drive-shutdown.mjs')], {
      env: driverEnv,
    })
    exitCode = await waitForExit(prep, 60_000)
    if (exitCode !== 0) throw new Error('shutdown-prep failed')
    const [, adoptRunId, adoptAgentId] = /SHUTDOWN_PREP_READY runId=(\S+) agentId=(\S+)/.exec(prep.getOutput()) ?? []
    if (!adoptRunId) throw new Error('shutdown-prep did not report its run id')

    const liveBefore = runningCount(readState(stateFile))
    if (liveBefore < 1) {
      throw new Error(`expected a live simulated task before server shutdown, found ${liveBefore}`)
    }
    console.log(`[e2e] ${liveBefore} simulated task(s) running — SIGTERM server`)
    await stopProcess(server)
    server = undefined

    const after = readState(stateFile)
    const liveAfter = runningCount(after)
    if (liveAfter !== liveBefore) {
      console.error(`[e2e] FAIL  shutdown: ${liveBefore - liveAfter} started task(s) were stopped`)
      console.error(JSON.stringify(after, null, 2))
      throw new Error('shutdown: started tasks did not survive a graceful server shutdown')
    }
    console.log('[e2e] PASS  shutdown: started task kept running through SIGTERM')

    server = startServer(SHUTDOWN_TIMEOUT_MS)
    await waitForOutput(server, 'running at')
    exitCode = await runDriver(path.join(repoRoot, 'e2e/fargate/drive-shutdown.mjs'), {
      ...driverEnv,
      SHUTDOWN_ADOPT_RUN_ID: adoptRunId,
      SHUTDOWN_ADOPT_AGENT_ID: adoptAgentId,
    })
    if (exitCode !== 0) throw new Error('shutdown: replacement server did not adopt the run')
    // Clear the survivor so it cannot dial into the expiry scenario's server.
    await killAbrupt(server)
    server = undefined
    killRecordedTasks(stateFile)

    console.log('[e2e] Running reconnect-expiry scenario')
    server = startServer(EXPIRY_TIMEOUT_MS)
    await waitForOutput(server, 'running at')
    expiryDriver = startLoggedProcess(
      'expiry-driver',
      'node',
      [path.join(repoRoot, 'e2e/fargate/drive-reconnect-expiry.mjs')],
      {
        env: {
          ...driverEnv,
          CONDUIT_WORKER_RECONNECT_TIMEOUT_MS: String(EXPIRY_TIMEOUT_MS),
        },
      }
    )
    await waitForOutput(expiryDriver, 'EXPIRY_KILL_SERVER')
    console.log('[e2e] SIGKILL expiry server (endpoint stays down past timeout)')
    await killAbrupt(server)
    server = undefined
    await waitForOutput(expiryDriver, 'EXPIRY_START_REPLACEMENT', 30_000)
    server = startServer(EXPIRY_TIMEOUT_MS)
    await waitForOutput(server, 'running at')
    console.log('[e2e] Expiry replacement server up — waiting for diagnostic assertions')
    exitCode = await waitForExit(expiryDriver, 90_000)
    expiryDriver = undefined
    if (exitCode !== 0) throw new Error(`expiry scenario failed (driver exit ${exitCode})`)
    console.log('[e2e] PASS  expiry: worker died nonzero and run failed with diagnostic')
  } finally {
    if (restartDriver) await killAbrupt(restartDriver)
    if (expiryDriver) await killAbrupt(expiryDriver)
    if (server) await killAbrupt(server)
    killRecordedTasks(stateFile)
    fs.rmSync(dataDir, { recursive: true, force: true })
    console.log('[e2e] Cleanup: killed leftover process groups and removed data dir')
  }
  process.exit(exitCode ?? 1)
}

main().catch((err) => {
  console.error('[e2e]', err.message ?? err)
  process.exit(1)
})
