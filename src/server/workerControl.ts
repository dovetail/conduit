/**
 * Worker control plane — the server side of the /ws/worker secure WebSocket.
 *
 * conduit-worker processes (and EKS/Fargate tasks, later) connect outbound to
 * this endpoint with a Bearer token, advertise their runner capabilities, and
 * heartbeat a lease. The RemoteWorkerFactory dispatches RunSpecs to connected
 * workers here; run events stream back and are fed into each run's
 * WorkerEventSink so the orchestrator's log/broadcast/finalize pipeline is
 * identical to local execution.
 *
 * Isolation: worker sockets live in this module's own registry — never in the
 * browser `clients` broadcast set — so run logs can't leak to workers and
 * workers can't invoke browser RPC channels.
 */
import { WebSocketServer, WebSocket } from 'ws'
import type { IncomingMessage } from 'http'
import type { Duplex } from 'stream'
import * as path from 'path'
import type { RunSpec, WorkerEventSink, WorkerHandle, WorkerExitStatus } from '../shared/worker'
import type { RunEventInit } from '../shared/types'
import type { ServerToWorkerMessage, WorkerCapabilities } from '../shared/workerControl'
import {
  WORKER_LEASE_MS,
  WORKER_MAX_MESSAGE_BYTES,
  parseWorkerToServerMessage,
  resolveWorkerReconnectTimeoutMs,
} from '../shared/workerControl'
import { reporter } from './observability'
import { LOGS_DIR } from '../main/utils/paths'
import {
  openDeliveryLog,
  resolveRunLogMaxBytes,
  type DeliveryLogWriter,
  type OpenDeliveryLog,
} from './runDeliveryLog'

const DEFAULT_ASSIGN_TIMEOUT_MS = 120_000
const DEFAULT_CONNECT_TIMEOUT_MS = 600_000

/**
 * Reason sent with `run:reject`. Deliberately generic: a worker that reported a
 * run it cannot own must learn to stop retrying without learning why (whether
 * the run exists, belongs to someone else, or is already terminal).
 */
const REJECT_REASON = 'run is not recoverable on this server'

/** First delay before re-driving a terminal frame whose finalization failed. */
const DEFAULT_EXIT_RETRY_INITIAL_DELAY_MS = 500
/** Ceiling for the exponential backoff between those re-drives. */
const DEFAULT_EXIT_RETRY_MAX_DELAY_MS = 15_000

/**
 * How long to wait for a WebSocket pong when probing whether a socket that still
 * holds assignments is alive. A half-open peer never answers; a live `ws` client
 * pongs immediately. Kept short so a reconnecting worker can take over well
 * inside `WORKER_LEASE_MS`. Tests may override via `socketProbeTimeoutMs`.
 */
const DEFAULT_SOCKET_PROBE_TIMEOUT_MS = 300

function parsePositiveMs(raw: string | undefined, fallback: number): number {
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

/** How long a run:assign waits for the worker's run:started before failing. */
export function resolveAssignTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  return parsePositiveMs(env.CONDUIT_WORKER_ASSIGN_TIMEOUT_MS, DEFAULT_ASSIGN_TIMEOUT_MS)
}

/** Default wait for a named worker to connect (Job/Task-per-run factories:
 *  pod/task startup + image pull can take minutes). */
export function resolveConnectTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  return parsePositiveMs(env.CONDUIT_WORKER_CONNECT_TIMEOUT_MS, DEFAULT_CONNECT_TIMEOUT_MS)
}

/** Import-time default from process.env — factories that don't pass waitMs. */
export const WORKER_CONNECT_TIMEOUT_MS = resolveConnectTimeoutMs()

/** Optional constructor injection for timeouts and frame limits. */
export interface WorkerControlPlaneOptions {
  assignTimeoutMs?: number
  connectTimeoutMs?: number
  maxMessageBytes?: number
  /** Lease window; tests inject a short value. Default `WORKER_LEASE_MS`. */
  leaseMs?: number
  /** Detach window after an ordinary socket close. Tests inject a short value. */
  reconnectTimeoutMs?: number
  /** Directory for sequenced run logs (`<runId>.jsonl`). */
  logsDir?: string
  /** Per-run on-disk log cap for durable appends. `0` disables it. */
  runLogMaxBytes?: number
  /** First backoff step before re-driving a failed terminal frame (default 500). */
  exitRetryInitialDelayMs?: number
  /** Ceiling for that backoff (default 15000). */
  exitRetryMaxDelayMs?: number
  /**
   * Ping/pong wait when deciding whether a duplicate-identity hello may take
   * over a socket that still holds assignments. Tests inject a short value.
   */
  socketProbeTimeoutMs?: number
  /** Reconstruct a binding when a reconnecting worker reports a run this process does not hold. */
  recoverRun?: RecoverRun
  /** Tests inject a gated writer to prove per-run serialize-during-fsync. */
  openDeliveryLog?: OpenDeliveryLog
}

export interface RecoverableRunBinding {
  runId: string
  workerId: string
  sink: WorkerEventSink
  handle: WorkerHandle
  durableSequence: number
  /** Invoked only after this binding is installed on a still-live worker socket. */
  onAdopted?: () => void
  /** Invoked when recovery completed but the socket died before install. */
  onAbandoned?: () => void
}

/** Matching remote run already terminal in the DB — ACK replay without a live sink. */
export interface RecoveredTerminalRun {
  kind: 'terminal'
  runId: string
  workerId: string
  durableSequence: number
}

export type RecoverRunResult = RecoverableRunBinding | RecoveredTerminalRun | undefined

export type RecoverRun = (runId: string, workerId: string) => Promise<RecoverRunResult>

export function isRecoveredTerminalRun(result: RecoverRunResult): result is RecoveredTerminalRun {
  return !!result && 'kind' in result && result.kind === 'terminal'
}

interface ConnectedWorker {
  workerId: string
  ws: WebSocket
  capabilities: WorkerCapabilities
  lastHeartbeat: number
  /** Run ids this worker reported in its latest heartbeat/hello. */
  reportedRunIds: Set<string>
}

/**
 * Frames for one run are either all sequenced (resumable delivery) or all
 * legacy/unsequenced. Mixing the two would let an unsequenced frame bypass the
 * durable cursor after resumable delivery is established, so the first frame
 * fixes the mode and the other kind is dropped from then on.
 */
type DeliveryMode = 'unset' | 'sequenced' | 'legacy'

