import { spawn, ChildProcess } from 'child_process'
import { createInterface } from 'readline'
import type { RunSpec, WorkerEventSink, WorkerFactory, WorkerHandle } from '../../shared/worker'
import { createWorkspace, deleteWorkspace } from '../../main/execution/workspace'
import { writeMcpConfigContent, deleteMcpConfig } from '../../main/utils/mcpConfigFile'
import { writeClaudeConfig, deleteClaudeConfig } from '../../main/utils/claudeConfig'
import { installCursorMcpConfig } from './cursorMcpConfig'
import { installRepoCredentials } from './repoCredentials'
import { startMcpAuthRelay, type McpAuthRelay } from './mcpAuthRelay'
import { createConfiguredWorktree, removeWorktree, runGit, buildAuthUrl, configureWorktreeGit, DEFAULT_GIT_TIMEOUT_MS } from '../gitOps'
import { buildClaudeArgs, parseClaudeEvents } from '../../main/execution/adapters/claude'
import { buildAmpArgs, parseAmpEvents } from '../../main/execution/adapters/amp'
import { buildCursorArgs, parseCursorEvents } from '../../main/execution/adapters/cursor'
import { assertVolumeHasSpace } from '../diskPressure'
import { cliKillDiagnostic } from '../runFailure'
import { WORKSPACES_BASE } from '../../main/utils/paths'

/**
 * In-process worker: executes runs by spawning the agent CLI on this host.
 * This is the default factory (CONDUIT_WORKER_FACTORY=local) and preserves
 * Conduit's original single-process behavior. The same execution logic is
 * reused inside the conduit-worker process for remote/EKS/Fargate runs — the
 * only difference is how the RunSpec arrives and where events go.
 */
export class LocalWorkerFactory implements WorkerFactory {
  readonly kind = 'local'

  // Live child processes keyed by runId (pod-local by design).
  private active = new Map<string, ChildProcess>()

  async startRun(spec: RunSpec, sink: WorkerEventSink): Promise<WorkerHandle> {
    // Refuse to materialize a multi-GB worktree/clone when the backing volume
    // is already critically full — those attempts fail with ENOSPC, leave a
    // blank Failed run in history, and make exhaustion worse.
    const volumeDir =
      spec.workspace.kind === 'worktree'
        ? spec.workspace.clonePath
        : spec.workspace.kind === 'fixedDir'
          ? spec.workspace.path
          : WORKSPACES_BASE
    await assertVolumeHasSpace(volumeDir, 'start this run')

    // 1. Materialize the workspace.
    let workspacePath: string
    let worktreeClonePath: string | undefined
    let ephemeral = false
    const ws = spec.workspace
    if (ws.kind === 'worktree') {
      await createConfiguredWorktree(ws.clonePath, ws.worktreeDir, ws.repo.defaultBranch, {
        url: ws.repo.url,
        token: ws.repo.token,
        authorName: ws.repo.authorName,
        authorEmail: ws.repo.authorEmail,
      })
      workspacePath = ws.worktreeDir
      worktreeClonePath = ws.clonePath
    } else if (ws.kind === 'fixedDir') {
      workspacePath = ws.path
    } else if (ws.kind === 'ephemeral') {
      workspacePath = createWorkspace(spec.runId)
      ephemeral = true
    } else {
      // repo-clone: fresh shallow clone from the remote — how workers with no
      // access to the server's bare clones (remote hosts, EKS/Fargate tasks)
      // materialize the checkout. The clone dir is disposable → ephemeral.
      workspacePath = createWorkspace(spec.runId)
      ephemeral = true
      const url = ws.repo.token ? buildAuthUrl(ws.repo.url, ws.repo.token) : ws.repo.url
      await runGit(
        ['clone', '--depth', '1', '--branch', ws.repo.defaultBranch, url, workspacePath],
        { timeoutMs: DEFAULT_GIT_TIMEOUT_MS }
      )
      await configureWorktreeGit(workspacePath, {
        url: ws.repo.url,
        token: ws.repo.token,
        authorName: ws.repo.authorName,
        authorEmail: ws.repo.authorEmail,
      })
    }

    let relay: McpAuthRelay | undefined
    try {
      if (spec.mcpConfigContent && spec.mcpOAuthServerKeys?.length) {
        relay = await startMcpAuthRelay(spec.mcpConfigContent, spec.mcpOAuthServerKeys)
      }
      return await this.spawn(spec, sink, workspacePath, worktreeClonePath, ephemeral, relay)
    } catch (err) {
      // Roll back everything this factory created so a failed start never
      // orphans a multi-GB worktree or token-carrying config file.
      void relay?.close()
      deleteMcpConfig(spec.runId)
      deleteClaudeConfig(spec.runId)
      try {
        if (worktreeClonePath) await removeWorktree(worktreeClonePath, workspacePath)
        else if (ephemeral) deleteWorkspace(workspacePath)
      } catch (cleanupErr) {
        console.error(`[workers/local] Prep rollback failed for run ${spec.runId}:`, cleanupErr)
      }
      throw err
    }
  }

