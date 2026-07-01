import { spawn, ChildProcess } from 'child_process'
import { createInterface } from 'readline'
import * as fs from 'fs'
import * as path from 'path'
import { BrowserWindow } from 'electron'
import { ExecutionRun, LogEntry } from '../../shared/types'
import { createRun, updateRun } from '../db/queries/runs'
import { getAgent } from '../db/queries/agents'
import { createWorkspace, deleteWorkspace } from './workspace'
import { writeMcpConfig, deleteMcpConfig } from '../utils/mcp'
import { DEV_USER_ID } from '../../server/auth/config'
import { LOGS_DIR } from '../utils/paths'
import { buildClaudeArgs, parseClaudeOutput } from './adapters/claude'
import { buildAmpArgs, parseAmpOutput } from './adapters/amp'
import { buildCursorArgs, CURSOR_NOTICE } from './adapters/cursor'

interface ActiveRun {
  child: ChildProcess
  finalize: (status: 'completed' | 'failed' | 'stopped', exitCode?: number | null) => void
}

// Active child processes keyed by runId
const activeProcesses = new Map<string, ActiveRun>()

/**
 * Cleanup helper: remove workspace + MCP config file for a run.
 */
function cleanupRun(runId: string, workspacePath: string | undefined): void {
  deleteMcpConfig(runId)
  if (workspacePath) {
    deleteWorkspace(workspacePath)
  }
}

/**
 * Start an agent run.
 *
 * 1. Load agent config from DB
 * 2. Create ephemeral workspace dir
 * 3. Write MCP config JSON file
 * 4. Create run record (status: running)
 * 5. Open JSONL log file write stream
 * 6. Spawn the process
 * 7. Stream output to renderer via IPC + write to log file
 * 8. On close: cleanup, update DB, emit status change
 */
