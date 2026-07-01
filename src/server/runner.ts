import { spawn, ChildProcess } from 'child_process'
import { createInterface } from 'readline'
import * as fs from 'fs'
import * as path from 'path'
import type { ExecutionRun, LogEntry, TriggerContext } from '../shared/types'
import { createRun, updateRun } from '../main/db/queries/runs'
import { getAgent } from '../main/db/queries/agents'
import { getRepository } from '../main/db/queries/repositories'
import { createWorkspace, deleteWorkspace } from '../main/execution/workspace'
import { writeMcpConfig, deleteMcpConfig } from '../main/utils/mcp'
import { DEV_USER_ID } from './auth/config'
import { LOGS_DIR } from '../main/utils/paths'
import { createWorktree, removeWorktree, configureWorktreeGit } from './gitOps'
import { resolveRepoToken } from './githubApp'
import { buildClaudeArgs, parseClaudeOutput } from '../main/execution/adapters/claude'
import { buildAmpArgs, parseAmpOutput } from '../main/execution/adapters/amp'
import { buildCursorArgs, CURSOR_NOTICE } from '../main/execution/adapters/cursor'
import { publishRunResult } from './publisher'
import { buildTriggeredPrompt } from './triggers/promptBuilder'

/** Function signature for broadcasting events to all connected WebSocket clients */
export type BroadcastFn = (channel: string, payload: unknown) => void

interface ActiveRun {
  child: ChildProcess
  finalize: (status: 'completed' | 'failed' | 'stopped', exitCode?: number | null) => void
}

// Active child processes keyed by runId
const activeProcesses = new Map<string, ActiveRun>()

/** Delay before removing a run's workspace, so executables it spawned can exit
 *  and release file handles before we delete the directory. */
const WORKSPACE_CLEANUP_DELAY_MS = 30_000

/** Append a system log entry to a run's log file (used after the log stream is
 *  closed, e.g. by the delayed cleanup). Also emits to stdout for log forwarding. */
