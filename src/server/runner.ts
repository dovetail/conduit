import * as fs from 'fs'
import * as path from 'path'
import type { ExecutionRun, RunEvent, TriggerContext, RunnerType, Repository } from '../shared/types'
import type { RunSpec, WorkspaceSpec, WorkerEventSink, WorkerHandle } from '../shared/worker'
import { summarizeEvent } from '../shared/runEvents'
import { createRun, updateRun, updateRunIfRunning, getRunningRunForAgent } from '../main/db/queries/runs'
import { getAgent } from '../main/db/queries/agents'
import { getRepository } from '../main/db/queries/repositories'
import { getCredentialValue } from '../main/db/queries/agentCredentials'
import { getRunnerTimeout } from '../main/db/queries/runnerSettings'
import { resolveBgTaskTimeoutSeconds, bgTaskTimeoutEnvEntry } from './runnerTimeout'
import { deleteWorkspace } from '../main/execution/workspace'
import {
  buildRunMcpConfig,
  deleteMcpConfig,
  resolveRunMcpAuth,
  RUN_MCP_REFRESH_INTERVAL_MS,
  type RunMcpOAuthServer,
} from '../main/utils/mcp'
import { deleteClaudeConfig } from '../main/utils/claudeConfig'
import { DEV_USER_ID } from './auth/config'
import { LOGS_DIR } from '../main/utils/paths'
import { removeWorktree } from './gitOps'
import { buildRunFailureReport, failedStartLastLine, isDerivedWorkerControlFailure } from './runFailure'
import { resolvePushCredential } from './githubApp'
import { repoCliEnvEntries, resolveRepoAuthSafe } from './repoAuth'
import { publishRunResult } from './publisher'
import { buildTriggeredPrompt } from './triggers/promptBuilder'
import { createRunEventHandlers } from './runEventSink'
import { resolveRunLogMaxBytes } from './runDeliveryLog'
import { reporter } from './observability'
import { getWorkerFactory } from './workers'

/**
 * Run orchestrator. Owns everything about a run EXCEPT execution: DB records,
 * log persistence, browser broadcasts, credential resolution, publishing, and
 * post-run cleanup. Execution (workspace materialization, process spawn,
 * event streaming, cancellation) is delegated to the configured WorkerFactory
 * (see src/server/workers/) via a fully-resolved, serializable RunSpec — so
 * the agent can run in-process (local), in a conduit-worker process (remote),
 * or on EKS/Fargate without this file changing.
 */

/** Function signature for broadcasting events to all connected WebSocket clients */
export type BroadcastFn = (channel: string, payload: unknown) => void

/** Environment variable each runner reads its API key/token from. */
const RUNNER_ENV_VAR: Record<string, string> = {
  claude: 'ANTHROPIC_API_KEY',
  amp: 'AMP_API_KEY',
  cursor: 'CURSOR_API_KEY',
}

/**
 * Build the RunSpec env overlay for a run: the agent's explicit envVars, then
 * the acting user's stored runner credential (Settings screen) injected as the
 * runner's API-key env var, the resolved background-task timeout injected as
 * the runner's wait-ceiling env var, and the resolved repo credential exposed
 * as GH_TOKEN for the `gh` CLI. An explicit per-agent envVar always wins over
 * every injected value. The worker applies this overlay on top of its own
 * process env at spawn time.
 */