export async function startRun(
  agentId: string,
  mainWindow: BrowserWindow
): Promise<ExecutionRun> {
  // 1. Load agent
  const agent = getAgent(agentId)
  if (!agent) throw new Error(`Agent ${agentId} not found`)

  // 2. Create workspace
  const workspacePath = createWorkspace(agentId)

  // 3. Write MCP config — use a placeholder ID first, we'll update after createRun
  //    We need the runId before writing so we generate it via createRun.
  //    Write MCP config after createRun with the real runId.

  // 4. Create run record (log path is updated immediately after we have the runId)
  const runRecord = createRun({
    agentId,
    status: 'running',
    startedAt: Date.now(),
    workspacePath,
    logPath: path.join(LOGS_DIR, `__pending__.jsonl`), // placeholder
    exitCode: undefined,
    endedAt: undefined,
    durationMs: undefined,
  })

  const runId = runRecord.id
  const realLogPath = path.join(LOGS_DIR, `${runId}.jsonl`)

  // Update run record with the real log path
  const run = updateRun(runId, { logPath: realLogPath })

  // 3b. Write MCP config now that we have the runId (merge global MCPs with agent MCPs)
  const mcpConfigPath = await writeMcpConfig(runId, agent.mcpConfig, DEV_USER_ID)

  // 5. Open log file write stream
  const logStream = fs.createWriteStream(realLogPath, { flags: 'a', encoding: 'utf8' })

  function writeLogEntry(entry: LogEntry): void {
    logStream.write(JSON.stringify(entry) + '\n')
  }

  function emitSystemMessage(chunk: string): void {
    const entry: LogEntry = { t: Date.now(), stream: 'system', chunk }
    writeLogEntry(entry)
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('run:output', {
        runId,
        stream: 'system',
        chunks: [chunk],
      })
    }
  }

  // Buffer + flush helpers
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
        if (!mainWindow.isDestroyed()) {
          mainWindow.webContents.send('run:output', { runId, stream: 'stdout', chunks })
        }
      }
      if (stderrBuffer.length > 0) {
        const chunks = stderrBuffer.splice(0)
        if (!mainWindow.isDestroyed()) {
          mainWindow.webContents.send('run:output', { runId, stream: 'stderr', chunks })
        }
      }
    })
  }

  function handleStdoutChunk(chunk: string): void {
    const entry: LogEntry = { t: Date.now(), stream: 'stdout', chunk }
    writeLogEntry(entry)
    stdoutBuffer.push(chunk)
    scheduleFlush()
  }

  function handleStderrChunk(chunk: string): void {
    const entry: LogEntry = { t: Date.now(), stream: 'stderr', chunk }
    writeLogEntry(entry)
    stderrBuffer.push(chunk)
    scheduleFlush()
  }

  // Guard against double-finalization (e.g. stopRun + close event)
  let finalized = false

  // Finish / cleanup
  function finalizeRun(
    status: 'completed' | 'failed' | 'stopped',
    exitCode: number | null | undefined
  ): void {
    if (finalized) return
    finalized = true
    activeProcesses.delete(runId)
    cleanupRun(runId, workspacePath)

    // Flush any remaining buffered output
    if (stdoutBuffer.length > 0) {
      const chunks = stdoutBuffer.splice(0)
      if (!mainWindow.isDestroyed()) {
        mainWindow.webContents.send('run:output', { runId, stream: 'stdout', chunks })
      }
    }
    if (stderrBuffer.length > 0) {
      const chunks = stderrBuffer.splice(0)
      if (!mainWindow.isDestroyed()) {
        mainWindow.webContents.send('run:output', { runId, stream: 'stderr', chunks })
      }
    }

    logStream.end()

    const endedAt = Date.now()
    const durationMs = endedAt - run.startedAt

    updateRun(runId, {
      status,
      endedAt,
      durationMs,
      exitCode: exitCode ?? undefined,
    })

    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('run:statusChange', {
        runId,
        status,
        exitCode: exitCode ?? undefined,
        endedAt,
        durationMs,
      })
    }
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
      cleanupRun(runId, workspacePath)
      logStream.end()
      updateRun(runId, { status: 'failed', endedAt: Date.now() })
      if (!mainWindow.isDestroyed()) {
        mainWindow.webContents.send('run:statusChange', { runId, status: 'failed' })
      }
      throw err
    }

    emitSystemMessage(CURSOR_NOTICE)

    // Mark as launched (not completed — it's a GUI app)
    activeProcesses.delete(runId)
    cleanupRun(runId, workspacePath)
    logStream.end()

    const endedAt = Date.now()
    const durationMs = endedAt - run.startedAt

    const launchedRun = updateRun(runId, { status: 'launched', endedAt, durationMs })

    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('run:statusChange', {
        runId,
        status: 'launched',
        endedAt,
        durationMs,
      })
    }

    return launchedRun
  }

  // claude or amp
  let child: ChildProcess
  try {
    const cliArgs =
      agent.runner === 'amp'
        ? buildAmpArgs(agent.prompt, mcpConfigPath)
        : buildClaudeArgs(agent.prompt, mcpConfigPath)

    const binary = agent.runner === 'amp' ? 'amp' : 'claude'

    child = spawn(binary, cliArgs, {
      cwd: workspacePath,
      env: { ...process.env, ...agent.envVars },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (err) {
    cleanupRun(runId, workspacePath)
    logStream.end()
    updateRun(runId, { status: 'failed', endedAt: Date.now() })
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('run:statusChange', { runId, status: 'failed' })
    }
    throw err
  }

  activeProcesses.set(runId, { child, finalize: finalizeRun })

  // 7. Handle spawn errors (binary not in PATH etc.)
  child.on('error', (err) => {
    console.error(`[runner] Spawn error for run ${runId}:`, err)
    emitSystemMessage(`\n[Error: ${err.message}]\n`)
    finalizeRun('failed', undefined)
  })

  // 7. Readline on stdout for NDJSON parsing
  const parseOutput = agent.runner === 'amp' ? parseAmpOutput : parseClaudeOutput

  if (child.stdout) {
    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity })
    rl.on('line', (line) => {
      const parsed = parseOutput(line)
      if (parsed !== null) {
        handleStdoutChunk(parsed)
      }
    })
  }

  // Stderr: stream raw
  if (child.stderr) {
    child.stderr.on('data', (data: Buffer) => {
      handleStderrChunk(data.toString('utf8'))
    })
  }

  // 10. Process close
  child.on('close', (code) => {
    const status = code === 0 ? 'completed' : 'failed'
    finalizeRun(status, code)
  })

  return run
}

/**
 * Stop a running agent process by sending SIGTERM.
 * Uses the finalize closure from startRun to ensure consistent cleanup.
 */
export async function stopRun(runId: string): Promise<void> {
  const activeRun = activeProcesses.get(runId)
  if (!activeRun) {
    // Run may have already finished; log a warning but don't error
    console.warn(`[runner] stopRun called for unknown runId: ${runId}`)
    return
  }

  // Call the finalize closure first (marks finalized=true, prevents double-run on close event)
  activeRun.finalize('stopped', null)

  // Then kill the process — the close event will fire but finalizeRun will no-op
  try {
    activeRun.child.kill('SIGTERM')
  } catch (err) {
    console.error(`[runner] Failed to kill process for run ${runId}:`, err)
  }
}
