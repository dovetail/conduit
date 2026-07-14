import { spawn, ChildProcess } from 'child_process'
import { createInterface } from 'readline'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import type { ExecutionRun, RunEvent, RunEventInit, TriggerContext, RunnerType } from '../shared/types'
import { summarizeEvent } from '../shared/runEvents'
import { createRun, updateRun, hasActiveRunForAgent } from '../main/db/queries/runs'
import { appendRunEvents } from '../main/db/queries/runEvents'
import { getAgent } from '../main/db/queries/agents'
import { getRepository } from '../main/db/queries/repositories'
import { getCredentialValue } from '../main/db/queries/agentCredentials'
import { getRunnerTimeout } from '../main/db/queries/runnerSettings'
import { resolveBgTaskTimeoutSeconds, bgTaskTimeoutEnvEntry } from './runnerTimeout'
import { createWorkspace, deleteWorkspace } from '../main/execution/workspace'
import { writeMcpConfig, deleteMcpConfig } from '../main/utils/mcp'
import { writeClaudeConfig, deleteClaudeConfig } from '../main/utils/claudeConfig'
import { DEV_USER_ID } from './auth/config'
import { LOGS_DIR } from '../main/utils/paths'
import { createConfiguredWorktree, removeWorktree } from './gitOps'
import { buildRunFailureReport } from './runFailure'
import { resolvePushCredential } from './githubApp'
import { buildClaudeArgs, parseClaudeEvents } from '../main/execution/adapters/claude'
import { buildAmpArgs, parseAmpEvents } from '../main/execution/adapters/amp'
import { buildCursorArgs, CURSOR_NOTICE } from '../main/execution/adapters/cursor'
import { publishRunResult } from './publisher'
import { buildTriggeredPrompt } from './triggers/promptBuilder'
import { reporter } from './observability'
import { getExecutorKind, JobExecutor, type Executor, type PreparedRun } from './executor'

/** Function signature for broadcasting events to all connected WebSocket clients.
 *  Re-exported from ./executor so existing importers (e.g. repoSync) keep working. */
export type { BroadcastFn } from './executor'
import type { BroadcastFn } from './executor'

/** Environment variable each runner reads its API key/token from. */
const RUNNER_ENV_VAR: Record<string, string> = {
  claude: 'ANTHROPIC_API_KEY',
  amp: 'AMP_API_KEY',
  cursor: 'CURSOR_API_KEY',
}

/**
 * Build the child-process environment for a run: the host env, overlaid with
 * the agent's explicit envVars, then the acting user's stored runner credential
 * (Settings screen) injected as the runner's API-key env var, and the resolved
 * background-task timeout injected as the runner's wait-ceiling env var. An
 * explicit per-agent envVar always wins over both injected values.
 */
async function buildRunnerEnv(
  agent: { runner: string; envVars?: Record<string, string>; ownerId?: string; bgTaskTimeoutSeconds?: number },
  startedBy?: string
): Promise<NodeJS.ProcessEnv> {
  const env: NodeJS.ProcessEnv = { ...process.env, ...(agent.envVars ?? {}) }
  const ownerId = startedBy || agent.ownerId || DEV_USER_ID

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
  child: ChildProcess
  finalize: (status: 'completed' | 'failed' | 'stopped', exitCode?: number | null) => void
  /** The run's workspace dir (git worktree or ephemeral tmp dir). Used by the
   *  data-dir sweeper to avoid deleting a running run's workspace. */
  workspacePath: string
  /** The agent this run belongs to — used to enforce one live run per agent. */
  agentId: string
}

// Active child processes keyed by runId. Pod-local by design: it tracks the
// child processes *this* pod owns, so the data-dir sweeper never reaps a live
// run's worktree (worktrees are pod-local). The per-agent concurrency guard is
// NOT read from here anymore — it moved to RDS (hasActiveRunForAgent) so it is
// correct across pods.
const activeProcesses = new Map<string, ActiveRun>()

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

/** Identifier of the pod/host executing runs, recorded on each run row for
 *  observability + (later) Job supervision. K8s sets the pod's hostname to the
 *  pod name; `CONDUIT_POD_NAME` (e.g. from the downward API) overrides it. */
function getPodName(): string {
  return process.env.CONDUIT_POD_NAME || os.hostname()
}

