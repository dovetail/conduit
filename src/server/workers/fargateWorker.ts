/**
 * Fargate worker factory: one ECS task per run. Selected with
 * CONDUIT_WORKER_FACTORY=fargate.
 *
 * Each run launches the conduit-worker task definition with container env
 * overrides (CONDUIT_WORKER_ID=fargate-<runId>, CONDUIT_SERVER_URL). The task
 * connects back to this server's /ws/worker control plane and the factory
 * dispatches the RunSpec to that exact worker via assignTo. When the run exits
 * (or is cancelled/fails) the task is stopped and DescribeTasks confirms
 * STOPPED. Factory shutdown stops every in-flight task the same way.
 * A StopTask that ECS has accepted (desiredStatus STOPPED, or lastStatus
 * DEACTIVATING / STOPPING / DEPROVISIONING) is not a failure: Fargate's
 * default stopTimeout is 30s of SIGTERM before SIGKILL, and ENI teardown
 * after that routinely takes minutes. Those tasks are polled until STOPPED
 * or a deprovision budget. Exhausting the budget is still not a StopTask
 * failure — the task is already stopping — so Conduit drops the ARN and
 * warns once instead of paging or retrying StopTask. A task that stays
 * RUNNING (stop never accepted) is retried, then reported once.
 *
 * CONDUIT_WORKER_TOKEN: prefer baking it into the task definition as a
 * Secrets Manager secret (task def `secrets`), so it never appears in
 * DescribeTask output. CONDUIT_FARGATE_WORKER_TOKEN is available as a plain
 * env override for dev, but leaks into the ECS API — do not use in production.
 *
 * Worker process mode is also a task-definition concern, not a RunTask
 * override: the shared image defaults to CONDUIT_PROCESS_MODE=server, so the
 * worker task def must set CONDUIT_PROCESS_MODE=worker and
 * CONDUIT_WORKER_ONE_SHOT=true. Overrides stay limited to server URL, worker
 * id, and the optional dev token so they match the Fargate contracts.
 *
 * Required env: CONDUIT_FARGATE_CLUSTER, CONDUIT_FARGATE_TASK_DEFINITION,
 * CONDUIT_FARGATE_SUBNETS (comma-separated), CONDUIT_SERVER_URL (or
 * CONDUIT_BASE_URL). AWS credentials/region come from the standard SDK chain
 * (env, shared config, instance/pod role). Optional CONDUIT_FARGATE_ROLE_ARN
 * is assumed via STS for ECS API calls.
 * Optional env: CONDUIT_FARGATE_CONTAINER_NAME (default "worker"),
 * CONDUIT_FARGATE_SECURITY_GROUPS (comma-separated),
 * CONDUIT_FARGATE_ASSIGN_PUBLIC_IP (default "ENABLED" — needed for the task to
 * reach the internet without NAT), CONDUIT_FARGATE_PLATFORM_VERSION,
 * CONDUIT_WORKER_CONNECT_TIMEOUT_MS (default 600000),
 * CONDUIT_WORKER_ASSIGN_TIMEOUT_MS (default 120000).
 *
 * E2E-only: CONDUIT_FARGATE_E2E_FAKE_ECS may point at a module under e2e/
 * that exports createFakeEcsClient(). Requires CONDUIT_E2E=1 and is forbidden
 * when NODE_ENV=production.
 */
import {
  DescribeTasksCommand,
  ECSClient,
  RunTaskCommand,
  StopTaskCommand,
  type ECSClientConfig,
  type RunTaskCommandInput,
  type Task,
} from '@aws-sdk/client-ecs'
import { createRequire } from 'node:module'
import * as path from 'node:path'
import { fromTemporaryCredentials } from '@aws-sdk/credential-providers'
import type { RunSpec, WorkerEventSink, WorkerFactory, WorkerHandle } from '../../shared/worker'
import type { WorkerControlPlane } from '../workerControl'
import { resolveAssignTimeoutMs, resolveConnectTimeoutMs } from '../workerControl'
import { resolveWorkerServerUrl } from './cloudConfig'
import { reporter } from '../observability'

/** Default Fargate allocation: 2 vCPU / 8 GiB. A run can raise memory up to 16 GiB. */
export const FARGATE_WORKER_CPU = '2048'
export const FARGATE_WORKER_MEMORY_MIB = '8192'