async function buildRunnerEnvOverlay(
  agent: { runner: string; envVars?: Record<string, string>; ownerId?: string; bgTaskTimeoutSeconds?: number },
  startedBy?: string,
  repoCli?: { authMethod: Repository['authMethod']; url: string; token?: string }
): Promise<Record<string, string>> {
  const env: Record<string, string> = { ...(agent.envVars ?? {}) }
  const ownerId = startedBy || agent.ownerId || DEV_USER_ID

  // Expose the repo's git credential to the host's CLI (GH_TOKEN for `gh`,
  // GITLAB_TOKEN/GITLAB_HOST for `glab`) so it authenticates as the same
  // identity `git push` uses. Only set when a token resolved; ssh/sshkey/none
  // and repo-less runs leave the CLIs unauthenticated.
  if (repoCli) Object.assign(env, repoCliEnvEntries(repoCli.authMethod, repoCli.url, repoCli.token, agent.envVars))

  const envVar = RUNNER_ENV_VAR[agent.runner]
  if (envVar && !(agent.envVars && envVar in agent.envVars)) {
    try {
      const cred = await getCredentialValue(ownerId, agent.runner as 'claude' | 'amp' | 'cursor')
      if (cred) env[envVar] = cred
    } catch (err) {
      console.error(`[server/runner] Failed to load ${agent.runner} credential for ${ownerId}:`, err)
    }
  }

  // Background-task timeout: agent override → user's per-provider Settings value
  // → 0 (run indefinitely). Injected as the runner's wait-ceiling env var.
  try {
    const userSeconds = await getRunnerTimeout(ownerId, agent.runner as RunnerType)
    const effective = resolveBgTaskTimeoutSeconds(agent.bgTaskTimeoutSeconds, userSeconds)
    Object.assign(env, bgTaskTimeoutEnvEntry(agent.runner, effective, agent.envVars))
  } catch (err) {
    console.error(`[server/runner] Failed to resolve bg-task timeout for ${ownerId}:`, err)
  }

  return env
}

interface ActiveRun {
  handle: WorkerHandle
  /** Rejects when the terminal status could not be persisted — the run stays
   *  retryable and the caller must not treat it as finalized. */
  finalize: (status: 'completed' | 'failed' | 'stopped', exitCode?: number | null) => Promise<void>
  /** The run's workspace dir (git worktree or ephemeral tmp dir). Used by the
   *  data-dir sweeper to avoid deleting a running run's workspace. */
  workspacePath: string
  /** The agent this run belongs to — used to enforce one live run per agent. */
  agentId: string
}

// Active runs keyed by runId
const activeProcesses = new Map<string, ActiveRun>()

/** Whether an agent already has a run executing on this pod. One streaming run
 *  per agent at a time: a second concurrent run would double the (multi-GB)
 *  worktree footprint and race the same workspace. */
export function hasActiveRunForAgent(agentId: string): boolean {
  for (const r of activeProcesses.values()) {
    if (r.agentId === agentId) return true
  }
  return false
}

/** Workspace dirs of runs currently executing on this pod. The data-dir sweeper
 *  treats these as protected — never sweeps a live run's worktree/workspace. */
export function getActiveWorkspacePaths(): Set<string> {
  return new Set(
    [...activeProcesses.values()].map((r) => r.workspacePath).filter((p): p is string => !!p)
  )
}

/** RunIds currently executing on this pod (used to protect per-run tmp files
 *  like MCP config, whose names embed the runId). */
export function getActiveRunIds(): Set<string> {
  return new Set(activeProcesses.keys())
}

// Hook invoked after each run reaches a terminal state and has been removed from
// the active set. The server wires this to the data-dir sweeper so disk is
// reclaimed promptly after every job finishes. Declared here (rather than
// importing the sweeper) to avoid a runner ↔ dataDirSweeper circular import.
let runFinalizedHook: (() => void) | null = null
export function setRunFinalizedHook(cb: (() => void) | null): void {
  runFinalizedHook = cb
}
export function notifyRunFinalized(): void {
  try {
    runFinalizedHook?.()
  } catch (err) {
    console.error('[server/runner] run-finalized hook threw:', err)
  }
}

/** Delay before removing a run's workspace, so executables it spawned can exit
 *  and release file handles before we delete the directory. */
const WORKSPACE_CLEANUP_DELAY_MS = 30_000