interface Assignment {
  spec: RunSpec
  sink: WorkerEventSink
  workerId: string
  /** Socket currently bound to this run; null while detached for reconnect. */
  ws: WebSocket | null
  /** Monotonic id so a timed-out assignment's late run:started cannot settle a retry. */
  generation: number
  /** Token sent on run:assign and required on run:started after a retry. */
  assignId: string
  /** Rebuilt after a server replacement — the worker still echoes the original
   *  assignId, which this process never issued, so assignId is not checked. */
  recovered: boolean
  mode: DeliveryMode
  workspacePath?: string
  started: boolean
  /**
   * Highest contiguous sequence durably applied. Tracks the delivery log's
   * cursor for event frames and additionally advances past the terminal frame,
   * whose durable record is the run's DB status rather than a log row.
   */
  durableSequence: number
  log: DeliveryLogWriter
  reconnectTimer?: NodeJS.Timeout
  /** True while sequenced onExit is awaiting durable finalization. */
  exitInFlight?: boolean
  /** Armed re-drive of a terminal frame whose finalization failed. */
  exitRetryTimer?: NodeJS.Timeout
  /** Next backoff step for that re-drive. */
  exitRetryDelayMs?: number
  /** Absolute deadline for re-driving, one delivery window from the first failure. */
  exitRetryDeadline?: number
  settle: (handle: WorkerHandle) => void
  fail: (err: Error) => void
  timeout: NodeJS.Timeout
}

/** Outcome of trying to (re)bind one run a reconnecting worker reported. */
type AdoptionOutcome = 'bound' | 'declined' | 'skipped'

interface StartedSuppression {
  runId: string
  generation: number
  ws: WebSocket
}

export class WorkerControlPlane {
  private wss = new WebSocketServer({ noServer: true })
  private workers = new Map<string, ConnectedWorker>()
  private runs = new Map<string, Assignment>()
  /** Named workers that Job/Task-per-run factories are waiting to connect. */
  private waiters = new Map<
    string,
    {
      resolve: (worker: ConnectedWorker) => void
      reject: (err: Error) => void
      timer: NodeJS.Timeout
    }
  >()
  private leaseTimer: NodeJS.Timeout
  private readonly assignTimeoutMs: number
  private readonly connectTimeoutMs: number
  private readonly maxMessageBytes: number
  private readonly leaseMs: number
  private readonly reconnectTimeoutMs: number
  private readonly logsDir: string
  private readonly runLogMaxBytes: number
  private readonly exitRetryInitialDelayMs: number
  private readonly exitRetryMaxDelayMs: number
  private readonly socketProbeTimeoutMs: number
  private readonly recoverRun?: RecoverRun
  private readonly openLog: OpenDeliveryLog
  private nextAssignmentGeneration = 1
  /** Timed-out assignment identities; a retry on a new generation is not suppressed. */
  private ignoreNextStarted = new Set<StartedSuppression>()
  /** Terminal sequences already applied; lost-ACK replay is acknowledged without re-finalizing. */
  private finalAcks = new Map<string, { workerId: string; sequence: number }>()
  /** Replacement-process terminal recoveries: ACK frames without a live sink. */
  private terminalRuns = new Map<string, { workerId: string; durableSequence: number }>()
  /** Per-run serialize of decision+append/sink/cursor/ACK across sockets. */
  private runLocks = new Map<string, Promise<void>>()

  constructor(options?: WorkerControlPlaneOptions) {
    this.assignTimeoutMs = options?.assignTimeoutMs ?? resolveAssignTimeoutMs()
    this.connectTimeoutMs = options?.connectTimeoutMs ?? resolveConnectTimeoutMs()
    this.maxMessageBytes = options?.maxMessageBytes ?? WORKER_MAX_MESSAGE_BYTES
    this.leaseMs = options?.leaseMs ?? WORKER_LEASE_MS
    this.reconnectTimeoutMs = options?.reconnectTimeoutMs ?? resolveWorkerReconnectTimeoutMs()
    this.logsDir = options?.logsDir ?? LOGS_DIR
    this.runLogMaxBytes = options?.runLogMaxBytes ?? resolveRunLogMaxBytes()
    this.exitRetryInitialDelayMs =
      options?.exitRetryInitialDelayMs ?? DEFAULT_EXIT_RETRY_INITIAL_DELAY_MS
    this.exitRetryMaxDelayMs = options?.exitRetryMaxDelayMs ?? DEFAULT_EXIT_RETRY_MAX_DELAY_MS
    this.socketProbeTimeoutMs = options?.socketProbeTimeoutMs ?? DEFAULT_SOCKET_PROBE_TIMEOUT_MS
    this.recoverRun = options?.recoverRun
    this.openLog = options?.openDeliveryLog ?? openDeliveryLog
    this.wss.on('connection', (ws) => this.onConnection(ws))
    this.leaseTimer = setInterval(() => this.checkLeases(), this.leaseMs / 3)
    this.leaseTimer.unref()
  }

  /** The shared secret workers must present. Unset = endpoint refuses all upgrades. */
  static token(): string | undefined {
    return process.env.CONDUIT_WORKER_TOKEN?.trim() || undefined
  }