/** Memory range Fargate allows at 2 vCPU, in MiB. */
const FARGATE_MEMORY_MIN_MIB = 4096
const FARGATE_MEMORY_MAX_MIB = 16384
const FARGATE_MEMORY_STEP_MIB = 1024

/**
 * Task cpu/memory for a run. An unset override keeps the 8 GiB default. A set
 * override must be a size Fargate accepts at 2 vCPU, so RunTask fails here
 * with a clear reason instead of an ECS rejection.
 */
export function resolveFargateTaskSize(memoryMib?: number): { cpu: string; memory: string } {
  if (memoryMib == null) return { cpu: FARGATE_WORKER_CPU, memory: FARGATE_WORKER_MEMORY_MIB }
  if (
    !Number.isInteger(memoryMib) ||
    memoryMib < FARGATE_MEMORY_MIN_MIB ||
    memoryMib > FARGATE_MEMORY_MAX_MIB ||
    memoryMib % FARGATE_MEMORY_STEP_MIB !== 0
  ) {
    throw new Error(
      `Fargate worker memory must be ${FARGATE_MEMORY_MIN_MIB}–${FARGATE_MEMORY_MAX_MIB} MiB ` +
        `in steps of ${FARGATE_MEMORY_STEP_MIB} at 2 vCPU (got ${memoryMib}).`
    )
  }
  return { cpu: FARGATE_WORKER_CPU, memory: String(memoryMib) }
}

/** Fargate default container stopTimeout: SIGTERM, then SIGKILL after 30s. */
export const FARGATE_DEFAULT_STOP_TIMEOUT_MS = 30_000
/**
 * How long a StopTask may leave desiredStatus RUNNING before it is retried.
 * Must exceed {@link FARGATE_DEFAULT_STOP_TIMEOUT_MS}; DEACTIVATING is not STOPPED.
 */
export const STOP_VERIFY_TIMEOUT_MS = 60_000
/**
 * How long to keep polling after ECS has accepted the stop. Production tasks
 * sit in DEPROVISIONING for many minutes while the ENI detaches; a 60s cap
 * false-failed every one of those and retried StopTask in a loop.
 */
export const STOP_DEPROVISION_TIMEOUT_MS = 10 * 60 * 1000
/** lastStatus values that mean StopTask has taken effect but the task is not STOPPED yet. */
export const FARGATE_STOP_IN_PROGRESS = new Set(['DEACTIVATING', 'STOPPING', 'DEPROVISIONING'])
const STOP_ATTEMPTS = 3
const STOP_BACKOFF_MS = 50
const UNCLEAN_RETRY_MS = 30_000
const SHUTDOWN_DEADLINE_MS = 8_000
const WATCH_INITIAL_DELAY_MS = 25
const BACKOFF_CAP_MS = 2_000

/** Test-visible stop/verify policy. Production uses the constants above. */
export interface FargateStopPolicy {
  stopAttempts?: number
  stopVerifyTimeoutMs?: number
  /** Budget once ECS has accepted the stop. Defaults to {@link STOP_DEPROVISION_TIMEOUT_MS}. */
  stopDeprovisionTimeoutMs?: number
  stopBackoffMs?: number
  /** 0 disables the periodic unclean-task retry timer. */
  uncleanRetryMs?: number
  shutdownDeadlineMs?: number
}

export interface TaskStopSnapshot {
  lastStatus?: string
  desiredStatus?: string
  stoppedReason?: string
}

export type StopWaitVerdict = 'continue' | 'stopped' | 'not-accepted' | 'deprovision-stuck'

/**
 * Decide whether a DescribeTasks sample means the stop is done, still in
 * progress, or never accepted. `elapsedMs` is measured from the start of
 * this wait, not from the original RunTask.
 */
export function stopWaitVerdict(
  task: TaskStopSnapshot | undefined,
  elapsedMs: number,
  stopVerifyTimeoutMs: number,
  deprovisionTimeoutMs: number
): StopWaitVerdict {
  if (!task || task.lastStatus === 'STOPPED') return 'stopped'
  const accepted =
    task.desiredStatus === 'STOPPED' ||
    (typeof task.lastStatus === 'string' && FARGATE_STOP_IN_PROGRESS.has(task.lastStatus))
  if (accepted) {
    return elapsedMs >= deprovisionTimeoutMs ? 'deprovision-stuck' : 'continue'
  }
  return elapsedMs >= stopVerifyTimeoutMs ? 'not-accepted' : 'continue'
}