// Hook invoked after each run reaches a terminal state and has been removed from
// the active set. The server wires this to the data-dir sweeper so disk is
// reclaimed promptly after every job finishes. Declared here (rather than
// importing the sweeper) to avoid a runner ↔ dataDirSweeper circular import.
let runFinalizedHook: (() => void) | null = null
export function setRunFinalizedHook(cb: (() => void) | null): void {
  runFinalizedHook = cb
}
function notifyRunFinalized(): void {
  try {
    runFinalizedHook?.()
  } catch (err) {
    console.error('[server/runner] run-finalized hook threw:', err)
  }
}

/** Delay before removing a run's workspace, so executables it spawned can exit
 *  and release file handles before we delete the directory. */
const WORKSPACE_CLEANUP_DELAY_MS = 30_000

/** Per-run cap on the on-disk log file (`logs/<runId>.jsonl`) AND the RDS
 *  `run_events` mirror. A runaway run — e.g. one looping and spewing output —
 *  could otherwise write gigabytes that the data-dir sweeper never reclaims (run
 *  logs are history, not swept until they age out). Past the cap we stop
 *  persisting (writing one truncation marker); live streaming to the UI and
 *  stdout log-forwarding continue. `0` disables the cap. */
const RUN_LOG_MAX_BYTES = (() => {
  const n = Number(process.env.CONDUIT_RUN_LOG_MAX_BYTES)
  return Number.isFinite(n) && n >= 0 ? n : 500 * 1024 * 1024 // 500 MB
})()

/** Append a system event to a run's log file (used after the log stream is
 *  closed, e.g. by the delayed cleanup). Also emits to stdout for log forwarding. */