/** Per-run cap on the on-disk log file (`logs/<runId>.jsonl`). A runaway run —
 *  e.g. one looping and spewing output — could otherwise write gigabytes that the
 *  data-dir sweeper never reclaims (run logs are history, not swept until they
 *  age out). Past the cap we stop persisting to disk (writing one truncation
 *  marker); live streaming to the UI and stdout log-forwarding continue. `0`
 *  disables the cap. The control plane's durable delivery log honors the same
 *  cap for sequenced remote frames (see runDeliveryLog.ts). */
const RUN_LOG_MAX_BYTES = resolveRunLogMaxBytes()

/** Append a system event to a run's log file (used after the log stream is
 *  closed, e.g. by the delayed cleanup). Also emits to stdout for log forwarding. */
export function appendRunLog(runId: string, text: string, logFilePath?: string): void {
  const event: RunEvent = { t: Date.now(), kind: 'raw', stream: 'system', text }
  const target = logFilePath ?? path.join(LOGS_DIR, `${runId}.jsonl`)
  try {
    fs.appendFileSync(target, JSON.stringify(event) + '\n')
  } catch (err) {
    console.error(`[runner] Failed to append cleanup log for run ${runId}: ${err}`)
  }
  process.stdout.write(JSON.stringify({ runId, ...event }) + '\n')
}

/**
 * Cleanup helper for a finished run. Removes the run's MCP config immediately
 * (it carries a token), then — after a short delay so spawned executables can
 * exit — removes the run's workspace (git worktree or ephemeral dir) and logs
 * the outcome to the run's log. A fixed `workingDir` is never deleted.
 */
function cleanupRun(
  runId: string,
  workspacePath: string | undefined,
  ephemeral: boolean,
  worktreeClonePath?: string
): void {
  deleteMcpConfig(runId)
  deleteClaudeConfig(runId)
  const removable = !!workspacePath && (!!worktreeClonePath || ephemeral)
  if (!removable) return

  setTimeout(() => {
    void (async () => {
      try {
        if (worktreeClonePath) {
          await removeWorktree(worktreeClonePath, workspacePath!)
        } else {
          deleteWorkspace(workspacePath!)
        }
      } catch (err) {
        console.error(`[runner] Workspace cleanup error for run ${runId}: ${err}`)
      }
      // removeWorktree/deleteWorkspace swallow errors internally, so verify by
      // checking the directory is actually gone.
      if (fs.existsSync(workspacePath!)) {
        appendRunLog(runId, `⚠ Failed to clean up run workspace — ${workspacePath} still present.`)
      } else {
        appendRunLog(runId, `✓ Cleaned up run workspace (${workspacePath}).`)
      }
    })()
  }, WORKSPACE_CLEANUP_DELAY_MS)
}

export interface RunOrchestration {
  sink: WorkerEventSink
  emitSystemMessage: (text: string) => void
  register: (handle: WorkerHandle) => void
  abort: () => void
  /** Run `cb` once the run leaves the active set (terminal state or abort). */
  onFinalized: (cb: () => void) => void
}

/**
 * Shared log/broadcast/finalize pipeline for new runs and recovered remote runs.
 * Opens `run.logPath` in append mode and seeds `lastLine` from the run record.
 */