/**
 * Why a stopped task's containers exited — ECS's own `stoppedReason` is often
 * just "Essential container in task exited", with the exit code (137 = killed,
 * usually out of memory) and the container reason only on the container itself.
 * Returns '' when ECS recorded nothing useful.
 */
export function describeStoppedContainers(
  task: { containers?: Array<{ name?: string; exitCode?: number; reason?: string }>; stopCode?: string } | undefined
): string {
  const parts: string[] = []
  for (const c of task?.containers ?? []) {
    if (c.exitCode === undefined && !c.reason) continue
    const exit = c.exitCode === undefined ? '' : ` exited ${c.exitCode}`
    const why = c.reason?.trim() ? `${exit ? ':' : ''} ${c.reason.trim()}` : ''
    parts.push(`container ${c.name ?? 'unknown'}${exit}${why}`)
  }
  if (task?.stopCode) parts.push(`stop code ${task.stopCode}`)
  return parts.join('; ')
}

function formatTaskStatus(task: TaskStopSnapshot | undefined): string {
  if (!task) return 'missing'
  const last = task.lastStatus ?? 'unknown'
  const desired = task.desiredStatus ?? 'unknown'
  const reason = task.stoppedReason?.trim()
  return reason ? `${last} (desired ${desired}, ${reason})` : `${last} (desired ${desired})`
}

export interface FargateWorkerConfig {
  cluster: string
  taskDefinition: string
  containerName: string
  subnets: string[]
  securityGroups: string[]
  assignPublicIp: 'ENABLED' | 'DISABLED'
  platformVersion?: string
  serverUrl: string
  workerToken?: string
  connectTimeoutMs: number
  assignTimeoutMs?: number
  roleArn?: string
}

/** ECS client config: default SDK chain, or STS assume-role when roleArn is set. */
export function buildFargateEcsClientConfig(config: FargateWorkerConfig): ECSClientConfig {
  if (!config.roleArn) return {}
  return {
    credentials: fromTemporaryCredentials({
      params: {
        RoleArn: config.roleArn,
        RoleSessionName: 'conduit-fargate-launcher',
      },
    }),
  }
}