export function appendRunLog(runId: string, text: string): void {
  const event: RunEvent = { t: Date.now(), kind: 'raw', stream: 'system', text }
  try {
    fs.appendFileSync(path.join(LOGS_DIR, `${runId}.jsonl`), JSON.stringify(event) + '\n')
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

/**
 * Setup phase of a run (P3 change A). Loads the agent, enforces the per-agent
 * concurrency guard, resolves the workspace (repo worktree > fixed dir >
 * ephemeral), inserts the `runs` row, and writes the per-run MCP config. Returns
 * everything the execute phase needs. This work is identical regardless of where
 * the run then executes (in-process, or — later — a Kubernetes Job).
 *
 * Errors surface to the caller exactly as before: a missing agent, an
 * already-running agent, an unready repository, or a failed worktree/MCP-config
 * step throws (with the run row marked failed + logged for the MCP-config case).
 */
export async function prepareRun(
  agentId: string,
  broadcast: BroadcastFn,
  triggerContext?: TriggerContext,
  startedBy?: string
): Promise<PreparedRun> {
  // 1. Load agent
  const agent = await getAgent(agentId)
  if (!agent) throw new Error(`Agent ${agentId} not found`)

  // One live run per agent: reject a second concurrent start rather than spin up
  // another multi-GB worktree racing the same agent. Backed by RDS so the guard
  // is correct across pods. (Cursor "launches" settle to 'launched', so they're
  // unaffected.)
  if (await hasActiveRunForAgent(agentId)) {
    throw new Error(
      `Agent "${agent.name || agentId}" already has a run in progress. ` +
        `Stop it before starting another.`
    )
  }

  // 2. Determine workspace: repo worktree > fixed workingDir > ephemeral
  let workspacePath: string
  let isEphemeral: boolean
  let worktreeClonePath: string | undefined
  // Set when push-credential resolution failed; surfaced into the run log once
  // the log stream is open (see the executor), so a broken git token is never invisible.
  let pushCredentialError: string | undefined

  if (agent.repositoryId) {
    const repo = await getRepository(agent.repositoryId)
    if (!repo) throw new Error(`Repository ${agent.repositoryId} not found`)
    if (repo.syncStatus !== 'ready') {
      throw new Error(
        `Repository "${repo.name}" is not ready (status: ${repo.syncStatus}).` +
        (repo.syncError ? ` Error: ${repo.syncError}` : ' Please wait for sync to complete.')
      )
    }
    // Generate a run-scoped worktree path under the bare clone
    const tempRunId = crypto.randomUUID()
    const worktreeDir = path.join(repo.clonePath!, 'worktrees-run', tempRunId)
    // Resolve push credentials first (non-throwing) so the token can be injected
    // into the worktree's origin below. A failed mint is recorded, not fatal — the
    // agent's later `git push` fails with an opaque credential error otherwise, so
    // record why in both Sentry and the run log (the run-log line is emitted by the
    // executor, once the log stream is open).
    const { token: pushToken, error: pushTokenError } = await resolvePushCredential(repo)
    if (pushTokenError) {
      pushCredentialError = pushTokenError.message
      reporter.captureException(pushTokenError, {
        tags: { component: 'runner', op: 'resolvePushCredential', repoId: repo.id },
      })
      console.error(`[server/runner] Could not resolve push credentials for repo ${repo.id}:`, pushTokenError)
    }
    // Create + configure the worktree as one unit. On any failure the worktree is
    // torn down (see createConfiguredWorktree) and the error is reported here and
    // rethrown — so a broken checkout (e.g. a stale/missing bare clone despite a
    // 'ready' status) fails the run cleanly instead of escaping uncaught and
    // orphaning a multi-GB worktree for the slow sweeper to reclaim.
    try {
      await createConfiguredWorktree(repo.clonePath!, worktreeDir, repo.defaultBranch, {
        url: repo.url,
        token: pushToken,
        authorName: repo.commitAuthorName?.trim() || 'Conduit',
        authorEmail: repo.commitAuthorEmail?.trim() || 'conduit@dovetail.com',
      })
    } catch (err) {
      reporter.captureException(err instanceof Error ? err : new Error(String(err)), {
        tags: { component: 'runner', op: 'createWorktree', repoId: repo.id, agentId },
      })
      throw err
    }
    workspacePath = worktreeDir
    worktreeClonePath = repo.clonePath!
    isEphemeral = false
  } else if (agent.workingDir) {
    workspacePath = agent.workingDir
    isEphemeral = false
  } else {
    workspacePath = createWorkspace(agentId)
    isEphemeral = true
  }

  // 4. Create run record (log path updated after we have the runId). Record how
  // and where the run is being executed so run coordination is multi-pod-safe.
  const runRecord = await createRun({
    agentId,
    status: 'running',
    startedAt: Date.now(),
    workspacePath,
    logPath: path.join(LOGS_DIR, `__pending__.jsonl`), // placeholder
    exitCode: undefined,
    endedAt: undefined,
    durationMs: undefined,
    triggerContext: triggerContext ?? undefined,
    startedBy: startedBy ?? undefined,
    executor: getExecutorKind(),
    podName: getPodName(),
    heartbeatAt: Date.now(),
  })

  const runId = runRecord.id
  const realLogPath = path.join(LOGS_DIR, `${runId}.jsonl`)

  // Update run record with the real log path
  const run = await updateRun(runId, { logPath: realLogPath })

  // 3b. Write MCP config now that we have the runId. This can throw (e.g. an MCP
  // OAuth token that can't be decrypted). Since the run record already exists,
  // an unhandled throw here would leave it orphaned as "running" forever with no
  // log — so on failure we mark it failed, record why in its log, and surface it.
  const actingUserId = startedBy ?? agent.ownerId ?? DEV_USER_ID
  let mcpConfigPath: string
  try {
    mcpConfigPath = await writeMcpConfig(runId, agent.mcpConfig, actingUserId)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    appendRunLog(runId, `Failed to prepare run: ${msg}`)
    cleanupRun(runId, workspacePath, isEphemeral, worktreeClonePath)
    await updateRun(runId, { status: 'failed', endedAt: Date.now(), lastLine: `Failed to prepare run: ${msg}` })
    broadcast('run:statusChange', { runId, status: 'failed' })
    reporter.captureException(err, { tags: { component: 'runner', op: 'prepareRun', runId } })
    throw err
  }

  return {
    agent,
    run,
    runId,
    workspacePath,
    isEphemeral,
    worktreeClonePath,
    mcpConfigPath,
    pushCredentialError,
    triggerContext,
    startedBy,
  }
}

/**
 * In-process executor (P3 change A): spawns the agent CLI as a child of the
 * control-plane pod, streams its output into structured events, and finalizes the
 * run. This is the original execution path — behaviour is unchanged — now behind
 * the {@link Executor} seam so an out-of-process (Job) executor can replace it via
 * `CONDUIT_EXECUTOR`. Events are streamed to WebSocket clients (as before) AND
 * mirrored into the RDS `run_events` log (P3 change D) so any replica can serve
 * `runs:getLog` without the pod-local `/data` coupling.
 */
export class InProcessExecutor implements Executor {
  readonly kind = 'inproc' as const

  async execute(prepared: PreparedRun, broadcast: BroadcastFn): Promise<ExecutionRun> {
    const {
      agent,
      run,
      runId,
      workspacePath,
      isEphemeral,
      worktreeClonePath,
      mcpConfigPath,
      pushCredentialError,
      triggerContext,
      startedBy,
    } = prepared
    const agentId = agent.id
    const realLogPath = path.join(LOGS_DIR, `${runId}.jsonl`)

    // 5. Open log file write stream
    const logStream = fs.createWriteStream(realLogPath, { flags: 'a', encoding: 'utf8' })

    // Bytes written to the on-disk log so far, and whether the cap has been hit.
    let logBytesWritten = 0
    let logCapped = false

    // Persist one structured event to the run's log file (until the per-run size
    // cap), then forward it to the platform log pipeline. New runs store RunEvents
    // (one per NDJSON line); old runs' ANSI LogEntry logs still replay via the
    // format-detecting reader.
    function writeRunEvent(event: RunEvent): void {
      const line = JSON.stringify(event)
      if (!logCapped) {
        logStream.write(line + '\n')
        if (RUN_LOG_MAX_BYTES > 0) {
          logBytesWritten += Buffer.byteLength(line) + 1
          if (logBytesWritten >= RUN_LOG_MAX_BYTES) {
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
        }
      }
      // Always emit to stdout so the platform log forwarder (Datadog, etc.) ingests.
      process.stdout.write(JSON.stringify({ runId, agentId, ...event }) + '\n')
    }

    // Mirror events into the RDS run_events log (P3 change D). Appends are
    // serialized on a per-run chain so their `seq` matches emission order, and
    // capped the same way as the on-disk log so a runaway run can't grow RDS
    // unbounded. Failures are captured, never thrown on the hot path.
    let rdsBytes = 0
    let rdsCapped = false
    let rdsChain: Promise<void> = Promise.resolve()
    function persistEvents(events: RunEvent[]): void {
      if (rdsCapped || events.length === 0) return
      const toPersist = events.slice()
      if (RUN_LOG_MAX_BYTES > 0) {
        for (const ev of events) rdsBytes += Buffer.byteLength(JSON.stringify(ev)) + 1
        if (rdsBytes >= RUN_LOG_MAX_BYTES) {
          rdsCapped = true
          toPersist.push({
            t: Date.now(),
            kind: 'raw',
            stream: 'system',
            text: `[Conduit: run log truncated in RDS — exceeded ${RUN_LOG_MAX_BYTES}-byte cap. Live output continues.]`,
          })
        }
      }
      rdsChain = rdsChain
        .then(() => appendRunEvents(runId, toPersist))
        .catch((err) =>
          reporter.captureException(err, { tags: { component: 'runner', op: 'appendRunEvents', runId } })
        )
    }

    // Last meaningful activity (plain text) for the runs-list excerpt / live label.
    let lastLine = ''

    // Buffer + flush structured events into batched WebSocket broadcasts, and
    // mirror the same batch into RDS.
    const eventBuffer: RunEvent[] = []
    let flushScheduled = false
    function flushBuffer(): void {
      if (eventBuffer.length === 0) return
      const events = eventBuffer.splice(0)
      broadcast('run:events', { runId, events })
      persistEvents(events)
    }
    function scheduleFlush(): void {
      if (flushScheduled) return
      flushScheduled = true
      setImmediate(() => {
        flushScheduled = false
        flushBuffer()
      })
    }

    // Stamp, persist, summarize (for lastLine), and queue an event for broadcast.
    function emitEvent(init: RunEventInit): void {
      const event: RunEvent = { ...init, t: Date.now() }
      writeRunEvent(event)
      const summary = summarizeEvent(event)
      if (summary) lastLine = summary.slice(0, 500)
      eventBuffer.push(event)
      scheduleFlush()
    }

    function emitSystemMessage(text: string): void {
      emitEvent({ kind: 'raw', stream: 'system', text })
    }

    // Guard against double-finalization (e.g. stopRun + close event)
    let finalized = false

    async function finalizeRun(
      status: 'completed' | 'failed' | 'stopped',
      exitCode: number | null | undefined
    ): Promise<void> {
      if (finalized) return
      finalized = true
      activeProcesses.delete(runId)
      cleanupRun(runId, workspacePath, isEphemeral, worktreeClonePath)

      // Flush any remaining buffered events (broadcast + persist to RDS)
      flushBuffer()

      logStream.end()

      const endedAt = Date.now()
      const durationMs = endedAt - run.startedAt

      try {
        const finalRun = await updateRun(runId, {
          status,
          endedAt,
          durationMs,
          exitCode: exitCode ?? undefined,
          lastLine: lastLine || undefined,
        })
        broadcast('run:statusChange', {
          runId,
          status,
          exitCode: exitCode ?? undefined,
          endedAt,
          durationMs,
        })
        // Ensure all events are durably in RDS before the publisher reads them.
        await rdsChain
        await publishRunResult(agentId, finalRun)
      } catch (err) {
        console.error(`[server/runner] Finalize failed for run ${runId}:`, err)
      }

      // Reclaim disk promptly after every job finishes (see setRunFinalizedHook).
      notifyRunFinalized()
    }

    // Surface a broken push credential into the run log so it's attributable at a
    // glance, rather than only showing up later as an opaque `git push` failure.
    if (pushCredentialError) {
      emitSystemMessage(
        `⚠️  Could not obtain GitHub push credentials for this repository: ${pushCredentialError}\n` +
        `   The agent can read the code, but "git push" (and opening PRs) will fail. ` +
        `Check the repository's authentication settings.`
      )
    }

    // 6. Spawn process based on runner type
    if (agent.runner === 'cursor') {
      // Cursor: open workspace folder, no streaming
      let child: ChildProcess
      try {
        child = spawn('cursor', buildCursorArgs(workspacePath), {
          detached: true,
          stdio: 'ignore',
          env: await buildRunnerEnv(agent, startedBy),
        })
        child.unref()
      } catch (err) {
        // Rethrown to the caller (WS 'runs:start' handler / triggerService), which
        // reports it — capturing here too would double-report.
        cleanupRun(runId, workspacePath, isEphemeral, worktreeClonePath)
        logStream.end()
        await updateRun(runId, { status: 'failed', endedAt: Date.now() })
        broadcast('run:statusChange', { runId, status: 'failed' })
        throw err
      }

      emitSystemMessage(CURSOR_NOTICE)

      // Mark as launched (not completed — it's a GUI app)
      activeProcesses.delete(runId)
      cleanupRun(runId, workspacePath, isEphemeral, worktreeClonePath)
      logStream.end()

      const endedAt = Date.now()
      const durationMs = endedAt - run.startedAt

      const launchedRun = await updateRun(runId, { status: 'launched', endedAt, durationMs })

      broadcast('run:statusChange', { runId, status: 'launched', endedAt, durationMs })

      return launchedRun
    }

    // claude or amp
    let child: ChildProcess
    try {
      const cliArgs =
        agent.runner === 'amp'
          ? buildAmpArgs(mcpConfigPath)
          : buildClaudeArgs(mcpConfigPath, agent.effort, !agent.enableRepoMcps)

      const binary = agent.runner === 'amp' ? 'amp' : 'claude'

      const runnerEnv = await buildRunnerEnv(agent, startedBy)
      if (agent.runner === 'claude') {
        // Pre-trust the workspace so Claude honors the repo's .claude/settings.json
        // instead of warning "this workspace has not been trusted" and dropping its
        // permissions on every headless run. Trust both the workspace and the bare
        // clone (Claude keys trust by the git root for a worktree).
        const trusted = [workspacePath, worktreeClonePath].filter((p): p is string => !!p)
        runnerEnv.CLAUDE_CONFIG_DIR = writeClaudeConfig(runId, trusted)
      }

      child = spawn(binary, cliArgs, {
        cwd: workspacePath,
        env: runnerEnv,
        stdio: ['pipe', 'pipe', 'pipe'],
      })

      // Write prompt to stdin — avoids --mcp-config <configs...> greedily
      // consuming the prompt as an additional config path argument.
      const fullPrompt = triggerContext
        ? buildTriggeredPrompt(agent.prompt, triggerContext)
        : agent.prompt
      if (child.stdin) {
        child.stdin.write(fullPrompt)
        child.stdin.end()
      }
    } catch (err) {
      // Rethrown to the caller (WS 'runs:start' handler / triggerService), which
      // reports it — capturing here too would double-report.
      cleanupRun(runId, workspacePath, isEphemeral, worktreeClonePath)
      logStream.end()
      await updateRun(runId, { status: 'failed', endedAt: Date.now() })
      broadcast('run:statusChange', { runId, status: 'failed' })
      throw err
    }

    activeProcesses.set(runId, { child, finalize: finalizeRun, workspacePath, agentId })

    // Handle spawn errors (binary not in PATH, etc.)
    child.on('error', (err) => {
      console.error(`[server/runner] Spawn error for run ${runId}:`, err)
      reporter.captureException(err, {
        tags: { component: 'runner', runId, runner: agent.runner },
      })
      emitSystemMessage(`\n[Error: ${err.message}]\n`)
      finalizeRun('failed', undefined)
    })

    // Readline on stdout for NDJSON parsing → structured events.
    const parseEvents = agent.runner === 'amp' ? parseAmpEvents : parseClaudeEvents

    if (child.stdout) {
      const rl = createInterface({ input: child.stdout, crlfDelay: Infinity })
      rl.on('line', (line) => {
        for (const ev of parseEvents(line)) emitEvent(ev)
      })
    }

    // Stderr: stream raw
    if (child.stderr) {
      child.stderr.on('data', (data: Buffer) => {
        emitEvent({ kind: 'raw', stream: 'stderr', text: data.toString('utf8') })
      })
    }

    // Process close
    child.on('close', (code) => {
      const status = code === 0 ? 'completed' : 'failed'
      // Surface failed runs to the error reporter — a non-zero exit (or a process
      // killed when the disk filled) was previously only written to the DB and
      // never captured. Skip when already finalized: a spawn 'error' or an
      // explicit stopRun has its own handling and would otherwise double-report.
      if (status === 'failed' && !finalized) {
        const report = buildRunFailureReport({ runId, runner: agent.runner, exitCode: code, lastLine })
        reporter.captureMessage(report.message, report.level, report.ctx)
      }
      finalizeRun(status, code)
    })

    return run
  }
}

/** Construct the executor selected by `CONDUIT_EXECUTOR` (default `inproc`). */
export function getExecutor(): Executor {
  return getExecutorKind() === 'job' ? new JobExecutor() : new InProcessExecutor()
}

/**
 * Start an agent run in server mode.
 *
 * Setup (agent load, guard, workspace/worktree, run row, MCP config) runs via
 * {@link prepareRun}; execution (spawn/stream/finalize, or Job dispatch) runs via
 * the {@link Executor} selected by `CONDUIT_EXECUTOR`. The default in-process path
 * is behaviour-identical to the original single-function implementation.
 */
export async function startRunServer(
  agentId: string,
  broadcast: BroadcastFn,
  triggerContext?: TriggerContext,
  startedBy?: string
): Promise<ExecutionRun> {
  const prepared = await prepareRun(agentId, broadcast, triggerContext, startedBy)
  return getExecutor().execute(prepared, broadcast)
}

/**
 * Stop a running agent process by sending SIGTERM.
 * Uses the finalize closure from the in-process executor to ensure consistent cleanup.
 */
export async function stopRun(runId: string): Promise<void> {
  const activeRun = activeProcesses.get(runId)
  if (!activeRun) {
    console.warn(`[server/runner] stopRun called for unknown runId: ${runId}`)
    return
  }

  // Call the finalize closure first (marks finalized=true, prevents double-run on close event)
  activeRun.finalize('stopped', null)

  // Then kill the process — the close event will fire but finalizeRun will no-op
  try {
    activeRun.child.kill('SIGTERM')
  } catch (err) {
    console.error(`[server/runner] Failed to kill process for run ${runId}:`, err)
  }
}