export function createRunOrchestration(opts: {
  run: ExecutionRun
  broadcast: BroadcastFn
  runner: RunnerType
}): RunOrchestration {
  const { run, broadcast, runner } = opts
  const runId = run.id
  const agentId = run.agentId
  const logStream = fs.createWriteStream(run.logPath, { flags: 'a', encoding: 'utf8' })

  let logBytesWritten = 0
  try {
    logBytesWritten = fs.statSync(run.logPath).size
  } catch {
    logBytesWritten = 0
  }
  let logCapped = RUN_LOG_MAX_BYTES > 0 && logBytesWritten >= RUN_LOG_MAX_BYTES
  let lastLine = run.lastLine ?? ''

  const eventBuffer: RunEvent[] = []
  let flushScheduled = false
  function scheduleFlush(): void {
    if (flushScheduled) return
    flushScheduled = true
    setImmediate(() => {
      flushScheduled = false
      if (eventBuffer.length > 0) {
        const events = eventBuffer.splice(0)
        broadcast('run:events', { runId, events })
      }
    })
  }

  /** Append to the run's own jsonl, honoring the per-run byte cap. */
  function persistRunEvent(event: RunEvent): void {
    if (logCapped) return
    const line = JSON.stringify(event)
    logStream.write(line + '\n')
    if (RUN_LOG_MAX_BYTES <= 0) return
    logBytesWritten += Buffer.byteLength(line) + 1
    if (logBytesWritten < RUN_LOG_MAX_BYTES) return
    logCapped = true
    logStream.write(
      JSON.stringify({
        t: Date.now(),
        kind: 'raw',
        stream: 'system',
        text: `[Conduit: run log truncated on disk — exceeded ${RUN_LOG_MAX_BYTES}-byte cap. Live output continues.]`,
      }) + '\n'
    )
  }

  /** Emit to the process log for external shipping. Runs for durable remote
   *  frames too — those skip `persistRunEvent`, not stdout forwarding. */
  function forwardRunEvent(event: RunEvent): void {
    process.stdout.write(JSON.stringify({ runId, agentId, ...event }) + '\n')
  }

  const eventHandlers = createRunEventHandlers({
    persist: persistRunEvent,
    forward: forwardRunEvent,
    live: (event) => {
      const summary = summarizeEvent(event)
      if (summary) lastLine = summary.slice(0, 500)
      eventBuffer.push(event)
      scheduleFlush()
    },
  })

  let finalized = false
  const finalizers: Array<() => void> = []
  const runFinalizers = (): void => {
    for (const cb of finalizers.splice(0)) cb()
  }
  let workspacePath: string | undefined = run.workspacePath
  let isEphemeral = false
  let worktreeClonePath: string | undefined = undefined

  /**
   * Terminal handling, ordered around the one durable step.
   *
   * The status write comes first and is the commit point. If it throws, nothing
   * observable has happened: the run stays retryable (workspace intact, log
   * stream open, still in the active set) and the error propagates so a
   * sequenced control-plane frame is left spooled for replay rather than
   * acknowledged. Cleanup, the log-stream close, and the finalized hook only
   * run once the status is durable. A publish failure after that point is
   * reported but not rethrown — terminal state must not be applied twice.
   */
  async function finalizeRun(
    status: 'completed' | 'failed' | 'stopped',
    exitCode: number | null | undefined
  ): Promise<void> {
    if (finalized) return
    finalized = true

    const endedAt = Date.now()
    const durationMs = endedAt - run.startedAt

    let finalRun: ExecutionRun | null
    try {
      finalRun = await updateRunIfRunning(runId, {
        status,
        endedAt,
        durationMs,
        exitCode: exitCode ?? undefined,
        lastLine: lastLine || undefined,
      })
    } catch (err) {
      finalized = false
      console.error(`[server/runner] Terminal update failed for run ${runId}:`, err)
      reporter.captureException(err instanceof Error ? err : new Error(String(err)), {
        tags: { component: 'runner', op: 'finalizeRun', runId, runner },
      })
      throw err
    }

    activeProcesses.delete(runId)
    runFinalizers()

    if (eventBuffer.length > 0) {
      const events = eventBuffer.splice(0)
      broadcast('run:events', { runId, events })
    }

    await new Promise<void>((resolve) => {
      logStream.end(() => resolve())
    })

    cleanupRun(runId, workspacePath, isEphemeral, worktreeClonePath)

    try {
      if (finalRun) {
        broadcast('run:statusChange', {
          runId,
          status,
          exitCode: exitCode ?? undefined,
          endedAt,
          durationMs,
        })
        const outcomes = (await publishRunResult(agentId, finalRun)) ?? []
        for (const outcome of outcomes) {
          if (outcome.ok) {
            appendRunLog(runId, `Published to ${outcome.targetName}`)
            continue
          }
          appendRunLog(runId, `⚠️  Publish to ${outcome.targetName} failed: ${outcome.error}`)
          reporter.captureException(new Error(`Publish to ${outcome.targetName} failed: ${outcome.error}`), {
            tags: { component: 'runner', op: 'publishRunResult', runId, runner },
          })
        }
      }
    } catch (err) {
      console.error(`[server/runner] Publish failed for run ${runId}:`, err)
      reporter.captureException(err instanceof Error ? err : new Error(String(err)), {
        tags: { component: 'runner', op: 'publishRunResult', runId, runner },
      })
    } finally {
      notifyRunFinalized()
    }
  }

  const sink: WorkerEventSink = {
    onEvent: (init) => {
      eventHandlers.onEvent(init)
    },
    onDurableEvent: eventHandlers.onDurableEvent,
    onError: (err) => {
      console.error(`[server/runner] Spawn error for run ${runId}:`, err)
      reporter.captureException(err, {
        tags: { component: 'runner', runId, runner },
      })
      eventHandlers.onEvent({ kind: 'raw', stream: 'system', text: `\n[Error: ${err.message}]\n` })
      void finalizeRun('failed', undefined).catch((finalizeErr) => {
        console.error(`[server/runner] Failed to finalize run ${runId} after spawn error:`, finalizeErr)
      })
    },
    onExit: (status, exitCode) => {
      if (status === 'failed' && !finalized && !isDerivedWorkerControlFailure(lastLine)) {
        const report = buildRunFailureReport({ runId, runner, exitCode, lastLine })
        reporter.captureMessage(report.message, report.level, report.ctx)
      }
      return finalizeRun(status, exitCode)
    },
  }

  return {
    sink,
    emitSystemMessage: (text) => {
      eventHandlers.onEvent({ kind: 'raw', stream: 'system', text })
    },
    register: (handle) => {
      workspacePath = handle.workspacePath
      isEphemeral = handle.ephemeral
      worktreeClonePath = handle.worktreeClonePath
      activeProcesses.set(runId, {
        handle,
        finalize: finalizeRun,
        workspacePath: workspacePath ?? '',
        agentId,
      })
    },
    abort: () => {
      finalized = true
      runFinalizers()
      logStream.end()
    },
    onFinalized: (cb) => {
      finalizers.push(cb)
    },
  }
}

