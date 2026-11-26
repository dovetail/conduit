/**
 * Startup orphan partition and recovered remote-run sinks.
 *
 * Local / missing-kind orphans fail immediately (unchanged restart message).
 * Remote/eks/fargate runs with a persisted workerId stay `running` for the
 * reconnect window; a matching RecoverRun reconstructs the runner pipeline
 * from the durable log cursor. Unadopted remotes fail once when the timer fires.
 */
import type { ExecutionRun, Repository, RunnerType, RunStatus } from '../shared/types'
import type { WorkerHandle } from '../shared/worker'
import type { RecoverableRunBinding, RecoverRunResult } from './workerControl'
import { peekWorkerControlPlane } from './workerControl'
import { getRun, getOrphanedRuns, updateRun, updateRunIfRunning } from '../main/db/queries/runs'
import { getAgent } from '../main/db/queries/agents'
import { getRepository } from '../main/db/queries/repositories'
import { readHighestContiguousSequence } from './runDeliveryLog'
import {
  appendRunLog,
  createRunOrchestration,
  getActiveRunIds,
  notifyRunFinalized,
  startRepoTokenRefresh,
  type BroadcastFn,
} from './runner'
import { reporter } from './observability'

export const DEFAULT_RECOVERABLE_KINDS = ['remote', 'eks', 'fargate'] as const

const LOCAL_RESTART_MESSAGE =
  '✗ Run did not finish — the Conduit process exited mid-run (deploy, crash, ' +
  'out-of-memory, or disk-pressure eviction). Marked failed on restart.'

const REMOTE_NO_WORKER_MESSAGE =
  '✗ Run did not finish — this remote run had no recorded worker identity when the Conduit server restarted. Marked failed on restart.'

const TERMINAL_STATUSES = new Set<RunStatus>(['completed', 'failed', 'stopped'])

export interface ReconcileOrphanedRunsOptions {
  reconnectTimeoutMs: number
  recoverableKinds?: readonly string[]
  broadcast: BroadcastFn
}

export interface OrphanReconcileHandle {
  stop(): void
  adopted(runId: string): void
}

type ExpiryClaim = 'pending' | 'adopting' | 'adopted' | 'expiring'

interface PendingExpiry {
  timer: NodeJS.Timeout
  claim: ExpiryClaim
  expiredWhileAdopting: boolean
  run: ExecutionRun
  reconnectTimeoutMs: number
  broadcast: BroadcastFn
}

const recoveredBindings = new Map<string, RecoverableRunBinding>()
const pendingExpiry = new Map<string, PendingExpiry>()
let activeReconcile: OrphanReconcileHandle | null = null

function recoverableKindSet(kinds?: readonly string[]): Set<string> {
  return new Set(kinds ?? DEFAULT_RECOVERABLE_KINDS)
}

function isRecoverableKind(kind: string | undefined, kinds: ReadonlySet<string>): boolean {
  return typeof kind === 'string' && kinds.has(kind)
}

function hasWorkerIdentity(run: ExecutionRun): boolean {
  return typeof run.workerId === 'string' && run.workerId.length > 0
}

function isRecoverable(run: ExecutionRun, kinds: ReadonlySet<string>): boolean {
  return run.status === 'running' && isRecoverableKind(run.workerKind, kinds) && hasWorkerIdentity(run)
}

function matchesRemoteWorker(run: ExecutionRun, workerId: string, kinds: ReadonlySet<string>): boolean {
  return isRecoverableKind(run.workerKind, kinds) && hasWorkerIdentity(run) && run.workerId === workerId
}

function immediateFailMessage(run: ExecutionRun, kinds: ReadonlySet<string>): string {
  if (isRecoverableKind(run.workerKind, kinds) && !hasWorkerIdentity(run)) {
    return REMOTE_NO_WORKER_MESSAGE
  }
  return LOCAL_RESTART_MESSAGE
}

function clearExpiry(runId: string): void {
  const pending = pendingExpiry.get(runId)
  if (!pending) return
  pending.claim = 'adopted'
  clearTimeout(pending.timer)
  pendingExpiry.delete(runId)
}

