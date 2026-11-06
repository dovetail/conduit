/**
 * Worker execution seam — types only, no runtime imports (mirrors
 * shared/observability.ts). This is the boundary between run *orchestration*
 * (server-owned: DB records, log persistence, browser broadcasts, publishing)
 * and run *execution* (worker-owned: workspace, process spawn, event stream).
 *
 * A RunSpec is a fully self-contained, serializable job description: everything
 * a worker needs to execute a run, whether that worker is in-process
 * (LocalWorkerFactory), a separate conduit-worker process over the WSS control
 * plane, or an ephemeral EKS/Fargate task. Secrets (API keys, git tokens, MCP
 * OAuth bearer headers) are resolved server-side and carried here; workers are
 * trusted execution environments and receive specs only over authenticated,
 * encrypted channels.
 */
import type { RunnerType, RunEventInit } from './types'

/** Git coordinates + credentials needed to materialize a run's checkout. */
export interface RunSpecRepo {
  url: string
  defaultBranch: string
  /** Short-lived push/read token (PAT or GitHub App installation token). */
  token?: string
  authorName: string
  authorEmail: string
}

/**
 * How the worker materializes the run's working directory:
 * - `worktree`   — git worktree off a local bare clone (local worker with
 *                  access to the server's REPOS_DIR volume)
 * - `repo-clone` — fresh clone from the remote URL (remote workers with no
 *                  shared filesystem)
 * - `fixedDir`   — operator-pinned directory, never deleted (local only)
 * - `ephemeral`  — empty temp dir, deleted after the run
 */
export type WorkspaceSpec =
  | { kind: 'worktree'; clonePath: string; worktreeDir: string; repo: RunSpecRepo }
  | { kind: 'repo-clone'; repo: RunSpecRepo }
  | { kind: 'fixedDir'; path: string }
  | { kind: 'ephemeral' }

export interface RunSpec {
  runId: string
  agentId: string
  runner: RunnerType
  model?: string
  effort?: string
  /** Final prompt (trigger context already folded in). Written to the CLI's stdin. */
  prompt: string
  /**
   * Env overlay applied on top of the worker's own process env — agent
   * envVars, the runner API key, GH_TOKEN, timeout vars. Resolved server-side
   * (DB credentials, GitHub App mint) so workers never touch the secrets store.
   */
  env: Record<string, string>
  /**
   * Serialized McpServersConfig with global servers merged, OAuth tokens
   * injected, and env vars expanded. claude/amp read it via --mcp-config;
   * cursor gets it merged into the workspace's .cursor/mcp.json. Optional only
   * so a newer worker accepts a cursor RunSpec from an older server.
   */
  mcpConfigContent?: string
  /**
   * Keys of URL servers in mcpConfigContent whose Authorization header is a
   * Conduit-managed OAuth bearer. The worker fronts them with a loopback relay
   * so `updateMcpAuth` can swap in renewed tokens mid-run; workers that predate
   * this field keep the launch-time bearer.
   */
  mcpOAuthServerKeys?: string[]
  /** claude only: --strict-mcp-config (ignore repo/host MCP configs). */
  strictMcpConfig?: boolean
  /**
   * Fargate task memory in MiB. Unset uses the factory default (8192 at 2 vCPU).
   * The Fargate factory rejects values outside 4096–16384 (steps of 1024).
   */
  workerMemoryMib?: number
  workspace: WorkspaceSpec
}

export type WorkerExitStatus = 'completed' | 'failed' | 'stopped'

/** Callbacks the worker uses to stream a run back to the orchestrator. */
export interface WorkerEventSink {
  /** One structured event (unstamped — the orchestrator stamps `t`). */
  onEvent(event: RunEventInit): void
  /**
   * Event already durably persisted (control-plane delivery log). Implementations
   * must update live summary/broadcast without writing a second log copy.
   */
  onDurableEvent?(event: RunEventInit): void
  /** Terminal state. May return a promise; the control plane awaits it before ACK. */
  onExit(status: WorkerExitStatus, exitCode: number | null | undefined): void | Promise<void>
  /** Process-level failure (e.g. binary not on PATH). */
  onError?(err: Error): void
}

export interface WorkerHandle {
  readonly runId: string
  /** Resolved working directory (worker-local path for remote workers). */
  readonly workspacePath?: string
  /** Set for worktree workspaces — the bare clone the worktree belongs to. */
  readonly worktreeClonePath?: string
  /** True for ephemeral workspaces (safe to delete outright after the run). */
  readonly ephemeral: boolean
  /** Control-plane identity of the executing worker (remote factories only). */
  readonly workerId?: string
  /** Request termination (SIGTERM semantics locally; cancel/kill remotely). */
  cancel(): Promise<void>
  /**
   * Swap in a freshly minted repo token (GitHub App installation tokens expire
   * after about an hour). Absent when the run has no tokenized checkout.
   */
  updateRepoToken?(token: string): Promise<void>
  /**
   * Swap in renewed Authorization values for the run's OAuth MCP servers,
   * keyed by server key. Absent when the run has no relayed MCP servers.
   */
  updateMcpAuth?(auth: Record<string, string>): Promise<void>
}

/**
 * Owns the lifecycle of agent execution regardless of where it runs.
 * Implementations: LocalWorkerFactory (in-process spawn), RemoteWorkerFactory
 * (WSS control plane), EksWorkerFactory, FargateWorkerFactory.
 */
export interface WorkerFactory {
  readonly kind: string
  /** Prepare the workspace, start execution, and return once the run is live.
   *  Throws if preparation fails (the orchestrator marks the run failed). */
  startRun(spec: RunSpec, sink: WorkerEventSink): Promise<WorkerHandle>
  /** Best-effort teardown of all active runs (server shutdown). */
  shutdown(): Promise<void>
}