/** GitHub App installation tokens last an hour; replace them well before that. */
export const REPO_TOKEN_REFRESH_MS = 45 * 60_000

/**
 * Periodically mint a fresh repo token and hand it to the worker, so `git push`
 * and `gh` keep working in runs that outlive the token they started with.
 */
export function startRepoTokenRefresh(
  runId: string,
  repo: Pick<Repository, 'id' | 'url' | 'authMethod'>,
  handle: WorkerHandle,
  orch: Pick<RunOrchestration, 'emitSystemMessage' | 'onFinalized'>,
  intervalMs = REPO_TOKEN_REFRESH_MS
): void {
  const refresh = async (): Promise<void> => {
    try {
      const { token, error } = await resolvePushCredential(repo)
      if (error) throw error
      if (token) await handle.updateRepoToken?.(token)
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err))
      orch.emitSystemMessage(
        `⚠️  Could not refresh GitHub credentials: ${e.message}\n` +
          `   "git push" and "gh" will fail once the current token expires.\n`
      )
      reporter.captureException(e, {
        tags: { component: 'runner', op: 'refreshRepoToken', runId, repoId: repo.id },
      })
    }
  }
  const timer = setInterval(() => void refresh(), intervalMs)
  timer.unref?.()
  orch.onFinalized(() => clearInterval(timer))
}

/**
 * Keep a run's OAuth MCP bearers current: re-resolve them (renewing any near
 * expiry) and hand the worker only the values that changed.
 */