function beginAdoption(runId: string): void {
  const pending = pendingExpiry.get(runId)
  if (!pending) return
  if (pending.claim === 'adopted' || pending.claim === 'expiring') return
  pending.claim = 'adopting'
}

/** Live recovery stays `adopting` until onAdopted/onAbandoned. */
function abandonAdoption(runId: string): void {
  const pending = pendingExpiry.get(runId)
  if (!pending) return
  if (pending.claim === 'adopted' || pending.claim === 'expiring') return
  pending.claim = 'pending'
  if (!pending.expiredWhileAdopting) return
  void failUnadoptedRemote(pending.run, pending.reconnectTimeoutMs, pending.broadcast)
}

export function stopOrphanReconciliation(): void {
  activeReconcile?.stop()
  activeReconcile = null
}

function reconnectExpiryMessage(reconnectTimeoutMs: number): string {
  return `Run did not finish — remote worker did not reconnect within ${reconnectTimeoutMs}ms after the Conduit server restarted.`
}

async function failUnadoptedRemote(
  run: ExecutionRun,
  reconnectTimeoutMs: number,
  broadcast: BroadcastFn
): Promise<void> {
  const pending = pendingExpiry.get(run.id)
  if (!pending) return
  if (pending.claim === 'adopting' || pending.claim === 'adopted') {
    pending.expiredWhileAdopting = true
    return
  }
  if (pending.claim !== 'pending') return
  pending.claim = 'expiring'

  const current = await getRun(run.id)
  if (pending.claim !== 'expiring') return
  if (!current || current.status !== 'running') {
    pendingExpiry.delete(run.id)
    return
  }
  if (getActiveRunIds().has(run.id)) {
    pending.claim = 'pending'
    return
  }

  const text = reconnectExpiryMessage(reconnectTimeoutMs)
  const endedAt = Date.now()
  const durationMs = endedAt - run.startedAt
  if (pending.claim !== 'expiring') return
  const updated = await updateRunIfRunning(run.id, {
    status: 'failed',
    endedAt,
    durationMs,
    lastLine: text.slice(0, 500),
  })
  if (!updated) {
    if (pending.claim === 'expiring') pending.claim = 'pending'
    return
  }
  pendingExpiry.delete(run.id)
  appendRunLog(run.id, text, run.logPath)

  broadcast('run:statusChange', {
    runId: run.id,
    status: 'failed',
    endedAt,
    durationMs,
  })
  reporter.captureMessage(text, 'warning', {
    tags: { component: 'server', op: 'orphanReconcile', runId: run.id },
    extra: { workerId: run.workerId, workerKind: run.workerKind, reconnectTimeoutMs },
  })
  notifyRunFinalized()
}

/**
 * The GitHub App repo whose installation token the run must keep refreshing,
 * or undefined when the run has no repo or the repo uses other auth.
 */
async function githubAppRepoFor(repositoryId: string | undefined): Promise<Repository | undefined> {
  if (!repositoryId) return undefined
  const repo = await getRepository(repositoryId)
  return repo?.authMethod === 'githubapp' ? repo : undefined
}

async function bindRecoveredRun(
  run: ExecutionRun,
  broadcast: BroadcastFn
): Promise<RecoverableRunBinding> {
  const durableSequence = await readHighestContiguousSequence(run.logPath)
  const existing = recoveredBindings.get(run.id)
  if (existing && getActiveRunIds().has(run.id)) {
    const binding = { ...existing, durableSequence }
    recoveredBindings.set(run.id, binding)
    return binding
  }

  const agent = await getAgent(run.agentId)
  const runner: RunnerType = agent?.runner ?? 'claude'
  const orch = createRunOrchestration({ run, broadcast, runner })
  const refreshableRepo = await githubAppRepoFor(agent?.repositoryId)
  const workerId = run.workerId!
  const handle: WorkerHandle = {
    runId: run.id,
    workspacePath: run.workspacePath,
    ephemeral: false,
    workerId,
    cancel: async () => {
      peekWorkerControlPlane()?.requestCancel(run.id)
    },
    updateRepoToken: async (token) => {
      peekWorkerControlPlane()?.sendRepoToken(run.id, token)
    },
  }

  const sink = {
    ...orch.sink,
    onExit: (status: Parameters<typeof orch.sink.onExit>[0], exitCode: Parameters<typeof orch.sink.onExit>[1]) => {
      recoveredBindings.delete(run.id)
      return orch.sink.onExit(status, exitCode)
    },
  }

  const binding: RecoverableRunBinding = {
    runId: run.id,
    workerId,
    sink,
    handle,
    durableSequence,
    onAdopted: () => {
      // A reconnect that re-adopts an already-live run must not arm a second timer.
      const firstAdoption = !recoveredBindings.has(run.id)
      orch.register(handle)
      recoveredBindings.set(run.id, binding)
      clearExpiry(run.id)
      if (firstAdoption && refreshableRepo) {
        startRepoTokenRefresh(run.id, refreshableRepo, handle, orch)
      }
    },
    onAbandoned: () => {
      orch.abort()
      recoveredBindings.delete(run.id)
      abandonAdoption(run.id)
    },
  }
  return binding
}