  /** Upgrade entry point for /ws/worker (called from the server's upgrade handler). */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const token = WorkerControlPlane.token()
    const presented = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '')
    if (!token || presented !== token) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
      socket.destroy()
      return
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      this.wss.emit('connection', ws, req)
    })
  }

  /** Connected worker count (observability + tests). */
  get connectedWorkerCount(): number {
    return this.workers.size
  }

  /** Assignments this process still holds — zero once every run is settled. */
  get activeAssignmentCount(): number {
    return this.runs.size
  }

  /**
   * Dispatch a RunSpec to the least-loaded connected worker that supports the
   * runner. Resolves with the run's handle once the worker reports execution
   * is live (run:started); rejects if prep fails on the worker, no suitable
   * worker is connected, or the assignment times out.
   */
  assign(spec: RunSpec, sink: WorkerEventSink): Promise<WorkerHandle> {
    const worker = this.pickWorker(spec.runner)
    if (!worker) {
      return Promise.reject(
        new Error(
          `No connected worker supports runner "${spec.runner}" ` +
            `(${this.workers.size} worker(s) connected).`
        )
      )
    }

    return this.assignToConnected(worker, spec, sink)
  }

  /**
   * Dispatch a RunSpec to a specific named worker, waiting for it to connect
   * if necessary. Used by Job/Task-per-run factories (EKS/Fargate), which
   * create infrastructure that then dials in with a known workerId.
   */
  assignTo(
    workerId: string,
    spec: RunSpec,
    sink: WorkerEventSink,
    waitMs?: number
  ): Promise<WorkerHandle> {
    const timeoutMs = waitMs ?? this.connectTimeoutMs
    const existing = this.workers.get(workerId)
    if (existing) return this.assignToConnected(existing, spec, sink)
    return new Promise<WorkerHandle>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(workerId)
        reject(new Error(`Worker ${workerId} did not connect within ${timeoutMs}ms`))
      }, timeoutMs)
      this.waiters.set(workerId, {
        resolve: (worker) => {
          clearTimeout(timer)
          this.waiters.delete(workerId)
          resolve(this.assignToConnected(worker, spec, sink))
        },
        reject: (err) => {
          clearTimeout(timer)
          this.waiters.delete(workerId)
          reject(err)
        },
        timer,
      })
    })
  }

  /**
   * Drop a pending assignTo waiter (and any unstarted assignment) for this
   * worker so a late hello cannot dispatch a RunSpec the caller already failed.
   */
  cancelAssignTo(workerId: string, err: Error): void {
    this.waiters.get(workerId)?.reject(err)
    for (const a of [...this.runs.values()]) {
      if (a.workerId !== workerId || a.started) continue
      this.sendOn(a.ws, { type: 'run:cancel', runId: a.spec.runId })
      a.fail(err)
    }
  }

  private async assignToConnected(
    worker: ConnectedWorker,
    spec: RunSpec,
    sink: WorkerEventSink
  ): Promise<WorkerHandle> {
    const runId = spec.runId
    // A brand-new assignment starts at cursor 0, so the writer is opened with a
    // known cursor and never scans the log. Done before run:assign is sent, so
    // no frame can arrive before the assignment is registered.
    const log = await this.openDeliveryLogFor(runId, 0)
    return new Promise<WorkerHandle>((resolve, reject) => {
      const generation = this.nextAssignmentGeneration++
      const assignId = `${generation}`
      const assignment: Assignment = {
        spec,
        sink,
        workerId: worker.workerId,
        ws: worker.ws,
        generation,
        assignId,
        recovered: false,
        mode: 'unset',
        started: false,
        durableSequence: log.cursor,
        log,
        settle: (handle) => {
          assignment.started = true
          clearTimeout(assignment.timeout)
          resolve(handle)
        },
        fail: (err) => {
          clearTimeout(assignment.timeout)
          this.clearReconnectTimer(assignment)
          this.runs.delete(runId)
          reject(err)
        },
        timeout: setTimeout(() => {
          const a = this.runs.get(runId)
          if (a && !a.started && a.generation === assignment.generation) {
            if (a.ws) this.ignoreNextStarted.add({ runId, generation: a.generation, ws: a.ws })
            this.sendOn(a.ws, { type: 'run:cancel', runId })
            a.fail(
              new Error(
                `Worker ${a.workerId} did not start run ${runId} within ${this.assignTimeoutMs}ms`
              )
            )
          }
        }, this.assignTimeoutMs),
      }
      this.runs.set(runId, assignment)
      this.sendOn(worker.ws, {
        type: 'run:assign',
        spec,
        assignId,
        reconnectTimeoutMs: this.reconnectTimeoutMs,
      })
    })
  }

  /** Open a run's durable delivery log. `cursor` omitted ⇒ derive it by scan. */
  private openDeliveryLogFor(runId: string, cursor?: number): Promise<DeliveryLogWriter> {
    return this.openLog(path.join(this.logsDir, `${runId}.jsonl`), {
      maxBytes: this.runLogMaxBytes,
      cursor,
    })
  }

  /** Least-loaded connected worker advertising the runner CLI. */
  private pickWorker(runner: string): ConnectedWorker | undefined {
    let best: ConnectedWorker | undefined
    let bestLoad = Infinity
    for (const w of this.workers.values()) {
      if (!w.capabilities.runners.includes(runner as WorkerCapabilities['runners'][number])) continue
      let load = 0
      for (const a of this.runs.values()) if (a.workerId === w.workerId) load++
      if (load < bestLoad) {
        best = w
        bestLoad = load
      }
    }
    return best
  }

  private sendOn(ws: WebSocket | null | undefined, msg: ServerToWorkerMessage): void {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg))
    }
  }

  /** Send run:cancel on the currently bound socket (no-op if detached/unbound). */
  requestCancel(runId: string): void {
    const a = this.runs.get(runId)
    if (a) this.sendOn(a.ws, { type: 'run:cancel', runId })
  }

  private buildHandle(runId: string, assignment: Assignment): WorkerHandle {
    return {
      runId,
      workspacePath: assignment.workspacePath,
      // Remote workspaces live on the worker's disk — the worker sweeps them;
      // the server's cleanup must not try to delete paths it can't see.
      worktreeClonePath: undefined,
      ephemeral: false,
      workerId: assignment.workerId,
      cancel: async () => {
        this.requestCancel(runId)
      },
      // Best effort: a detached run misses this refresh and gets the next one.
      updateRepoToken: async (token) => {
        const a = this.runs.get(runId)
        if (a) this.sendOn(a.ws, { type: 'run:credentials', runId, repoToken: token })
      },
      updateMcpAuth: async (auth) => {
        const a = this.runs.get(runId)
        if (a) this.sendOn(a.ws, { type: 'run:mcpAuth', runId, auth })
      },
    }
  }

  private onConnection(ws: WebSocket): void {
    let workerId: string | undefined
    let closed = false
    let protocolClose = false
    let chain = Promise.resolve()

    const rejectSocket = (code: number, reason: string): void => {
      if (closed) return
      closed = true
      protocolClose = true
      try {
        ws.close(code, reason)
      } catch {
        // already closing
      }
    }

    ws.on('message', (data) => {
      chain = chain
        .then(() => this.handleSocketMessage(ws, data, {
          get workerId() {
            return workerId
          },
          set workerId(id: string | undefined) {
            workerId = id
          },
          closed: () => closed,
          rejectSocket,
        }))
        .catch((err) => {
          reporter.captureException(err, {
            tags: { component: 'worker-control', workerId: workerId ?? 'unknown' },
          })
        })
    })

    ws.on('close', () => {
      closed = true
      if (!workerId) return
      const w = this.workers.get(workerId)
      if (w?.ws === ws) {
        this.workers.delete(workerId)
        if (protocolClose) {
          this.failRunsOfWorker(workerId, 'protocol violation', { systemEvent: false, ws })
        } else {
          console.warn(`[worker-control] Worker disconnected: ${workerId}`)
          this.detachOrFailRuns(workerId, ws)
        }
      }
    })
  }

  private async handleSocketMessage(
    ws: WebSocket,
    data: Buffer | ArrayBuffer | Buffer[] | string,
    ctx: {
      workerId: string | undefined
      closed: () => boolean
      rejectSocket: (code: number, reason: string) => void
    }
  ): Promise<void> {
    if (ctx.closed()) return
    if (rawMessageBytes(data) > this.maxMessageBytes) {
      ctx.rejectSocket(1009, 'message too large')
      return
    }
    const parsed = parseWorkerToServerMessage(data.toString())
    if (!parsed.ok) {
      ctx.rejectSocket(parsed.error === 'oversized-batch' ? 1009 : 1008, parsed.error)
      return
    }
    const msg = parsed.message
    if (!ctx.workerId && msg.type !== 'worker:hello') {
      ctx.rejectSocket(1008, 'hello required')
      return
    }
    if (ctx.workerId) {
      const w = this.workers.get(ctx.workerId)
      if (w && w.ws === ws) w.lastHeartbeat = Date.now()
    }

    switch (msg.type) {
      case 'worker:hello': {
        if (ctx.workerId && msg.workerId !== ctx.workerId) {
          console.warn(
            `[worker-control] Ignoring identity change on socket ${ctx.workerId} → ${msg.workerId}`
          )
          break
        }
        if (ctx.workerId && msg.workerId === ctx.workerId) {
          const current = this.workers.get(ctx.workerId)
          if (current && current.ws === ws) {
            current.capabilities = msg.capabilities
            current.lastHeartbeat = Date.now()
            current.reportedRunIds = new Set(msg.activeRunIds)
          }
          break
        }
        const existing = this.workers.get(msg.workerId)
        if (existing && existing.ws !== ws) {
          if (this.hasAssignmentsOn(existing.ws)) {
            const claimed = [...msg.activeRunIds, ...(msg.pendingRunIds ?? [])]
            const mayTakeOver = this.claimsIntersectWorkerAssignments(msg.workerId, claimed)
            if (!mayTakeOver) {
              ctx.rejectSocket(4002, 'duplicate identity with active assignment')
              break
            }
            const oldWs = existing.ws
            const alive = await this.probeSocketAlive(oldWs)
            if (ctx.closed()) break
            // Re-read after the probe await — another hello may have moved the binding.
            const current = this.workers.get(msg.workerId)
            if (current?.ws === ws) {
              // Already bound to this socket (racing hello completed); refresh below.
            } else if (
              alive &&
              oldWs.readyState === WebSocket.OPEN &&
              current?.ws === oldWs
            ) {
              ctx.rejectSocket(4002, 'duplicate identity with active assignment')
              break
            } else if (current?.ws === oldWs || !current) {
              // Half-open / dead peer: move the identity onto this socket. Do not
              // failRunsOfWorker — the reconnecting worker still owns the runs.
              this.seizeWorkerSocket(msg.workerId, oldWs, ws)
              console.warn(
                `[worker-control] Worker ${msg.workerId} reclaimed half-open socket ` +
                  `(claimed ${claimed.length} run id(s))`
              )
            } else {
              // A different live socket already holds this identity.
              ctx.rejectSocket(4002, 'duplicate identity with active assignment')
              break
            }
          } else {
            existing.ws.close(4000, 'replaced by new connection')
          }
        }
        ctx.workerId = msg.workerId
        this.workers.set(msg.workerId, {
          workerId: msg.workerId,
          ws,
          capabilities: msg.capabilities,
          lastHeartbeat: Date.now(),
          reportedRunIds: new Set(msg.activeRunIds),
        })
        console.log(
          `[worker-control] Worker connected: ${msg.workerId} ` +
            `(runners: ${msg.capabilities.runners.join(', ') || 'none'}, v${msg.capabilities.version})`
        )
        this.waiters.get(msg.workerId)?.resolve(this.workers.get(msg.workerId)!)
        if (ws.readyState !== WebSocket.OPEN || ctx.closed()) {
          this.workers.delete(msg.workerId)
          this.detachOrFailRuns(msg.workerId, ws)
          break
        }
        await this.adoptPendingRuns(msg.workerId, ws, msg.pendingRunIds ?? [])
        break
      }
      case 'worker:heartbeat': {
        const w = ctx.workerId ? this.workers.get(ctx.workerId) : undefined
        if (w && w.ws === ws) {
          w.lastHeartbeat = Date.now()
          w.reportedRunIds = new Set(msg.activeRunIds)
        }
        break
      }
      case 'run:started': {
        await this.enqueueRunWork(msg.runId, () => this.handleRunStarted(ws, ctx.workerId, msg))
        break
      }
      case 'run:event': {
        await this.enqueueRunWork(msg.runId, () => this.handleRunEvent(ws, ctx.workerId, msg))
        break
      }
      case 'run:exit': {
        await this.enqueueRunWork(msg.runId, () => this.handleRunExit(ws, ctx.workerId, msg))
        break
      }
    }
  }

  private enqueueRunWork<T>(runId: string, work: () => Promise<T>): Promise<T> {
    const prev = this.runLocks.get(runId) ?? Promise.resolve()
    const next = prev.then(work, work)
    this.runLocks.set(
      runId,
      next.then(
        () => undefined,
        () => undefined
      )
    )
    return next
  }

  private liveAckSocket(runId: string): WebSocket | null {
    return this.runs.get(runId)?.ws ?? null
  }

  private notifySinkEvent(sink: WorkerEventSink, ev: RunEventInit, durable: boolean): void {
    if (durable && sink.onDurableEvent) sink.onDurableEvent(ev)
    else sink.onEvent(ev)
  }

  private socketStillBound(workerId: string, ws: WebSocket): boolean {
    return ws.readyState === WebSocket.OPEN && this.workers.get(workerId)?.ws === ws
  }

  /**
   * Accept the frame's delivery mode, or drop it. The first frame decides; a
   * later frame of the other kind is refused so an unsequenced frame can never
   * bypass the durable cursor of a run already using resumable delivery.
   */
  private acceptMode(a: Assignment, sequenced: boolean): boolean {
    const mode: DeliveryMode = sequenced ? 'sequenced' : 'legacy'
    if (a.mode === 'unset') {
      a.mode = mode
      return true
    }
    if (a.mode === mode) return true
    console.warn(
      `[worker-control] Dropping ${mode} frame for run ${a.spec.runId} — ` +
        `assignment is in ${a.mode} delivery mode`
    )
    return false
  }

  private async handleRunStarted(
    ws: WebSocket,
    workerId: string | undefined,
    msg: { runId: string; sequence?: number; workspacePath?: string; assignId?: string }
  ): Promise<void> {
    if (this.ackIfFinalized(ws, workerId, msg.runId, msg.sequence)) return
    if (this.ackIfTerminalRecovery(ws, workerId, msg.runId, msg.sequence)) return
    const a = this.ownedAssignment(msg.runId, ws)
    if (!a) return
    if (!a.recovered && msg.assignId && msg.assignId !== a.assignId) return
    if (!msg.assignId && this.hasStaleSuppression(msg.runId, ws, a.generation)) return
    if (this.consumeIgnoredStarted(msg.runId, ws, a.generation)) return
    if (!this.acceptMode(a, msg.sequence !== undefined)) return
    if (msg.sequence === undefined) {
      if (a.started) return
      a.workspacePath = msg.workspacePath
      a.settle(this.buildHandle(msg.runId, a))
      return
    }
    const decision = this.sequenceDecision(a, msg.sequence)
    if (decision === 'gap') return
    if (decision === 'duplicate') {
      this.sendAck(this.liveAckSocket(msg.runId), msg.runId, msg.sequence)
      return
    }
    const persist = await a.log.append([], msg.sequence)
    if (persist === 'rejected') return
    if (!a.started) {
      a.workspacePath = msg.workspacePath
      a.settle(this.buildHandle(msg.runId, a))
    }
    a.durableSequence = msg.sequence
    this.sendAck(this.liveAckSocket(msg.runId), msg.runId, msg.sequence)
  }

  private async handleRunEvent(
    ws: WebSocket,
    workerId: string | undefined,
    msg: { runId: string; sequence?: number; events: RunEventInit[] }
  ): Promise<void> {
    if (this.ackIfFinalized(ws, workerId, msg.runId, msg.sequence)) return
    if (this.ackIfTerminalRecovery(ws, workerId, msg.runId, msg.sequence)) return
    const a = this.ownedAssignment(msg.runId, ws)
    if (!a) return
    if (!this.acceptMode(a, msg.sequence !== undefined)) return
    if (msg.sequence === undefined) {
      for (const ev of msg.events) a.sink.onEvent(ev)
      return
    }
    const decision = this.sequenceDecision(a, msg.sequence)
    if (decision === 'gap') return
    if (decision === 'duplicate') {
      this.sendAck(this.liveAckSocket(msg.runId), msg.runId, msg.sequence)
      return
    }
    const persist = await a.log.append(msg.events, msg.sequence)
    if (persist === 'rejected') return
    // `capped` means the cursor advanced durably but the events were not
    // written (log at its byte cap) — still stream them live, still ACK.
    if (persist === 'appended' || persist === 'capped') {
      for (const ev of msg.events) this.notifySinkEvent(a.sink, ev, true)
    }
    a.durableSequence = msg.sequence
    this.sendAck(this.liveAckSocket(msg.runId), msg.runId, msg.sequence)
  }

  private async handleRunExit(
    ws: WebSocket,
    workerId: string | undefined,
    msg: { runId: string; sequence?: number; status: WorkerExitStatus; exitCode?: number | null }
  ): Promise<void> {
    if (this.ackIfFinalized(ws, workerId, msg.runId, msg.sequence)) return
    if (this.ackIfTerminalRecovery(ws, workerId, msg.runId, msg.sequence)) return
    const a = this.ownedAssignment(msg.runId, ws)
    if (!a) return
    if (!this.acceptMode(a, msg.sequence !== undefined)) return
    if (msg.sequence === undefined) {
      if (!a.started) {
        a.fail(
          new Error(`Worker ${a.workerId} failed to start run ${msg.runId} (status: ${msg.status})`)
        )
      } else {
        clearTimeout(a.timeout)
        this.clearReconnectTimer(a)
        this.runs.delete(msg.runId)
        await Promise.resolve(a.sink.onExit(msg.status, msg.exitCode))
      }
      return
    }
    const decision = this.sequenceDecision(a, msg.sequence)
    if (decision === 'gap') return
    if (decision === 'duplicate') {
      this.sendAck(this.liveAckSocket(msg.runId) ?? ws, msg.runId, msg.sequence)
      return
    }
    if (!a.started) {
      a.fail(
        new Error(`Worker ${a.workerId} failed to start run ${msg.runId} (status: ${msg.status})`)
      )
      a.durableSequence = msg.sequence
      this.sendAck(ws, msg.runId, msg.sequence)
      return
    }
    a.exitInFlight = true
    try {
      await Promise.resolve(a.sink.onExit(msg.status, msg.exitCode))
    } catch (err) {
      // Terminal state was not persisted. Do not record a final ACK and do not
      // acknowledge, so the worker keeps the frame spooled — but the worker has
      // no reason to resend on its own (its cursor covers the frame and the
      // socket is fine), so the server must ask for it again.
      a.exitInFlight = false
      reporter.captureException(err instanceof Error ? err : new Error(String(err)), {
        tags: { component: 'worker-control', op: 'runExit', workerId: a.workerId, runId: msg.runId },
      })
      console.error(
        `[worker-control] Terminal finalization failed for run ${msg.runId} — ` +
          `leaving the frame unacknowledged for replay:`,
        err
      )
      if (this.isLiveSocket(a.ws)) {
        this.scheduleExitRedrive(a)
      } else {
        // A socket that died mid-finalize skipped arming the detach timer, and
        // its reconnect resume will re-deliver the frame anyway.
        this.armReconnectTimerIfDetached(a)
      }
      return
    }
    a.exitInFlight = false
    a.durableSequence = msg.sequence
    this.finalAcks.set(msg.runId, { workerId: a.workerId, sequence: msg.sequence })
    const ackWs = this.liveAckSocket(msg.runId) ?? ws
    clearTimeout(a.timeout)
    this.clearReconnectTimer(a)
    this.clearExitRedrive(a)
    this.runs.delete(msg.runId)
    this.sendAck(ackWs, msg.runId, msg.sequence)
  }

  private isLiveSocket(ws: WebSocket | null | undefined): ws is WebSocket {
    return !!ws && ws.readyState === WebSocket.OPEN
  }

  /**
   * Arm the next re-drive of a terminal frame the server could not persist.
   *
   * Backs off exponentially and is bounded by one delivery window from the first
   * failure on this socket — the same window a disconnected worker gets — so a
   * wedged database cannot keep a one-shot task (and its bill) alive
   * indefinitely. Only one timer is ever armed, so repeated failures cannot
   * become a hot loop.
   */
  private scheduleExitRedrive(a: Assignment): void {
    if (a.exitRetryTimer) return
    const now = Date.now()
    if (a.exitRetryDeadline === undefined) a.exitRetryDeadline = now + this.reconnectTimeoutMs
    const remaining = a.exitRetryDeadline - now
    if (remaining <= 0 && !a.exitInFlight) {
      this.abandonTerminalDelivery(a)
      return
    }
    const step = a.exitRetryDelayMs ?? this.exitRetryInitialDelayMs
    a.exitRetryDelayMs = Math.min(step * 2, this.exitRetryMaxDelayMs)
    a.exitRetryTimer = setTimeout(() => {
      a.exitRetryTimer = undefined
      this.redriveTerminalFrame(a)
    }, remaining > 0 ? Math.min(step, remaining) : step)
  }

  /** Ask the worker to rewind to the durable cursor and resend the terminal frame. */
  private redriveTerminalFrame(a: Assignment): void {
    const runId = a.spec.runId
    if (this.runs.get(runId) !== a) return
    if (!this.isLiveSocket(a.ws)) {
      // Disconnected in the meantime: reconnect resume owns recovery now, under
      // the detach deadline, so a stale retry must not shadow it.
      this.clearExitRedrive(a)
      this.armReconnectTimerIfDetached(a)
      return
    }
    if (a.exitInFlight) {
      // A resend is already being finalized, so that attempt owns the outcome:
      // asking again would queue a duplicate behind it, and giving up on the
      // window would reject a frame the finalize may be about to ACK. Checked
      // before the deadline for exactly that reason.
      this.scheduleExitRedrive(a)
      return
    }
    const now = Date.now()
    const deadline = a.exitRetryDeadline ?? 0
    const step = a.exitRetryDelayMs ?? this.exitRetryInitialDelayMs
    // The follow-up timer waits this long for the resent frame. Asking when
    // less than that remains clamps the timer to a few milliseconds and rejects
    // the delivery before the frame is read, so the worker's answer is dropped.
    // Give up instead of requesting a frame this window can no longer accept.
    if (!(now < deadline && deadline - now >= step)) {
      this.abandonTerminalDelivery(a)
      return
    }
    this.sendOn(a.ws, { type: 'run:resume', runId, sequence: a.durableSequence })
    // Arm the next attempt now: the worker may resend and fail again, or never
    // answer at all, and both cases must stay bounded.
    this.scheduleExitRedrive(a)
  }

  /**
   * Give up on a terminal frame that never became durable. The worker is told
   * so it stops retrying and exits visibly non-zero rather than idling for the
   * lifetime of its task, and the run is failed through the normal path.
   */
  private abandonTerminalDelivery(a: Assignment): void {
    const runId = a.spec.runId
    if (this.runs.get(runId) !== a) return
    this.clearExitRedrive(a)
    const windowMs = this.reconnectTimeoutMs
    console.error(
      `[worker-control] Could not persist the terminal result for run ${runId} ` +
        `within ${windowMs}ms — rejecting the delivery`
    )
    if (this.isLiveSocket(a.ws)) {
      this.sendOn(a.ws, { type: 'run:reject', runId, reason: REJECT_REASON })
    }
    this.failDetachedAssignment(
      a,
      `terminal result could not be persisted within ${windowMs}ms`
    )
  }

  private clearExitRedrive(a: Assignment): void {
    if (a.exitRetryTimer) {
      clearTimeout(a.exitRetryTimer)
      a.exitRetryTimer = undefined
    }
    a.exitRetryDelayMs = undefined
    a.exitRetryDeadline = undefined
  }

  private sequenceDecision(a: Assignment, sequence: number): 'apply' | 'duplicate' | 'gap' {
    if (sequence <= a.durableSequence) return 'duplicate'
    if (sequence === a.durableSequence + 1) return 'apply'
    return 'gap'
  }

  private sendAck(ws: WebSocket | null | undefined, runId: string, sequence: number): void {
    this.sendOn(ws, { type: 'run:ack', runId, sequence })
  }

  private ackIfFinalized(
    ws: WebSocket,
    workerId: string | undefined,
    runId: string,
    sequence: number | undefined
  ): boolean {
    if (sequence === undefined || !workerId) return false
    const done = this.finalAcks.get(runId)
    if (!done || done.workerId !== workerId || sequence > done.sequence) return false
    this.sendAck(ws, runId, sequence)
    return true
  }

  private ackIfTerminalRecovery(
    ws: WebSocket,
    workerId: string | undefined,
    runId: string,
    sequence: number | undefined
  ): boolean {
    if (sequence === undefined || !workerId) return false
    const term = this.terminalRuns.get(runId)
    if (!term || term.workerId !== workerId) return false
    const prev = this.finalAcks.get(runId)?.sequence ?? term.durableSequence
    this.finalAcks.set(runId, { workerId, sequence: Math.max(prev, sequence) })
    this.sendAck(ws, runId, sequence)
    return true
  }

  private notifyRecoveryOutcome(
    recovered: RecoverRunResult,
    adopted: boolean
  ): void {
    if (!recovered || isRecoveredTerminalRun(recovered)) return
    if (adopted) recovered.onAdopted?.()
    else recovered.onAbandoned?.()
  }

  /**
   * Bind every run a reconnecting worker reported, and tell it explicitly when
   * a run cannot be bound. Without that `run:reject` the worker would keep the
   * frames spooled and retry until its delivery window expired — a guaranteed
   * stall for a run this process will never adopt.
   */
  private async adoptPendingRuns(workerId: string, ws: WebSocket, pendingRunIds: string[]): Promise<void> {
    for (const runId of pendingRunIds) {
      const outcome = await this.adoptPendingRun(workerId, ws, runId)
      if (outcome !== 'declined') continue
      console.warn(`[worker-control] Rejecting run ${runId} reported by worker ${workerId}`)
      this.sendOn(ws, { type: 'run:reject', runId, reason: REJECT_REASON })
    }
  }

  private async adoptPendingRun(
    workerId: string,
    ws: WebSocket,
    runId: string
  ): Promise<AdoptionOutcome> {
    const done = this.finalAcks.get(runId)
    if (done && done.workerId === workerId) {
      this.sendAck(ws, runId, done.sequence)
      return 'bound'
    }
    const existing = this.runs.get(runId)
    if (existing) {
      if (existing.workerId !== workerId) return 'declined'
      // Held by another live socket of the same identity: the duplicate-identity
      // guard owns that case; never tell a healthy holder to drop its run.
      if (existing.ws && existing.ws !== ws && existing.ws.readyState === WebSocket.OPEN) {
        return 'skipped'
      }
      this.rebindAssignment(existing, ws)
      return 'bound'
    }
    const recovered = await this.recoverRun?.(runId, workerId)
    if (!this.socketStillBound(workerId, ws)) {
      this.notifyRecoveryOutcome(recovered, false)
      return 'skipped'
    }
    if (!recovered || recovered.workerId !== workerId) {
      this.notifyRecoveryOutcome(recovered, false)
      return 'declined'
    }
    if (isRecoveredTerminalRun(recovered)) {
      this.installTerminalRecovery(recovered, ws)
      return 'bound'
    }
    const existingAfter = this.runs.get(runId)
    if (existingAfter) {
      if (existingAfter.workerId !== workerId) {
        this.notifyRecoveryOutcome(recovered, false)
        return 'declined'
      }
      this.rebindAssignment(existingAfter, ws)
      this.notifyRecoveryOutcome(recovered, true)
      return 'bound'
    }
    const installed = await this.installRecoveredBinding(recovered, ws)
    this.notifyRecoveryOutcome(recovered, installed)
    return installed ? 'bound' : 'skipped'
  }

  private rebindAssignment(assignment: Assignment, ws: WebSocket): void {
    this.clearReconnectTimer(assignment)
    // This resume supersedes any terminal re-drive armed for the old socket.
    this.clearExitRedrive(assignment)
    assignment.ws = ws
    this.sendOn(ws, {
      type: 'run:resume',
      runId: assignment.spec.runId,
      sequence: assignment.durableSequence,
    })
  }

  private installTerminalRecovery(recovered: RecoveredTerminalRun, ws: WebSocket): void {
    this.terminalRuns.set(recovered.runId, {
      workerId: recovered.workerId,
      durableSequence: recovered.durableSequence,
    })
    this.finalAcks.set(recovered.runId, {
      workerId: recovered.workerId,
      sequence: recovered.durableSequence,
    })
    this.sendOn(ws, {
      type: 'run:resume',
      runId: recovered.runId,
      sequence: recovered.durableSequence,
    })
  }

  private async installRecoveredBinding(binding: RecoverableRunBinding, ws: WebSocket): Promise<boolean> {
    if (!this.socketStillBound(binding.workerId, ws)) return false
    const runId = binding.runId
    // The log this process will append to is the authority for the cursor —
    // never a number handed in, which could sit above the durable prefix and
    // silently skip a frame the worker would then never resend.
    const log = await this.openDeliveryLogFor(runId)
    if (!this.socketStillBound(binding.workerId, ws)) return false
    if (this.runs.has(runId)) {
      const existing = this.runs.get(runId)
      return existing?.workerId === binding.workerId
    }
    const assignment: Assignment = {
      spec: {
        runId,
        agentId: '',
        runner: 'claude',
        prompt: '',
        env: {},
        workspace: { kind: 'ephemeral' },
      },
      sink: binding.sink,
      workerId: binding.workerId,
      ws,
      generation: this.nextAssignmentGeneration++,
      assignId: 'recovered',
      recovered: true,
      mode: 'sequenced',
      workspacePath: binding.handle.workspacePath,
      started: true,
      durableSequence: log.cursor,
      log,
      settle: () => {},
      fail: () => {},
      timeout: setTimeout(() => {}, 0),
    }
    clearTimeout(assignment.timeout)
    this.runs.set(runId, assignment)
    this.sendOn(ws, { type: 'run:resume', runId, sequence: log.cursor })
    return true
  }

  private detachOrFailRuns(workerId: string, ws: WebSocket): void {
    for (const a of [...this.runs.values()]) {
      if (a.workerId !== workerId) continue
      if (a.ws && a.ws !== ws) continue
      if (a.exitInFlight) {
        a.ws = null
        continue
      }
      if (!a.started) {
        a.fail(new Error(`Worker ${workerId} disconnected`))
        continue
      }
      if (!a.ws && a.reconnectTimer) continue
      this.clearReconnectTimer(a)
      // A pending terminal re-drive belongs to the socket that just went away;
      // the reconnect resume replaces it under the detach deadline.
      this.clearExitRedrive(a)
      a.ws = null
      this.armReconnectTimer(a)
    }
  }

  /** Arm the detach deadline for an assignment left without a live socket. */
  private armReconnectTimerIfDetached(a: Assignment): void {
    if (a.reconnectTimer) return
    if (a.ws && a.ws.readyState === WebSocket.OPEN) return
    a.ws = null
    this.armReconnectTimer(a)
  }

  private armReconnectTimer(a: Assignment): void {
    a.reconnectTimer = setTimeout(() => {
      this.failDetachedAssignment(a, `did not reconnect within ${this.reconnectTimeoutMs}ms`)
    }, this.reconnectTimeoutMs)
  }

  private failDetachedAssignment(a: Assignment, reason: string): void {
    const runId = a.spec.runId
    if (this.runs.get(runId) !== a) return
    this.clearReconnectTimer(a)
    this.clearExitRedrive(a)
    clearTimeout(a.timeout)
    this.runs.delete(runId)
    const err = new Error(`Worker ${a.workerId} ${reason}`)
    reporter.captureMessage(err.message, 'warning', {
      tags: { component: 'worker-control', workerId: a.workerId, runId },
    })
    a.sink.onEvent({
      kind: 'raw',
      stream: 'system',
      text: `[Conduit: worker ${a.workerId} ${reason} — failing this run.]`,
    })
    this.failSink(a, runId)
  }

  /**
   * Synthesize a terminal failure into a sink. `onExit` can reject (the runner
   * propagates a failed status write so a live delivery stays retryable), and on
   * these give-up paths there is nothing left to retry with — so the rejection
   * is reported rather than left to crash the process.
   */
  private failSink(a: Assignment, runId: string): void {
    void Promise.resolve()
      .then(() => a.sink.onExit('failed', null))
      .catch((err: unknown) => {
        reporter.captureException(err instanceof Error ? err : new Error(String(err)), {
          tags: {
            component: 'worker-control',
            op: 'failSink',
            workerId: a.workerId,
            runId,
          },
        })
        console.error(`[worker-control] Failed to record the failure of run ${runId}:`, err)
      })
  }

  private clearReconnectTimer(a: Assignment): void {
    if (a.reconnectTimer) {
      clearTimeout(a.reconnectTimer)
      a.reconnectTimer = undefined
    }
  }

  /** Assignment exists and was dispatched on this exact socket. */
  private ownedAssignment(runId: string, socket: WebSocket): Assignment | undefined {
    const a = this.runs.get(runId)
    if (!a || a.ws !== socket) return undefined
    return a
  }

  private hasAssignmentsOn(ws: WebSocket): boolean {
    for (const a of this.runs.values()) {
      if (a.ws === ws) return true
    }
    return false
  }

  /** True when any claimed run id is currently assigned to this workerId. */
  private claimsIntersectWorkerAssignments(workerId: string, claimed: string[]): boolean {
    if (claimed.length === 0) return false
    const assigned = new Set<string>()
    for (const a of this.runs.values()) {
      if (a.workerId === workerId) assigned.add(a.spec.runId)
    }
    for (const id of claimed) {
      if (assigned.has(id)) return true
    }
    return false
  }

  /**
   * Ping the peer and wait briefly for a pong. Half-open TCP leaves readyState
   * OPEN but never answers; live Node `ws` clients auto-pong.
   */
  private probeSocketAlive(ws: WebSocket): Promise<boolean> {
    if (ws.readyState !== WebSocket.OPEN) return Promise.resolve(false)
    return new Promise((resolve) => {
      let settled = false
      const finish = (alive: boolean): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        ws.off('pong', onPong)
        resolve(alive)
      }
      const onPong = (): void => finish(true)
      const timer = setTimeout(() => finish(false), this.socketProbeTimeoutMs)
      ws.once('pong', onPong)
      try {
        ws.ping()
      } catch {
        finish(false)
      }
    })
  }

  /**
   * Bind a reconnecting socket over a dead/half-open peer that still owns this
   * workerId's assignments. Updates the registry before tearing down the old
   * socket so its `close` handler does not detach or fail the runs.
   */
  private seizeWorkerSocket(workerId: string, oldWs: WebSocket, newWs: WebSocket): void {
    for (const a of this.runs.values()) {
      if (a.workerId !== workerId) continue
      this.clearReconnectTimer(a)
      a.ws = newWs
    }
    const worker = this.workers.get(workerId)
    if (worker && worker.ws === oldWs) {
      worker.ws = newWs
      worker.lastHeartbeat = Date.now()
    }
    try {
      // terminate: a half-open peer may never complete a clean close handshake.
      oldWs.terminate()
    } catch {
      // already destroyed
    }
  }

  /** True when a prior attempt on this socket timed out (different generation). */
  private hasStaleSuppression(runId: string, ws: WebSocket, generation: number): boolean {
    for (const entry of this.ignoreNextStarted) {
      if (entry.runId === runId && entry.ws === ws && entry.generation !== generation) return true
    }
    return false
  }

  /** True when this frame belongs to a timed-out assignment generation on this socket. */
  private consumeIgnoredStarted(runId: string, ws: WebSocket, generation?: number): boolean {
    for (const entry of this.ignoreNextStarted) {
      if (entry.runId === runId && entry.ws === ws && entry.generation === generation) {
        this.ignoreNextStarted.delete(entry)
        return true
      }
    }
    return false
  }

  /** Lease enforcement: a worker silent for longer than the lease is dead. */
  private checkLeases(): void {
    const now = Date.now()
    for (const w of [...this.workers.values()]) {
      if (now - w.lastHeartbeat > this.leaseMs) {
        this.workers.delete(w.workerId)
        try {
          w.ws.close(4001, 'lease expired')
        } catch {
          // already closing
        }
        console.warn(`[worker-control] Worker lease expired: ${w.workerId}`)
        this.failRunsOfWorker(w.workerId, 'lost contact (lease expired)', { ws: w.ws })
      }
    }
  }

  /**
   * Synthesize failures for every run a dead worker was executing so the
   * orchestrator finalizes them (log, broadcast, publish, cleanup) instead of
   * leaving them "running" forever. Pending assignments reject instead.
   */
  private failRunsOfWorker(
    workerId: string,
    reason: string,
    opts: { systemEvent?: boolean; ws?: WebSocket } = {}
  ): void {
    const systemEvent = opts.systemEvent !== false
    for (const [runId, a] of [...this.runs.entries()]) {
      if (a.workerId !== workerId) continue
      if (opts.ws && a.ws !== opts.ws) continue
      if (a.exitInFlight) continue
      const err = new Error(`Worker ${workerId} ${reason}`)
      reporter.captureMessage(err.message, 'warning', {
        tags: { component: 'worker-control', workerId, runId },
      })
      this.clearReconnectTimer(a)
      this.clearExitRedrive(a)
      if (!a.started) {
        a.fail(err)
      } else {
        clearTimeout(a.timeout)
        this.runs.delete(runId)
        if (systemEvent) {
          a.sink.onEvent({
            kind: 'raw',
            stream: 'system',
            text: `[Conduit: worker ${workerId} ${reason} — failing this run.]`,
          })
        }
        this.failSink(a, runId)
      }
    }
  }

  /**
   * Server shutdown. Runs not yet started fail. Started runs are left
   * `running` in the database without touching their sinks: their workers
   * reconnect to the replacement server, which adopts them from the durable
   * cursor (or fails them once the reconnect window lapses).
   */
  stop(): void {
    clearInterval(this.leaseTimer)
    for (const waiter of [...this.waiters.values()]) {
      waiter.reject(new Error('Worker control plane is shutting down'))
    }
    this.waiters.clear()
    for (const a of [...this.runs.values()]) {
      this.clearReconnectTimer(a)
      this.clearExitRedrive(a)
      if (a.exitInFlight) continue
      if (!a.started) {
        a.fail(new Error('Worker control plane is shutting down'))
      } else {
        clearTimeout(a.timeout)
        this.runs.delete(a.spec.runId)
        console.log(
          `[worker-control] Leaving run ${a.spec.runId} on worker ${a.workerId} for the replacement server`
        )
      }
    }
    for (const w of this.workers.values()) {
      try {
        w.ws.close(1001, 'server shutting down')
      } catch {
        // best-effort
      }
    }
    this.workers.clear()
    this.ignoreNextStarted.clear()
    this.finalAcks.clear()
    this.terminalRuns.clear()
  }
}

function rawMessageBytes(data: Buffer | ArrayBuffer | Buffer[] | string): number {
  if (typeof data === 'string') return Buffer.byteLength(data)
  if (Buffer.isBuffer(data)) return data.length
  if (Array.isArray(data)) return data.reduce((n, chunk) => n + chunk.length, 0)
  return data.byteLength
}

let controlPlane: WorkerControlPlane | null = null

/** Process-wide control plane, created lazily so importing modules at startup
 *  doesn't open the endpoint before the upgrade handler is wired. Pass options
 *  on the first call (recoverRun must be installed before worker upgrades). */
export function getWorkerControlPlane(options?: WorkerControlPlaneOptions): WorkerControlPlane {
  if (!controlPlane) controlPlane = new WorkerControlPlane(options)
  return controlPlane
}

/** The singleton if it has already been constructed; never creates one. */
export function peekWorkerControlPlane(): WorkerControlPlane | null {
  return controlPlane
}

/** Best-effort teardown of the process-wide plane (no-op if never created). */
export function stopWorkerControlPlane(): void {
  controlPlane?.stop()
}