export function startMcpAuthRefresh(
  runId: string,
  servers: RunMcpOAuthServer[],
  handle: WorkerHandle,
  orch: Pick<RunOrchestration, 'emitSystemMessage' | 'onFinalized'>,
  intervalMs = RUN_MCP_REFRESH_INTERVAL_MS
): void {
  const sent = new Map(servers.map((s) => [s.key, s.authorization]))
  let warned = false
  const refresh = async (): Promise<void> => {
    try {
      const auth = await resolveRunMcpAuth(servers)
      const changed = Object.fromEntries(Object.entries(auth).filter(([key, value]) => sent.get(key) !== value))
      if (Object.keys(changed).length === 0) return
      await handle.updateMcpAuth?.(changed)
      for (const [key, value] of Object.entries(changed)) sent.set(key, value)
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err))
      // Retried every interval; one log line per run is enough to explain later 401s.
      if (!warned) {
        warned = true
        orch.emitSystemMessage(
          `⚠️  Could not refresh MCP OAuth credentials: ${e.message}\n` +
            `   MCP servers will reject calls once their current token expires.\n`
        )
      }
      reporter.captureException(e, { tags: { component: 'runner', op: 'refreshMcpAuth', runId } })
    }
  }
  const timer = setInterval(() => void refresh(), intervalMs)
  timer.unref?.()
  orch.onFinalized(() => clearInterval(timer))
}

/**
 * Start an agent run in server mode.
 *
 * Orchestrates the run (DB record, log stream, broadcasts, publish) and
 * delegates execution to the configured WorkerFactory with a fully-resolved
 * RunSpec. Events stream back through the WorkerEventSink.
 */