/**
 * Reconstruct a control-plane binding for a still-running remote/eks/fargate
 * run whose persisted workerId matches. Cursor is the contiguous prefix of the
 * persistent run log — never a DB field, never padded with marker rows.
 */
export async function recoverRemoteRun(
  runId: string,
  workerId: string,
  broadcast: BroadcastFn
): Promise<RecoverRunResult> {
  beginAdoption(runId)
  try {
    const run = await getRun(runId)
    const kinds = recoverableKindSet()
    if (!run || !matchesRemoteWorker(run, workerId, kinds)) {
      abandonAdoption(runId)
      return undefined
    }

    if (run.status !== 'running') {
      abandonAdoption(runId)
      if (!TERMINAL_STATUSES.has(run.status)) return undefined
      return {
        kind: 'terminal',
        runId: run.id,
        workerId,
        durableSequence: await readHighestContiguousSequence(run.logPath),
      }
    }

    const binding = await bindRecoveredRun(run, broadcast)
    const latest = await getRun(runId)
    if (!latest || latest.status !== 'running') {
      binding.onAbandoned?.()
      return undefined
    }
    return binding
  } catch (err) {
    abandonAdoption(runId)
    throw err
  }
}

export async function reconcileOrphanedRuns(
  opts: ReconcileOrphanedRunsOptions
): Promise<OrphanReconcileHandle> {
  const recoverableKinds = recoverableKindSet(opts.recoverableKinds)
  const orphaned = await getOrphanedRuns()
  const immediate: ExecutionRun[] = []
  const pending: ExecutionRun[] = []
  for (const run of orphaned) {
    if (isRecoverable(run, recoverableKinds)) pending.push(run)
    else immediate.push(run)
  }

  for (const run of immediate) {
    const text = immediateFailMessage(run, recoverableKinds)
    appendRunLog(run.id, text, run.logPath)
    await updateRun(run.id, { status: 'failed', endedAt: Date.now() })
  }
  if (immediate.length > 0) {
    console.log(`[server] Marked ${immediate.length} orphaned run(s) as failed`)
    reporter.captureMessage(
      `Marked ${immediate.length} orphaned run(s) as failed on startup — the previous Conduit ` +
        `process exited mid-run (deploy, crash, OOM, or disk-pressure eviction).`,
      'warning',
      {
        tags: { component: 'server', op: 'orphanReconcile' },
        extra: { count: immediate.length, runIds: immediate.map((r) => r.id) },
      }
    )
  }

  const handle: OrphanReconcileHandle = {
    stop() {
      for (const runId of [...pendingExpiry.keys()]) clearExpiry(runId)
      if (activeReconcile === handle) activeReconcile = null
    },
    adopted(runId: string) {
      clearExpiry(runId)
    },
  }

  for (const run of pending) {
    const timer = setTimeout(() => {
      void failUnadoptedRemote(run, opts.reconnectTimeoutMs, opts.broadcast)
    }, opts.reconnectTimeoutMs)
    timer.unref()
    pendingExpiry.set(run.id, {
      timer,
      claim: 'pending',
      expiredWhileAdopting: false,
      run,
      reconnectTimeoutMs: opts.reconnectTimeoutMs,
      broadcast: opts.broadcast,
    })
  }

  activeReconcile = handle
  return handle
}
