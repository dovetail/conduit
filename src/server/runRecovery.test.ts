/**
 * Startup orphan partition + recovered runner sink. Real temp logs; DB,
 * publisher, and broadcast are the mocked boundaries.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import type { ExecutionRun } from '../shared/types'
import { appendSequencedEvents, readHighestContiguousSequence } from './runDeliveryLog'

const LOCAL_RESTART_MESSAGE =
  '✗ Run did not finish — the Conduit process exited mid-run (deploy, crash, ' +
  'out-of-memory, or disk-pressure eviction). Marked failed on restart.'

const RECONNECT_MS = 1250
const EXPIRY_MESSAGE =
  'Run did not finish — remote worker did not reconnect within 1250ms after the Conduit server restarted.'

const REMOTE_NO_WORKER_MESSAGE =
  '✗ Run did not finish — this remote run had no recorded worker identity when the Conduit server restarted. Marked failed on restart.'

const runs = new Map<string, ExecutionRun>()
const getRun = vi.fn(async (id: string) => runs.get(id) ?? null)
const updateRun = vi.fn(async (id: string, data: Partial<ExecutionRun>) => {
  const cur = runs.get(id)
  if (!cur) throw new Error(`Run ${id} not found`)
  const next = { ...cur, ...data }
  runs.set(id, next)
  return next
})
const getOrphanedRuns = vi.fn(async () => [...runs.values()].filter((r) => r.status === 'running'))
const updateRunIfRunning = vi.fn(async (id: string, data: Partial<ExecutionRun>) => {
  const cur = runs.get(id)
  if (!cur || cur.status !== 'running') return null
  return updateRun(id, data)
})
const getAgent = vi.fn(async (id: string) =>
  id
    ? {
        id,
        name: 'Test agent',
        runner: 'claude' as const,
        prompt: 'hi',
        envVars: {},
        mcpConfig: { mcpServers: {} },
        createdAt: 1,
        updatedAt: 1,
      }
    : null
)
const publishRunResult = vi.fn(async () => {})
const captureMessage = vi.fn()
const captureException = vi.fn()
const getRepository = vi.fn(async (_id: string) => null)
const resolvePushCredential = vi.fn()

vi.mock('../main/db/queries/runs', () => ({
  getRun: (id: string) => getRun(id),
  updateRun: (id: string, data: Partial<ExecutionRun>) => updateRun(id, data),
  updateRunIfRunning: (id: string, data: Partial<ExecutionRun>) => updateRunIfRunning(id, data),
  getOrphanedRuns: () => getOrphanedRuns(),
  createRun: vi.fn(),
  getRunningRunForAgent: vi.fn(),
  listRuns: vi.fn(),
}))

vi.mock('../main/db/queries/agents', () => ({
  getAgent: (id: string) => getAgent(id),
}))

vi.mock('../main/db/queries/repositories', () => ({
  getRepository: (id: string) => getRepository(id),
}))

vi.mock('./githubApp', () => ({
  resolvePushCredential: (...args: unknown[]) => resolvePushCredential(...args),
  githubTokenEnvEntry: vi.fn(() => ({})),
}))

vi.mock('./publisher', () => ({
  publishRunResult: (...args: unknown[]) => publishRunResult(...args),
}))

vi.mock('./observability', () => ({
  reporter: {
    captureMessage: (...args: unknown[]) => captureMessage(...args),
    captureException: (...args: unknown[]) => captureException(...args),
    capture: vi.fn(),
    setUser: vi.fn(),
    addBreadcrumb: vi.fn(),
    flush: vi.fn(async () => {}),
  },
}))

import { recoverRemoteRun, reconcileOrphanedRuns, stopOrphanReconciliation } from './runRecovery'
import { getActiveRunIds, REPO_TOKEN_REFRESH_MS, stopRun } from './runner'

const RECOVERABLE = ['remote', 'eks', 'fargate'] as const

function tmpDir(): { dir: string; close: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conduit-run-recovery-'))
  return { dir, close: () => fs.rmSync(dir, { recursive: true, force: true }) }
}

function fixture(over: Partial<ExecutionRun> & Pick<ExecutionRun, 'id' | 'logPath'>): ExecutionRun {
  return {
    agentId: 'agent-1',
    status: 'running',
    startedAt: 1_000_000,
    workspacePath: '/tmp/ws',
    lastLine: 'seeded activity',
    workerKind: 'remote',
    workerId: 'worker-1',
    ...over,
  }
}

function failedUpdatesFor(runId: string): unknown[] {
  return updateRun.mock.calls.filter(([id, data]) => id === runId && data.status === 'failed')
}

describe('reconcileOrphanedRuns', () => {
  const temps: Array<{ close: () => void }> = []
  const broadcasts: Array<[string, unknown]> = []
  let stop: (() => void) | undefined

  beforeEach(() => {
    runs.clear()
    updateRun.mockClear()
    getRun.mockClear()
    getOrphanedRuns.mockClear()
    updateRunIfRunning.mockClear()
    publishRunResult.mockClear()
    captureMessage.mockClear()
    getAgent.mockClear()
    broadcasts.length = 0
    vi.useFakeTimers()
    vi.setSystemTime(2_000_000)
  })

  afterEach(async () => {
    stop?.()
    stop = undefined
    vi.useRealTimers()
    for (const runId of [...getActiveRunIds()]) {
      await stopRun(runId)
    }
    while (temps.length > 0) temps.pop()!.close()
  })

  function addRun(over: Partial<ExecutionRun> = {}): ExecutionRun {
    const tmp = tmpDir()
    temps.push(tmp)
    const id = over.id ?? `run-${runs.size + 1}`
    const run = fixture({
      id,
      logPath: path.join(tmp.dir, `${id}.jsonl`),
      ...over,
    })
    fs.writeFileSync(run.logPath, '')
    runs.set(run.id, run)
    return run
  }

  async function reconcile() {
    const handle = await reconcileOrphanedRuns({
      reconnectTimeoutMs: RECONNECT_MS,
      recoverableKinds: RECOVERABLE,
      broadcast: (channel, payload) => broadcasts.push([channel, payload]),
    })
    stop = () => handle.stop()
    return handle
  }

  it('fails a local orphan immediately with the existing restart message', async () => {
    const local = addRun({ id: 'local-1', workerKind: 'local', workerId: undefined })
    await reconcile()

    expect(runs.get(local.id)?.status).toBe('failed')
    expect(fs.readFileSync(local.logPath, 'utf8')).toContain(LOCAL_RESTART_MESSAGE)
    expect(failedUpdatesFor(local.id)).toHaveLength(1)
  })

  it('fails a missing workerKind orphan immediately', async () => {
    const missing = addRun({ id: 'missing-kind', workerKind: undefined, workerId: undefined })
    await reconcile()

    expect(runs.get(missing.id)?.status).toBe('failed')
    expect(fs.readFileSync(missing.logPath, 'utf8')).toContain(LOCAL_RESTART_MESSAGE)
  })

  it('keeps remote, eks, and fargate runs with a nonempty workerId running during the adoption window', async () => {
    const remote = addRun({ id: 'remote-1', workerKind: 'remote', workerId: 'w-remote' })
    const eks = addRun({ id: 'eks-1', workerKind: 'eks', workerId: 'w-eks' })
    const fargate = addRun({ id: 'fargate-1', workerKind: 'fargate', workerId: 'w-fargate' })
    await reconcile()

    await vi.advanceTimersByTimeAsync(RECONNECT_MS - 1)

    for (const run of [remote, eks, fargate]) {
      expect(runs.get(run.id)?.status).toBe('running')
      expect(failedUpdatesFor(run.id)).toHaveLength(0)
    }
  })

  it('fails a remote orphan with an empty workerId immediately using a remote-identity diagnostic', async () => {
    const orphan = addRun({ id: 'remote-no-worker', workerKind: 'remote', workerId: '' })
    await reconcile()

    expect(runs.get(orphan.id)?.status).toBe('failed')
    expect(fs.readFileSync(orphan.logPath, 'utf8')).toContain(REMOTE_NO_WORKER_MESSAGE)
    expect(fs.readFileSync(orphan.logPath, 'utf8')).not.toContain(LOCAL_RESTART_MESSAGE)
  })

  it('stopOrphanReconciliation prevents expiry of still-running remote orphans', async () => {
    const run = addRun({ id: 'stop-expiry', workerKind: 'remote', workerId: 'worker-1' })
    await reconcile()
    stopOrphanReconciliation()

    await vi.advanceTimersByTimeAsync(RECONNECT_MS + 5_000)

    expect(runs.get(run.id)?.status).toBe('running')
    expect(failedUpdatesFor(run.id)).toHaveLength(0)
    expect(fs.readFileSync(run.logPath, 'utf8')).not.toContain(EXPIRY_MESSAGE)
  })

  it('does not fail or write a diagnostic when adoption and expiry overlap', async () => {
    const run = addRun({ id: 'race-1', workerKind: 'remote', workerId: 'worker-1' })
    await reconcile()

    let releaseAgent!: () => void
    const agentHeld = new Promise<void>((resolve) => {
      releaseAgent = resolve
    })
    getAgent.mockImplementationOnce(async () => {
      await agentHeld
      return {
        id: run.agentId,
        name: 'Test agent',
        runner: 'claude' as const,
        prompt: 'hi',
        envVars: {},
        mcpConfig: { mcpServers: {} },
        createdAt: 1,
        updatedAt: 1,
      }
    })

    const recoverP = recoverRemoteRun(run.id, 'worker-1', (channel, payload) =>
      broadcasts.push([channel, payload])
    )
    await vi.waitFor(() => {
      expect(getAgent).toHaveBeenCalled()
    })

    await vi.advanceTimersByTimeAsync(RECONNECT_MS)
    expect(runs.get(run.id)?.status).toBe('running')
    expect(fs.readFileSync(run.logPath, 'utf8')).not.toContain(EXPIRY_MESSAGE)

    releaseAgent()
    const binding = await recoverP
    expect(binding && 'sink' in binding).toBe(true)
    if (binding && 'onAdopted' in binding) binding.onAdopted?.()

    await vi.advanceTimersByTimeAsync(RECONNECT_MS)
    expect(runs.get(run.id)?.status).toBe('running')
    expect(failedUpdatesFor(run.id)).toHaveLength(0)
    expect(fs.readFileSync(run.logPath, 'utf8')).not.toContain(EXPIRY_MESSAGE)
  })

  it('fails exactly once when expiry elapses during adoption and recovery then abandons', async () => {
    const run = addRun({ id: 'abandon-after-expiry', workerKind: 'remote', workerId: 'worker-1' })
    await reconcile()

    let releaseAgent!: () => void
    const agentHeld = new Promise<void>((resolve) => {
      releaseAgent = resolve
    })
    getAgent.mockImplementationOnce(async () => {
      await agentHeld
      return {
        id: run.agentId,
        name: 'Test agent',
        runner: 'claude' as const,
        prompt: 'hi',
        envVars: {},
        mcpConfig: { mcpServers: {} },
        createdAt: 1,
        updatedAt: 1,
      }
    })

    const recoverP = recoverRemoteRun(run.id, 'worker-1', (channel, payload) =>
      broadcasts.push([channel, payload])
    )
    await vi.waitFor(() => {
      expect(getAgent).toHaveBeenCalled()
    })

    await vi.advanceTimersByTimeAsync(RECONNECT_MS)
    expect(runs.get(run.id)?.status).toBe('running')
    expect(fs.readFileSync(run.logPath, 'utf8')).not.toContain(EXPIRY_MESSAGE)
    expect(getActiveRunIds().has(run.id)).toBe(false)

    releaseAgent()
    const binding = await recoverP
    expect(binding && 'sink' in binding).toBe(true)
    expect(getActiveRunIds().has(run.id)).toBe(false)
    if (binding && 'onAbandoned' in binding) binding.onAbandoned?.()

    await vi.waitFor(() => {
      expect(runs.get(run.id)?.status).toBe('failed')
    })
    expect(fs.readFileSync(run.logPath, 'utf8')).toContain(EXPIRY_MESSAGE)
    expect(failedUpdatesFor(run.id)).toHaveLength(1)
    expect(getActiveRunIds().has(run.id)).toBe(false)

    await vi.advanceTimersByTimeAsync(RECONNECT_MS * 4)
    expect(failedUpdatesFor(run.id)).toHaveLength(1)
  })

  it('keeps expiry armed and skips active-process registration until the plane installs the binding', async () => {
    const run = addRun({ id: 'no-install', workerKind: 'remote', workerId: 'worker-1' })
    await reconcile()
    const broadcast = (channel: string, payload: unknown) => broadcasts.push([channel, payload])

    const binding = await recoverRemoteRun(run.id, 'worker-1', broadcast)
    expect(binding && 'sink' in binding).toBe(true)
    expect(getActiveRunIds().has(run.id)).toBe(false)

    await vi.advanceTimersByTimeAsync(RECONNECT_MS)
    if (binding && 'onAbandoned' in binding) binding.onAbandoned?.()
    await vi.waitFor(() => {
      expect(runs.get(run.id)?.status).toBe('failed')
    })
    expect(fs.readFileSync(run.logPath, 'utf8')).toContain(EXPIRY_MESSAGE)
    expect(getActiveRunIds().has(run.id)).toBe(false)
  })

  it('removes an adopted run from expiry handling after onAdopted', async () => {
    const run = addRun({ id: 'adopt-1', workerKind: 'remote', workerId: 'worker-1' })
    await reconcile()
    const broadcast = (channel: string, payload: unknown) => broadcasts.push([channel, payload])

    const binding = await recoverRemoteRun(run.id, 'worker-1', broadcast)
    expect(binding && 'onAdopted' in binding).toBe(true)
    if (binding && 'onAdopted' in binding) binding.onAdopted?.()

    await vi.advanceTimersByTimeAsync(RECONNECT_MS + 5_000)

    expect(runs.get(run.id)?.status).toBe('running')
    expect(failedUpdatesFor(run.id)).toHaveLength(0)
    expect(fs.readFileSync(run.logPath, 'utf8')).not.toContain(EXPIRY_MESSAGE)
  })

  it('fails an unadopted run exactly once after the injected timeout with the reconnect diagnostic', async () => {
    const run = addRun({ id: 'expire-1', workerKind: 'remote', workerId: 'worker-1' })
    await reconcile()

    await vi.advanceTimersByTimeAsync(RECONNECT_MS)
    expect(runs.get(run.id)?.status).toBe('failed')
    expect(fs.readFileSync(run.logPath, 'utf8')).toContain(EXPIRY_MESSAGE)
    expect(failedUpdatesFor(run.id)).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(RECONNECT_MS * 4)
    expect(failedUpdatesFor(run.id)).toHaveLength(1)
  })
})

describe('recoverRemoteRun', () => {
  const temps: Array<{ close: () => void }> = []
  const broadcasts: Array<[string, unknown]> = []

  beforeEach(() => {
    runs.clear()
    updateRun.mockClear()
    getRun.mockClear()
    updateRunIfRunning.mockClear()
    publishRunResult.mockClear()
    captureMessage.mockClear()
    captureException.mockClear()
    broadcasts.length = 0
  })

  afterEach(async () => {
    for (const runId of [...getActiveRunIds()]) {
      await stopRun(runId)
    }
    while (temps.length > 0) temps.pop()!.close()
  })

  function broadcast(channel: string, payload: unknown) {
    broadcasts.push([channel, payload])
  }

  async function seedRemote(over: Partial<ExecutionRun> = {}): Promise<ExecutionRun> {
    const tmp = tmpDir()
    temps.push(tmp)
    const id = over.id ?? `run-recover-${temps.length}`
    const logPath = over.logPath ?? path.join(tmp.dir, `${id}.jsonl`)
    const run = fixture({ id, logPath, workerKind: 'remote', workerId: 'worker-1', ...over })
    await appendSequencedEvents(logPath, [{ kind: 'raw', stream: 'stdout', text: 'pre-outage' }], 1)
    await appendSequencedEvents(logPath, [{ kind: 'raw', stream: 'stdout', text: 'still-going' }], 2)
    runs.set(run.id, run)
    return run
  }

  it('returns a binding for a matching running remote runId/workerId derived from the persistent log cursor', async () => {
    const run = await seedRemote()
    const binding = await recoverRemoteRun(run.id, 'worker-1', broadcast)

    expect(binding).toMatchObject({ runId: run.id, workerId: 'worker-1' })
    expect(binding!.durableSequence).toBe(2)
    expect(binding!.durableSequence).toBe(await readHighestContiguousSequence(run.logPath))
    expect(binding && 'handle' in binding && binding.handle.workerId).toBe('worker-1')
    if (binding && 'onAbandoned' in binding) binding.onAbandoned?.()
  })

  it('updates lastLine from durable events without writing a second log copy', async () => {
    const run = await seedRemote()
    const before = fs.readFileSync(run.logPath, 'utf8')
    const binding = (await recoverRemoteRun(run.id, 'worker-1', broadcast))!
    expect('sink' in binding).toBe(true)
    if (!('sink' in binding)) return
    binding.onAdopted?.()

    binding.sink.onDurableEvent!({ kind: 'raw', stream: 'stdout', text: 'post-recover line' })
    expect(fs.readFileSync(run.logPath, 'utf8')).toBe(before)

    await binding.sink.onExit('completed', 0)
    expect(runs.get(run.id)?.lastLine).toBe('post-recover line')
    expect(broadcasts.some(([ch]) => ch === 'run:events')).toBe(true)
  })

  it('forwards a durable event to the platform log exactly once without a second jsonl write', async () => {
    const run = await seedRemote()
    const before = fs.readFileSync(run.logPath, 'utf8')
    const binding = (await recoverRemoteRun(run.id, 'worker-1', broadcast))!
    if (!('sink' in binding)) throw new Error('expected a live binding')
    binding.onAdopted?.()

    const written: string[] = []
    const stdout = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: string | Uint8Array) => {
        written.push(String(chunk))
        return true
      })
    try {
      binding.sink.onDurableEvent!({ kind: 'raw', stream: 'stdout', text: 'forward-me' })
    } finally {
      stdout.mockRestore()
    }

    const forwarded = written.filter((line) => line.includes('forward-me'))
    expect(forwarded).toHaveLength(1)
    expect(JSON.parse(forwarded[0]!)).toMatchObject({ runId: run.id, text: 'forward-me' })
    expect(fs.readFileSync(run.logPath, 'utf8')).toBe(before)

    await binding.sink.onExit('completed', 0)
  })

  it('rejects the terminal callback when the status write fails and finalizes once on replay', async () => {
    const run = await seedRemote()
    const binding = (await recoverRemoteRun(run.id, 'worker-1', broadcast))!
    if (!('sink' in binding)) throw new Error('expected a live binding')
    binding.onAdopted?.()

    updateRunIfRunning.mockImplementationOnce(async () => {
      throw new Error('database is unavailable')
    })

    await expect(binding.sink.onExit('completed', 0)).rejects.toThrow(/database is unavailable/)
    expect(runs.get(run.id)?.status).toBe('running')
    expect(publishRunResult).not.toHaveBeenCalled()
    expect(broadcasts.filter(([ch]) => ch === 'run:statusChange')).toHaveLength(0)
    // Still retryable: the run was not removed from the active set.
    expect(getActiveRunIds().has(run.id)).toBe(true)

    await binding.sink.onExit('completed', 0)
    await binding.sink.onExit('completed', 0)

    expect(runs.get(run.id)?.status).toBe('completed')
    expect(publishRunResult).toHaveBeenCalledTimes(1)
    expect(
      broadcasts.filter(
        ([ch, p]) => ch === 'run:statusChange' && (p as { status: string }).status === 'completed'
      )
    ).toHaveLength(1)
    expect(getActiveRunIds().has(run.id)).toBe(false)
  })

  it('acknowledges the terminal state when publishing fails after the status is durable', async () => {
    const run = await seedRemote()
    const binding = (await recoverRemoteRun(run.id, 'worker-1', broadcast))!
    if (!('sink' in binding)) throw new Error('expected a live binding')
    binding.onAdopted?.()

    publishRunResult.mockImplementationOnce(async () => {
      throw new Error('publish target unreachable')
    })

    await expect(binding.sink.onExit('completed', 0)).resolves.toBeUndefined()
    expect(runs.get(run.id)?.status).toBe('completed')
    expect(captureException).toHaveBeenCalled()
  })

  it('starts refreshing the repo token of a GitHub App run once the plane adopts it', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    try {
      const run = await seedRemote({ agentId: 'agent-github' })
      getAgent.mockResolvedValueOnce({
        id: run.agentId,
        name: 'GitHub agent',
        runner: 'claude',
        prompt: 'hi',
        envVars: {},
        mcpConfig: { mcpServers: {} },
        createdAt: 1,
        updatedAt: 1,
        repositoryId: 'repo-github',
      })
      getRepository.mockResolvedValueOnce({
        id: 'repo-github',
        url: 'https://github.com/acme/widgets.git',
        authMethod: 'githubapp',
      })
      resolvePushCredential.mockResolvedValue({ token: 'ghs_fresh' })

      const binding = (await recoverRemoteRun(run.id, 'worker-1', broadcast))!
      expect(resolvePushCredential).not.toHaveBeenCalled()
      if (!('onAdopted' in binding)) throw new Error('expected a live binding')
      binding.onAdopted?.()

      await vi.advanceTimersByTimeAsync(REPO_TOKEN_REFRESH_MS)
      expect(resolvePushCredential).toHaveBeenCalledTimes(1)
      expect(resolvePushCredential).toHaveBeenCalledWith(expect.objectContaining({ id: 'repo-github' }))
    } finally {
      vi.useRealTimers()
    }
  })

  it('routes stop through the recovered handle so cancel can use the rebound socket', async () => {
    const run = await seedRemote()
    const binding = (await recoverRemoteRun(run.id, 'worker-1', broadcast))!
    expect('sink' in binding).toBe(true)
    if (!('sink' in binding)) return
    binding.onAdopted?.()
    const cancel = vi.spyOn(binding.handle, 'cancel')

    await stopRun(run.id)
    expect(cancel).toHaveBeenCalled()
  })

  it('persists terminal status, exit code, and duration and publishes exactly once even on replay', async () => {
    const run = await seedRemote()
    const binding = (await recoverRemoteRun(run.id, 'worker-1', broadcast))!
    expect('sink' in binding).toBe(true)
    if (!('sink' in binding)) return
    binding.onAdopted?.()

    await binding.sink.onExit('completed', 0)
    await binding.sink.onExit('completed', 0)

    const stored = runs.get(run.id)!
    expect(stored.status).toBe('completed')
    expect(stored.exitCode).toBe(0)
    expect(stored.endedAt).toBeDefined()
    expect(stored.durationMs).toBe((stored.endedAt ?? 0) - run.startedAt)
    expect(publishRunResult).toHaveBeenCalledTimes(1)
    expect(broadcasts.filter(([ch, p]) => ch === 'run:statusChange' && (p as { status: string }).status === 'completed')).toHaveLength(1)
  })

  it('returns a terminal recovery result for a matching completed remote run', async () => {
    const run = await seedRemote({
      id: 'done-run',
      status: 'completed',
      exitCode: 0,
    })
    const result = await recoverRemoteRun(run.id, 'worker-1', broadcast)
    expect(result).toEqual({
      kind: 'terminal',
      runId: run.id,
      workerId: 'worker-1',
      durableSequence: 2,
    })
    expect(getActiveRunIds().has(run.id)).toBe(false)
    expect(publishRunResult).not.toHaveBeenCalled()
  })

  it('returns undefined for local, missing, and worker-mismatch runs', async () => {
    const tmp = tmpDir()
    temps.push(tmp)

    const local = fixture({
      id: 'local-run',
      logPath: path.join(tmp.dir, 'local.jsonl'),
      workerKind: 'local',
      workerId: 'worker-1',
    })
    const mismatch = fixture({
      id: 'other-worker',
      logPath: path.join(tmp.dir, 'other.jsonl'),
      workerKind: 'remote',
      workerId: 'worker-1',
    })
    for (const run of [local, mismatch]) {
      fs.writeFileSync(run.logPath, '')
      runs.set(run.id, run)
    }

    expect(await recoverRemoteRun(local.id, 'worker-1', broadcast)).toBeUndefined()
    expect(await recoverRemoteRun('missing-run', 'worker-1', broadcast)).toBeUndefined()
    expect(await recoverRemoteRun(mismatch.id, 'impostor', broadcast)).toBeUndefined()
  })
})