export async function startRunServer(
  agentId: string,
  broadcast: BroadcastFn,
  triggerContext?: TriggerContext,
  startedBy?: string
): Promise<ExecutionRun> {
  // 1. Load agent
  const agent = await getAgent(agentId)
  if (!agent) throw new Error(`Agent ${agentId} not found`)

  // One live run per agent: reject a second concurrent start rather than spin up
  // another multi-GB worktree racing the same agent. Checked both against this
  // pod's active set (fast path) and the DB (holds across factories and pods).
  if (hasActiveRunForAgent(agentId) || (await getRunningRunForAgent(agentId))) {
    throw new Error(
      `Agent "${agent.name || agentId}" already has a run in progress. ` +
        `Stop it before starting another.`
    )
  }

  // 2. Determine the workspace spec: repo worktree (local factory, off the
  //    server-side bare clone) > repo clone (remote workers, fresh from the
  //    remote) > fixed workingDir (local only) > ephemeral. Materialization
  //    happens inside the worker factory.
  const factory = getWorkerFactory()
  let workspaceSpec: WorkspaceSpec
  // Set when push-credential resolution failed; surfaced into the run log once
  // the log stream is open (see below), so a broken git token is never invisible.
  let pushCredentialError: string | undefined
  // The resolved repo token (global PAT / minted GitHub-App installation token /
  // GitLab access token). Tokenizes the checkout's `origin` for `git push` AND
  // is handed to the host CLI (gh/glab) so it authenticates as the same identity.
  let pushToken: string | undefined
  let repoCli: { authMethod: Repository['authMethod']; url: string; token?: string } | undefined
  // Set for GitHub App repos, whose installation tokens expire mid-run.
  let refreshableRepo: Pick<Repository, 'id' | 'url' | 'authMethod'> | undefined

  if (agent.repositoryId) {
    const repo = await getRepository(agent.repositoryId)
    if (!repo) throw new Error(`Repository ${agent.repositoryId} not found`)
    if (repo.authMethod === 'githubapp') refreshableRepo = repo
    if (factory.kind === 'local' && repo.syncStatus !== 'ready') {
      // The local factory worktrees off the server-side bare clone, so it must
      // be synced; remote factories clone from the remote and don't use it.
      throw new Error(
        `Repository "${repo.name}" is not ready (status: ${repo.syncStatus}).` +
        (repo.syncError ? ` Error: ${repo.syncError}` : ' Please wait for sync to complete.')
      )
    }
    if (repo.authMethod === 'sshkey' && !repo.sshKnownHosts?.trim()) {
      // The host key is pinned by the first successful server-side sync. A
      // remote worker cloning before then would trust whatever host answers,
      // and couldn't record what it saw.
      throw new Error(
        `Repository "${repo.name}" has no pinned SSH host key yet. Sync it successfully (or set Known Hosts) before running agents.`
      )
    }
    // Resolve push credentials (non-throwing) so the token can travel in the
    // RunSpec for the worker to inject into the checkout's origin. A failed
    // mint is recorded, not fatal — the agent's later `git push` fails with an
    // opaque credential error otherwise, so record why in both Sentry and the
    // run log (the run-log line is emitted below, once the log stream is open).
    const { auth: repoAuth, error: pushTokenError } = await resolveRepoAuthSafe(repo)
    pushToken = repoAuth.token
    repoCli = { authMethod: repo.authMethod, url: repo.url, token: pushToken }
    if (pushTokenError) {
      pushCredentialError = pushTokenError.message
      reporter.captureException(pushTokenError, {
        tags: { component: 'runner', op: 'resolveRepoAuth', repoId: repo.id },
      })
      console.error(`[server/runner] Could not resolve push credentials for repo ${repo.id}:`, pushTokenError)
    }
    const specRepo = {
      url: repo.url,
      defaultBranch: repo.defaultBranch,
      token: pushToken,
      tokenUsername: repoAuth.tokenUsername,
      sshPrivateKey: repoAuth.sshKey?.privateKey,
      sshKnownHosts: repoAuth.sshKey?.knownHosts,
      authorName: repo.commitAuthorName?.trim() || 'Conduit',
      authorEmail: repo.commitAuthorEmail?.trim() || 'conduit@dovetail.com',
    }
    workspaceSpec =
      factory.kind === 'local'
        ? {
            kind: 'worktree',
            clonePath: repo.clonePath!,
            worktreeDir: path.join(repo.clonePath!, 'worktrees-run', crypto.randomUUID()),
            repo: specRepo,
          }
        : { kind: 'repo-clone', repo: specRepo }
  } else if (agent.workingDir) {
    if (factory.kind !== 'local') {
      throw new Error(
        `Agent "${agent.name || agentId}" uses a fixed working directory (${agent.workingDir}), ` +
          `which only exists on the server host — it cannot run on a remote worker.`
      )
    }
    workspaceSpec = { kind: 'fixedDir', path: agent.workingDir }
  } else {
    workspaceSpec = { kind: 'ephemeral' }
  }

  const actingUserId = startedBy ?? agent.ownerId ?? DEV_USER_ID

  // 3. Create run record (log path updated once we have the runId;
  //    workspacePath updated once the worker resolves it).
  const runRecord = await createRun({
    agentId,
    status: 'running',
    startedAt: Date.now(),
    workspacePath: undefined,
    logPath: path.join(LOGS_DIR, `__pending__.jsonl`), // placeholder
    exitCode: undefined,
    endedAt: undefined,
    durationMs: undefined,
    triggerContext: triggerContext ?? undefined,
    startedBy: startedBy ?? undefined,
    workerKind: factory.kind,
  })

  const runId = runRecord.id
  const realLogPath = path.join(LOGS_DIR, `${runId}.jsonl`)
  await updateRun(runId, { logPath: realLogPath })

  // 4. Materialize the MCP config content (global merge + OAuth tokens + env
  //    expansion) for the RunSpec. This can throw (e.g. an MCP OAuth token that
  //    can't be decrypted). Since the run record already exists, an unhandled
  //    throw here would leave it orphaned as "running" forever with no log — so
  //    on failure we mark it failed, record why in its log, and surface it.
  let mcpConfigContent: string
  let mcpOAuthServers: RunMcpOAuthServer[]
  try {
    ;({ content: mcpConfigContent, oauthServers: mcpOAuthServers } = await buildRunMcpConfig(
      agent.mcpConfig,
      actingUserId
    ))
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    appendRunLog(runId, `Failed to prepare run: ${msg}`)
    cleanupRun(runId, undefined, false)
    await updateRun(runId, { status: 'failed', endedAt: Date.now(), lastLine: `Failed to prepare run: ${msg}` })
    broadcast('run:statusChange', { runId, status: 'failed' })
    reporter.captureException(err, { tags: { component: 'runner', op: 'prepareRun', runId } })
    throw err
  }

  const run = { ...runRecord, logPath: realLogPath }
  const orch = createRunOrchestration({ run, broadcast, runner: agent.runner })

  // Surface a broken push credential into the run log so it's attributable at a
  // glance, rather than only showing up later as an opaque `git push` failure.
  if (pushCredentialError) {
    orch.emitSystemMessage(
      `⚠️  Could not obtain git push credentials for this repository: ${pushCredentialError}\n` +
      `   The agent can read the code, but "git push" (and opening PRs) will fail. ` +
      `Check the repository's authentication settings.`
    )
  }

  // 6. Build the fully-resolved RunSpec and hand execution to the worker
  //    factory. Events stream back through the sink into the pipeline above.
  const spec: RunSpec = {
    runId,
    agentId,
    runner: agent.runner,
    model: agent.model,
    effort: agent.effort,
    prompt: triggerContext ? buildTriggeredPrompt(agent.prompt, triggerContext) : agent.prompt,
    env: await buildRunnerEnvOverlay(agent, startedBy, repoCli),
    mcpConfigContent,
    mcpOAuthServerKeys: mcpOAuthServers.length ? mcpOAuthServers.map((s) => s.key) : undefined,
    strictMcpConfig: agent.runner === 'claude' ? !agent.enableRepoMcps : undefined,
    workerMemoryMib: agent.workerMemoryMib,
    workspace: workspaceSpec,
  }

  let handle: WorkerHandle
  try {
    handle = await factory.startRun(spec, orch.sink)
  } catch (err) {
    // Rethrown to the caller (WS 'runs:start' handler / triggerService), which
    // reports it — capturing here too would double-report. The factory rolls
    // back any workspace/config it created before throwing.
    // Persist lastLine so a failed start (disk full, clone error) is visible in
    // run history instead of a blank Failed row — cron retries used to pile up
    // unlabeled failures while the volume was exhausted.
    const lastLine = failedStartLastLine(err)
    orch.emitSystemMessage(lastLine)
    cleanupRun(runId, undefined, false)
    orch.abort()
    await updateRun(runId, { status: 'failed', endedAt: Date.now(), lastLine })
    broadcast('run:statusChange', { runId, status: 'failed' })
    throw err
  }

  orch.register(handle)
  if (refreshableRepo && pushToken && handle.updateRepoToken) {
    startRepoTokenRefresh(runId, refreshableRepo, handle, orch)
  }
  if (mcpOAuthServers.length && handle.updateMcpAuth) {
    startMcpAuthRefresh(runId, mcpOAuthServers, handle, orch)
  }

  // Record the resolved workspace path (worker-local for remote factories) and
  // the executing worker's identity.
  return await updateRun(runId, { workspacePath: handle.workspacePath, workerId: handle.workerId })
}

/**
 * Stop a running agent by cancelling it through its worker handle.
 * Uses the finalize closure from startRunServer to ensure consistent cleanup.
 */
export async function stopRun(runId: string): Promise<void> {
  const activeRun = activeProcesses.get(runId)
  if (!activeRun) {
    console.warn(`[server/runner] stopRun called for unknown runId: ${runId}`)
    return
  }

  // Call the finalize closure first (marks finalized=true, prevents double-run on exit)
  await activeRun.finalize('stopped', null)

  // Then cancel execution — the exit will still arrive but finalizeRun will no-op
  try {
    await activeRun.handle.cancel()
  } catch (err) {
    console.error(`[server/runner] Failed to cancel run ${runId}:`, err)
  }
}