export function resolveFargateConfig(env: NodeJS.ProcessEnv = process.env): FargateWorkerConfig {
  const missing: string[] = []
  const cluster = env.CONDUIT_FARGATE_CLUSTER?.trim()
  const taskDefinition = env.CONDUIT_FARGATE_TASK_DEFINITION?.trim()
  const subnets = (env.CONDUIT_FARGATE_SUBNETS ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  if (!cluster) missing.push('CONDUIT_FARGATE_CLUSTER')
  if (!taskDefinition) missing.push('CONDUIT_FARGATE_TASK_DEFINITION')
  if (subnets.length === 0) missing.push('CONDUIT_FARGATE_SUBNETS')
  if (missing.length > 0) {
    throw new Error(`${missing.join(', ')} required when CONDUIT_WORKER_FACTORY=fargate`)
  }
  const publicIp = env.CONDUIT_FARGATE_ASSIGN_PUBLIC_IP?.trim().toUpperCase()
  return {
    cluster: cluster!,
    taskDefinition: taskDefinition!,
    containerName: env.CONDUIT_FARGATE_CONTAINER_NAME?.trim() || 'worker',
    subnets,
    securityGroups: (env.CONDUIT_FARGATE_SECURITY_GROUPS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    assignPublicIp: publicIp === 'DISABLED' ? 'DISABLED' : 'ENABLED',
    platformVersion: env.CONDUIT_FARGATE_PLATFORM_VERSION?.trim() || undefined,
    serverUrl: resolveWorkerServerUrl(env),
    workerToken: env.CONDUIT_FARGATE_WORKER_TOKEN?.trim() || undefined,
    connectTimeoutMs: resolveConnectTimeoutMs(env),
    assignTimeoutMs: resolveAssignTimeoutMs(env),
    roleArn: env.CONDUIT_FARGATE_ROLE_ARN?.trim() || undefined,
  }
}

/** Pure RunTask payload: startedBy, tags, 2 vCPU and the run's memory, no secrets by default. */
export function buildFargateRunTaskInput(config: FargateWorkerConfig, spec: RunSpec): RunTaskCommandInput {
  const size = resolveFargateTaskSize(spec.workerMemoryMib)
  const workerId = `fargate-${spec.runId}`
  const environment = [
    { name: 'CONDUIT_SERVER_URL', value: config.serverUrl },
    { name: 'CONDUIT_WORKER_ID', value: workerId },
    ...(config.workerToken ? [{ name: 'CONDUIT_WORKER_TOKEN', value: config.workerToken }] : []),
  ]
  return {
    cluster: config.cluster,
    taskDefinition: config.taskDefinition,
    launchType: 'FARGATE',
    startedBy: 'conduit',
    platformVersion: config.platformVersion,
    networkConfiguration: {
      awsvpcConfiguration: {
        subnets: config.subnets,
        securityGroups: config.securityGroups.length > 0 ? config.securityGroups : undefined,
        assignPublicIp: config.assignPublicIp,
      },
    },
    overrides: {
      cpu: size.cpu,
      memory: size.memory,
      containerOverrides: [{ name: config.containerName, environment }],
    },
    tags: [
      { key: 'conduit:run-id', value: spec.runId },
      { key: 'conduit:agent-id', value: spec.agentId },
      { key: 'managed-by', value: 'conduit' },
    ],
  }
}

export class FargateWorkerFactory implements WorkerFactory {
  readonly kind = 'fargate'
  private readonly ecs: ECSClient
  /** In-flight runId → task ARN. Removed after STOPPED / not-found / accepted deprovision. */
  private readonly active = new Map<string, string>()
  /** Runs whose worker has started execution; shutdown leaves these tasks running. */
  private readonly started = new Set<string>()
  /** In-flight stop+verify promises, keyed by task ARN (idempotent). */
  private readonly stopping = new Map<string, Promise<void>>()
  private readonly stopAttempts: number
  private readonly stopVerifyTimeoutMs: number
  private readonly stopDeprovisionTimeoutMs: number
  private readonly stopBackoffMs: number
  private readonly uncleanRetryMs: number
  private readonly shutdownDeadlineMs: number
  /** Tasks whose last stop attempt failed; retried by the periodic timer. */
  private readonly failedStops = new Map<string, { taskArn: string; reason: string }>()
  /** Task ARNs already reported to Sentry, so unclean retries do not page again. */
  private readonly reportedStopFailures = new Set<string>()
  /** Set while shutdown is in progress so a long deprovision wait cannot outlive it. */
  private shutdownDeadlineAt?: number
  private uncleanTimer?: NodeJS.Timeout

  constructor(
    private controlPlane: WorkerControlPlane,
    private config: FargateWorkerConfig,
    ecs?: ECSClient,
    stopPolicy?: FargateStopPolicy
  ) {
    this.ecs = ecs ?? tryLoadE2eFakeEcsClient() ?? new ECSClient(buildFargateEcsClientConfig(config))
    this.stopAttempts = stopPolicy?.stopAttempts ?? STOP_ATTEMPTS
    this.stopVerifyTimeoutMs = stopPolicy?.stopVerifyTimeoutMs ?? STOP_VERIFY_TIMEOUT_MS
    this.stopDeprovisionTimeoutMs = stopPolicy?.stopDeprovisionTimeoutMs ?? STOP_DEPROVISION_TIMEOUT_MS
    this.stopBackoffMs = stopPolicy?.stopBackoffMs ?? STOP_BACKOFF_MS
    this.uncleanRetryMs = stopPolicy?.uncleanRetryMs ?? UNCLEAN_RETRY_MS
    this.shutdownDeadlineMs = stopPolicy?.shutdownDeadlineMs ?? SHUTDOWN_DEADLINE_MS
    if (this.uncleanRetryMs > 0) {
      this.uncleanTimer = setInterval(() => this.retryFailedStops(), this.uncleanRetryMs)
      this.uncleanTimer.unref()
    }
  }

  async startRun(spec: RunSpec, sink: WorkerEventSink): Promise<WorkerHandle> {
    const { runId } = spec
    const workerId = `fargate-${runId}`

    let taskArn: string
    try {
      const out = await this.ecs.send(new RunTaskCommand(buildFargateRunTaskInput(this.config, spec)))
      const failures = out.failures ?? []
      const arn = out.tasks?.[0]?.taskArn
      if (!arn) {
        throw new Error(
          failures.length > 0
            ? failures.map((f) => `${f.arn ?? 'task'}: ${f.reason ?? 'unknown'}`).join('; ')
            : 'RunTask returned no task'
        )
      }
      taskArn = arn
    } catch (err) {
      throw new Error(
        `Failed to start Fargate task for run ${runId}: ` +
          (err instanceof Error ? err.message : String(err)),
        { cause: err }
      )
    }

    this.active.set(runId, taskArn)

    const wrappedSink: WorkerEventSink = {
      onEvent: (ev) => sink.onEvent(ev),
      onDurableEvent: sink.onDurableEvent ? (ev) => sink.onDurableEvent!(ev) : undefined,
      onError: (err) => sink.onError?.(err),
      onExit: (status, exitCode) => {
        const result = sink.onExit(status, exitCode)
        void this.stopTask(taskArn, runId, `run exited (${status})`).catch(() => {})
        return result
      },
    }

    try {
      const handle = await this.assignWhenConnected(workerId, spec, wrappedSink, taskArn, runId)
      if (this.active.has(runId) && !this.stopping.has(taskArn)) this.started.add(runId)
      return {
        ...handle,
        cancel: async () => {
          await handle.cancel()
          await this.stopTask(taskArn, runId, 'run cancelled')
        },
      }
    } catch (err) {
      try {
        await this.stopTask(taskArn, runId, 'assignment failed')
      } catch (stopErr) {
        console.error(`[workers/fargate] Stop after assignment failure also failed (run ${runId}):`, stopErr)
      }
      throw err
    }
  }

  /**
   * Wait for assignTo, but fail fast if the task dies before the worker dials in
   * (image pull errors, capacity, crash-loop). Watcher yields first so a
   * promptly-settling assignTo wins without an extra DescribeTasks.
   */
  private async assignWhenConnected(
    workerId: string,
    spec: RunSpec,
    sink: WorkerEventSink,
    taskArn: string,
    runId: string
  ): Promise<WorkerHandle> {
    let settled = false
    const assign = this.controlPlane
      .assignTo(workerId, spec, sink, this.config.connectTimeoutMs)
      .finally(() => {
        settled = true
      })
    // Race losers must not become unhandled rejections when the watcher wins
    // and cancelAssignTo rejects this promise.
    void assign.catch(() => {})

    const watch = (async () => {
      let delay = WATCH_INITIAL_DELAY_MS
      while (!settled) {
        await sleep(delay)
        if (settled) break
        let task: Task | undefined
        try {
          task = await this.describeTask(taskArn)
        } catch (err) {
          if (settled) break
          console.error(`[workers/fargate] DescribeTasks failed for ${taskArn} (run ${runId}):`, err)
          reporter.captureException(err, {
            tags: { component: 'workers/fargate', op: 'watchTask', runId },
          })
          delay = Math.min(delay * 2, BACKOFF_CAP_MS)
          continue
        }
        if (settled) break
        if (task?.lastStatus === 'STOPPED') {
          const reason = task.stoppedReason?.trim() || 'STOPPED'
          const detail = describeStoppedContainers(task)
          throw new Error(
            `Fargate task for run ${runId} stopped before the worker connected: ${reason}` +
              (detail ? ` (${detail})` : '')
          )
        }
        delay = Math.min(delay * 2, BACKOFF_CAP_MS)
      }
      return new Promise<WorkerHandle>(() => {})
    })()

    try {
      return await Promise.race([assign, watch])
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err))
      this.controlPlane.cancelAssignTo(workerId, error)
      throw error
    }
  }

  private async describeTask(taskArn: string): Promise<Task | undefined> {
    const out = await this.ecs.send(
      new DescribeTasksCommand({
        cluster: this.config.cluster,
        tasks: [taskArn],
      })
    )
    return out.tasks?.[0]
  }

  private async stopTask(taskArn: string, runId: string, reason: string): Promise<void> {
    this.started.delete(runId)
    const existing = this.stopping.get(taskArn)
    if (existing) return existing

    const work = this.stopTaskWithRetry(taskArn, runId, reason).finally(() => {
      this.stopping.delete(taskArn)
    })
    this.stopping.set(taskArn, work)
    return work
  }

  private async stopTaskWithRetry(taskArn: string, runId: string, reason: string): Promise<void> {
    let delay = this.stopBackoffMs
    let lastError: unknown
    let lastTask: Task | undefined
    let attemptsUsed = 0
    let interrupted = false
    for (let attempt = 1; attempt <= this.stopAttempts; attempt++) {
      attemptsUsed = attempt
      if (this.shutdownDeadlineAt !== undefined && Date.now() >= this.shutdownDeadlineAt) {
        interrupted = true
        lastError = new Error(`Stopping task ${taskArn} interrupted by shutdown`)
        break
      }
      try {
        await this.ecs.send(
          new StopTaskCommand({
            cluster: this.config.cluster,
            task: taskArn,
            reason: `Conduit run ${runId}: ${reason}`.slice(0, 255),
          })
        )
      } catch (err) {
        if (isTaskGone(err)) {
          this.forgetStopped(runId, taskArn)
          return
        }
        lastError = err
        console.error(
          `[workers/fargate] Failed to stop task ${taskArn} (run ${runId}, attempt ${attempt}/${this.stopAttempts}):`,
          err
        )
        reporter.captureException(err, {
          tags: { component: 'workers/fargate', op: 'stopTask', runId },
          extra: { taskArn, attempt, stopAttempts: this.stopAttempts },
        })
        if (attempt < this.stopAttempts) {
          await sleep(delay)
          delay = Math.min(delay * 2, BACKOFF_CAP_MS)
        }
        continue
      }

      const wait = await this.waitUntilStopped(taskArn, runId)
      lastTask = wait.task
      if (wait.verdict === 'stopped') {
        this.forgetStopped(runId, taskArn)
        return
      }
      if (wait.verdict === 'interrupted') {
        interrupted = true
        lastError = new Error(`Stopping task ${taskArn} interrupted by shutdown`)
        break
      }
      // ECS already accepted the stop; ENI teardown can outlast the budget.
      // Drop the ARN — another StopTask will not hurry DEPROVISIONING — and
      // do not treat this as a stop failure for Sentry or failedStops retry.
      if (wait.verdict === 'deprovision-stuck') {
        const status = formatTaskStatus(wait.task)
        console.warn(
          `[workers/fargate] Task ${taskArn} (run ${runId}) still ${status} after ` +
            `deprovision budget; stop was accepted — forgetting ARN without retry`
        )
        this.forgetStopped(runId, taskArn)
        return
      }
      const status = formatTaskStatus(wait.task)
      lastError = new Error(`Task ${taskArn} did not reach STOPPED (${status})`)
      if (attempt < this.stopAttempts) {
        await sleep(delay)
        delay = Math.min(delay * 2, BACKOFF_CAP_MS)
      }
    }

    const status = formatTaskStatus(lastTask)
    const message =
      `[workers/fargate] Giving up stopping task ${taskArn} (run ${runId}) after ` +
      `${attemptsUsed} attempt(s); last status ${status}; remaining tracked for later retry`
    if (!interrupted) {
      console.error(message, lastError)
      if (!this.reportedStopFailures.has(taskArn)) {
        this.reportedStopFailures.add(taskArn)
        reporter.captureMessage(message, 'error', {
          tags: { component: 'workers/fargate', op: 'stopTask', runId },
          extra: {
            taskArn,
            attempts: attemptsUsed,
            lastStatus: lastTask?.lastStatus,
            desiredStatus: lastTask?.desiredStatus,
            stoppedReason: lastTask?.stoppedReason,
          },
        })
      }
    }
    this.failedStops.set(runId, { taskArn, reason })
    throw lastError instanceof Error
      ? lastError
      : new Error(`Failed to stop Fargate task ${taskArn} for run ${runId}`)
  }

  private forgetStopped(runId: string, taskArn: string): void {
    this.active.delete(runId)
    this.started.delete(runId)
    this.failedStops.delete(runId)
    this.reportedStopFailures.delete(taskArn)
  }

  private retryFailedStops(): void {
    for (const [runId, { taskArn, reason }] of [...this.failedStops]) {
      if (this.stopping.has(taskArn)) continue
      void this.stopTask(taskArn, runId, reason).catch(() => {})
    }
  }

  private async waitUntilStopped(
    taskArn: string,
    runId: string
  ): Promise<{ verdict: Exclude<StopWaitVerdict, 'continue'> | 'interrupted'; task?: Task }> {
    let delay = 50
    const startedAt = Date.now()
    let lastTask: Task | undefined
    for (;;) {
      if (this.shutdownDeadlineAt !== undefined && Date.now() >= this.shutdownDeadlineAt) {
        return { verdict: 'interrupted', task: lastTask }
      }
      try {
        const task = await this.describeTask(taskArn)
        lastTask = task
        const verdict = stopWaitVerdict(
          task,
          Date.now() - startedAt,
          this.stopVerifyTimeoutMs,
          this.stopDeprovisionTimeoutMs
        )
        if (verdict !== 'continue') return { verdict, task }
      } catch (err) {
        if (isTaskGone(err)) return { verdict: 'stopped' }
        console.error(`[workers/fargate] Failed to describe task ${taskArn} (run ${runId}):`, err)
        reporter.captureException(err, {
          tags: { component: 'workers/fargate', op: 'describeTask', runId },
        })
        const elapsed = Date.now() - startedAt
        if (lastTask) {
          const prior = stopWaitVerdict(
            lastTask,
            elapsed,
            this.stopVerifyTimeoutMs,
            this.stopDeprovisionTimeoutMs
          )
          if (prior !== 'continue') return { verdict: prior, task: lastTask }
        } else if (elapsed >= this.stopVerifyTimeoutMs) {
          return { verdict: 'not-accepted', task: lastTask }
        }
      }
      await sleep(delay)
      delay = Math.min(delay * 2, BACKOFF_CAP_MS)
    }
  }

  /**
   * Stop tasks whose worker never started its run. Tasks already executing
   * keep running: the worker reconnects to the replacement server, which
   * adopts the run, and the task exits on its own once the run is delivered.
   */
  async shutdown(): Promise<void> {
    if (this.uncleanTimer) {
      clearInterval(this.uncleanTimer)
      this.uncleanTimer = undefined
    }
    const deadline = Date.now() + this.shutdownDeadlineMs
    this.shutdownDeadlineAt = deadline
    const unstarted = () => [...this.active.entries()].filter(([runId]) => !this.started.has(runId))
    while (unstarted().length > 0) {
      await Promise.allSettled(
        unstarted().map(([runId, taskArn]) => this.stopTask(taskArn, runId, 'factory shutdown'))
      )
      const remaining = unstarted().length
      if (remaining === 0) return
      if (Date.now() >= deadline) {
        throw new Error(`Failed to stop ${remaining} Fargate task(s) before shutdown deadline`)
      }
      await sleep(this.stopBackoffMs)
    }
  }
}