function appendRunLog(runId: string, chunk: string): void {
  const entry: LogEntry = { t: Date.now(), stream: 'system', chunk }
  try {
    fs.appendFileSync(path.join(LOGS_DIR, `${runId}.jsonl`), JSON.stringify(entry) + '\n')
  } catch (err) {
    console.error(`[runner] Failed to append cleanup log for run ${runId}: ${err}`)
  }
  process.stdout.write(JSON.stringify({ runId, ...entry }) + '\n')
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
 * Start an agent run in server mode.
 *
 * Identical logic to src/main/execution/runner.ts startRun(), but uses the
 * provided `broadcast` function to push events to WebSocket clients instead
 * of mainWindow.webContents.send().
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

  // 2. Determine workspace: repo worktree > fixed workingDir > ephemeral
  let workspacePath: string
  let isEphemeral: boolean
  let worktreeClonePath: string | undefined

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
    await createWorktree(repo.clonePath!, worktreeDir, repo.defaultBranch)
    // Configure committer identity + push credentials so the agent can commit and
    // push (and open PRs). Uses the repo's "commit as" settings, falling back to a
    // Conduit identity, and a freshly-resolved token so origin authenticates.
    const pushToken = await resolveRepoToken(repo).catch(() => undefined)
    await configureWorktreeGit(worktreeDir, {
      url: repo.url,
      token: pushToken,
      authorName: repo.commitAuthorName?.trim() || 'Conduit',
      authorEmail: repo.commitAuthorEmail?.trim() || 'conduit@dovetail.com',
    })
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

  // 4. Create run record (log path updated after we have the runId)
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
  })

  const runId = runRecord.id
  const realLogPath = path.join(LOGS_DIR, `${runId}.jsonl`)

  // Update run record with the real log path
  const run = await updateRun(runId, { logPath: realLogPath })

  // 3b. Write MCP config now that we have the runId
  const actingUserId = startedBy ?? agent.ownerId ?? DEV_USER_ID
  const mcpConfigPath = await writeMcpConfig(runId, agent.mcpConfig, actingUserId)

  // 5. Open log file write stream
  const logStream = fs.createWriteStream(realLogPath, { flags: 'a', encoding: 'utf8' })

  function writeLogEntry(entry: LogEntry): void {
    const line = JSON.stringify(entry)
    // Write to per-run log file (for UI replay via runs:getLog).
    logStream.write(line + '\n')
    // Also emit to stdout so the platform log forwarder (Datadog, etc.) ingests.
    process.stdout.write(JSON.stringify({ runId, agentId, ...entry }) + '\n')
  }

  function emitSystemMessage(chunk: string): void {
    const entry: LogEntry = { t: Date.now(), stream: 'system', chunk }
    writeLogEntry(entry)
    broadcast('run:output', { runId, stream: 'system', chunks: [chunk] })
  }

  // Track the last non-empty output line (ANSI-stripped) for a run-list excerpt.
  let lastLine = ''
  function updateLastLine(chunk: string): void {
    const cleaned = chunk.replace(/\x1b\[[0-9;]*m/g, '')
    const lines = cleaned.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
    if (lines.length > 0) lastLine = lines[lines.length - 1].slice(0, 500)
  }

  // Buffer + flush helpers (batch rapid output into single WebSocket messages)
  const stdoutBuffer: string[] = []
  const stderrBuffer: string[] = []
  let flushScheduled = false

  function scheduleFlush(): void {
    if (flushScheduled) return
    flushScheduled = true
    setImmediate(() => {
      flushScheduled = false
      if (stdoutBuffer.length > 0) {
        const chunks = stdoutBuffer.splice(0)
        broadcast('run:output', { runId, stream: 'stdout', chunks })
      }
      if (stderrBuffer.length > 0) {
        const chunks = stderrBuffer.splice(0)
        broadcast('run:output', { runId, stream: 'stderr', chunks })
      }
    })
  }

  function handleStdoutChunk(chunk: string): void {
    const entry: LogEntry = { t: Date.now(), stream: 'stdout', chunk }
    writeLogEntry(entry)
    updateLastLine(chunk)
    stdoutBuffer.push(chunk)
    scheduleFlush()
  }

  function handleStderrChunk(chunk: string): void {
    const entry: LogEntry = { t: Date.now(), stream: 'stderr', chunk }
    writeLogEntry(entry)
    updateLastLine(chunk)
    stderrBuffer.push(chunk)
    scheduleFlush()
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

    // Flush any remaining buffered output
    if (stdoutBuffer.length > 0) {
      const chunks = stdoutBuffer.splice(0)
      broadcast('run:output', { runId, stream: 'stdout', chunks })
    }
    if (stderrBuffer.length > 0) {
      const chunks = stderrBuffer.splice(0)
      broadcast('run:output', { runId, stream: 'stderr', chunks })
    }

    logStream.end()

    const endedAt = Date.now()
    const durationMs = endedAt - run.startedAt

    const finalRun = await updateRun(runId, {
      status,
      endedAt,
      durationMs,
      exitCode: exitCode ?? undefined,
      lastLine: lastLine || undefined,
    })
      .then((finalRun) => {
        broadcast('run:statusChange', {
          runId,
          status,
          exitCode: exitCode ?? undefined,
          endedAt,
          durationMs,
        })
        return publishRunResult(agentId, finalRun)
      })
      .catch((err) => console.error(`[server/runner] Finalize failed for run ${runId}:`, err))
  }

  // 6. Spawn process based on runner type
  if (agent.runner === 'cursor') {
    // Cursor: open workspace folder, no streaming
    let child: ChildProcess
    try {
      child = spawn('cursor', buildCursorArgs(workspacePath), {
        detached: true,
        stdio: 'ignore',
      })
      child.unref()
    } catch (err) {
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

    child = spawn(binary, cliArgs, {
      cwd: workspacePath,
      env: { ...process.env, ...agent.envVars },
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
    cleanupRun(runId, workspacePath, isEphemeral, worktreeClonePath)
    logStream.end()
    await updateRun(runId, { status: 'failed', endedAt: Date.now() })
    broadcast('run:statusChange', { runId, status: 'failed' })
    throw err
  }

  activeProcesses.set(runId, { child, finalize: finalizeRun })

  // Handle spawn errors (binary not in PATH, etc.)
  child.on('error', (err) => {
    console.error(`[server/runner] Spawn error for run ${runId}:`, err)
    emitSystemMessage(`\n[Error: ${err.message}]\n`)
    finalizeRun('failed', undefined)
  })

  // Readline on stdout for NDJSON parsing
  const parseOutput = agent.runner === 'amp' ? parseAmpOutput : parseClaudeOutput

  if (child.stdout) {
    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity })
    rl.on('line', (line) => {
      const parsed = parseOutput(line)
      if (parsed !== null) {
        // readline strips the newline — add \r\n so xterm renders on separate lines
        handleStdoutChunk(parsed + '\r\n')
      }
    })
  }

  // Stderr: stream raw
  if (child.stderr) {
    child.stderr.on('data', (data: Buffer) => {
      handleStderrChunk(data.toString('utf8'))
    })
  }

  // Process close
  child.on('close', (code) => {
    const status = code === 0 ? 'completed' : 'failed'
    finalizeRun(status, code)
  })

  return run
}

/**
 * Stop a running agent process by sending SIGTERM.
 * Uses the finalize closure from startRunServer to ensure consistent cleanup.
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