  private async spawn(
    spec: RunSpec,
    sink: WorkerEventSink,
    workspacePath: string,
    worktreeClonePath: string | undefined,
    ephemeral: boolean,
    relay: McpAuthRelay | undefined
  ): Promise<WorkerHandle> {
    // 2. Write the MCP config. Claude/Amp read it by path (--mcp-config);
    // cursor-agent has no such flag, so it is merged into the workspace's
    // .cursor/mcp.json instead and restored when the process exits.
    const mcpConfigContent = relay?.content ?? spec.mcpConfigContent
    let mcpConfigPath: string | undefined
    let restoreCursorMcp: (() => Promise<void>) | undefined
    if (spec.runner === 'cursor') {
      // Absent only in a RunSpec from a pre-injection server.
      if (mcpConfigContent) {
        restoreCursorMcp = await installCursorMcpConfig(workspacePath, mcpConfigContent)
      }
    } else {
      if (!mcpConfigContent) {
        throw new Error(`RunSpec for run ${spec.runId} is missing mcpConfigContent`)
      }
      mcpConfigPath = writeMcpConfigContent(spec.runId, mcpConfigContent)
    }
    const restoreWorkspaceMcp = async (): Promise<void> => {
      try {
        await restoreCursorMcp?.()
      } catch (err) {
        console.error(`[workers/local] Failed to restore .cursor/mcp.json for run ${spec.runId}:`, err)
      }
      await relay?.close()
    }

    // 3. Environment: the worker's own env overlaid with the orchestrator-
    // resolved entries (API key, GH_TOKEN, timeouts, agent envVars).
    const env: NodeJS.ProcessEnv = { ...process.env, ...spec.env }
    if (spec.runner === 'claude') {
      // Pre-trust the workspace so Claude honors the repo's .claude/settings.json
      // instead of warning "this workspace has not been trusted" and dropping its
      // permissions on every headless run. Trust both the workspace and the bare
      // clone (Claude keys trust by the git root for a worktree).
      const trusted = [workspacePath, worktreeClonePath].filter((p): p is string => !!p)
      env.CLAUDE_CONFIG_DIR = writeClaudeConfig(spec.runId, trusted)
    }
    const ws = spec.workspace
    const repo = ws.kind === 'worktree' || ws.kind === 'repo-clone' ? ws.repo : undefined
    const repoCredentials = repo
      ? installRepoCredentials({ runId: spec.runId, workspacePath, repo, env })
      : undefined
    Object.assign(env, repoCredentials?.env)
    const disposeRepoCredentials = (): void => {
      try {
        repoCredentials?.dispose()
      } catch (err) {
        console.error(`[workers/local] Failed to remove credentials for run ${spec.runId}:`, err)
      }
    }

    // 4. Spawn the runner CLI. Cursor runs cursor-agent in "Run Everything"
    // mode (--force / --yolo) — see buildCursorArgs — so the agent executes
    // commands and edits without approval.
    const cliArgs =
      spec.runner === 'amp'
        ? buildAmpArgs(mcpConfigPath!)
        : spec.runner === 'cursor'
          ? buildCursorArgs({ model: spec.model, effort: spec.effort })
          : buildClaudeArgs(mcpConfigPath!, spec.effort, spec.strictMcpConfig)

    const binary = spec.runner === 'amp' ? 'amp' : spec.runner === 'cursor' ? 'cursor-agent' : 'claude'

    let child: ChildProcess
    try {
      child = spawn(binary, cliArgs, {
        cwd: workspacePath,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch (err) {
      await restoreWorkspaceMcp()
      disposeRepoCredentials()
      throw err
    }

    // Write prompt to stdin — avoids --mcp-config <configs...> greedily
    // consuming the prompt as an additional config path argument.
    if (child.stdin) {
      child.stdin.write(spec.prompt)
      child.stdin.end()
    }

    this.active.set(spec.runId, child)

    const handle: WorkerHandle = {
      runId: spec.runId,
      workspacePath,
      worktreeClonePath,
      ephemeral,
      cancel: async () => {
        try {
          child.kill('SIGTERM')
        } catch (err) {
          console.error(`[workers/local] Failed to kill process for run ${spec.runId}:`, err)
        }
      },
      updateRepoToken: repoCredentials ? (token) => repoCredentials.update(token) : undefined,
      updateMcpAuth: relay ? async (auth) => relay.update(auth) : undefined,
    }

    // Spawn errors (binary not in PATH, etc.) — the orchestrator owns
    // reporting/finalization via onError; 'close' may still fire afterwards.
    child.on('error', (err) => {
      this.active.delete(spec.runId)
      void restoreWorkspaceMcp()
      disposeRepoCredentials()
      sink.onError?.(err)
    })

    // Readline on stdout for NDJSON parsing → structured events.
    const parseEvents =
      spec.runner === 'amp' ? parseAmpEvents : spec.runner === 'cursor' ? parseCursorEvents : parseClaudeEvents

    if (child.stdout) {
      const rl = createInterface({ input: child.stdout, crlfDelay: Infinity })
      rl.on('line', (line) => {
        for (const ev of parseEvents(line)) sink.onEvent(ev)
      })
    }

    if (child.stderr) {
      child.stderr.on('data', (data: Buffer) => {
        sink.onEvent({ kind: 'raw', stream: 'stderr', text: data.toString('utf8') })
      })
    }

    child.on('close', async (code, signal) => {
      this.active.delete(spec.runId)
      await restoreWorkspaceMcp()
      disposeRepoCredentials()
      const diagnostic = cliKillDiagnostic(code, signal)
      if (diagnostic) sink.onEvent({ kind: 'raw', stream: 'system', text: diagnostic })
      sink.onExit(code === 0 ? 'completed' : 'failed', code)
    })

    return handle
  }

  async shutdown(): Promise<void> {
    for (const [runId, child] of this.active) {
      try {
        child.kill('SIGTERM')
      } catch (err) {
        console.error(`[workers/local] Shutdown kill failed for run ${runId}:`, err)
      }
    }
    this.active.clear()
  }
}