/** True for CONDUIT_E2E=1/true/yes (whitespace/case-tolerant). */
export function isConduitE2eEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.CONDUIT_E2E?.trim().toLowerCase()
  return raw === '1' || raw === 'true' || raw === 'yes'
}

/** Allowlist: resolved module path must sit under <cwd>/e2e/. */
export function isAllowlistedE2eModule(resolved: string, cwd: string = process.cwd()): boolean {
  const e2eRoot = path.resolve(cwd, 'e2e')
  const rel = path.relative(e2eRoot, path.resolve(resolved))
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

/**
 * E2E-only hook: load a duck-typed ECS client from CONDUIT_FARGATE_E2E_FAKE_ECS.
 * Refuses NODE_ENV=production, requires CONDUIT_E2E=1, and allowlists e2e/.
 */
export function tryLoadE2eFakeEcsClient(env: NodeJS.ProcessEnv = process.env): ECSClient | undefined {
  const spec = env.CONDUIT_FARGATE_E2E_FAKE_ECS?.trim()
  if (!spec) return undefined
  if (env.NODE_ENV === 'production') {
    throw new Error('CONDUIT_FARGATE_E2E_FAKE_ECS is forbidden when NODE_ENV=production')
  }
  if (!isConduitE2eEnabled(env)) {
    throw new Error('CONDUIT_FARGATE_E2E_FAKE_ECS requires CONDUIT_E2E=1')
  }
  const resolved = path.isAbsolute(spec) ? spec : path.resolve(spec)
  if (!isAllowlistedE2eModule(resolved)) {
    throw new Error(`CONDUIT_FARGATE_E2E_FAKE_ECS must resolve under e2e/ (got ${resolved})`)
  }
  const req = createRequire(path.join(process.cwd(), 'package.json'))
  const loaded = req(resolved) as { createFakeEcsClient?: () => ECSClient }
  const client = typeof loaded.createFakeEcsClient === 'function' ? loaded.createFakeEcsClient() : loaded
  if (!client || typeof (client as { send?: unknown }).send !== 'function') {
    throw new Error(
      `CONDUIT_FARGATE_E2E_FAKE_ECS module must export createFakeEcsClient() or a client with send() (${resolved})`
    )
  }
  console.warn(`[workers/fargate] e2e fake ECS loaded from ${resolved}`)
  return client as ECSClient
}

function isTaskGone(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return /not found|does not exist|unknown task/i.test(msg)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
