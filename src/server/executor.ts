import type { AgentConfig, ExecutionRun, RunExecutor, TriggerContext } from '../shared/types'

/**
 * The execution seam (P3 change A).
 *
 * A run has two phases: **setup** (load the agent, resolve the workspace/worktree,
 * write the MCP config, insert the `runs` row) and **execute** (spawn the CLI,
 * stream its events, finalize the run). `prepareRun` in runner.ts owns setup and
 * produces a {@link PreparedRun}; an {@link Executor} owns execute. Two executors
 * implement the same contract:
 *   - `InProcessExecutor` — spawns the agent CLI as a child of the control-plane
 *     pod (the original behaviour), and
 *   - `JobExecutor` — dispatches the run to an ephemeral Kubernetes Job.
 *
 * Which one runs is chosen by {@link getExecutorKind} from `CONDUIT_EXECUTOR`,
 * defaulting to `inproc`, so the Job path can ship dark and be flipped per
 * environment without touching call sites.
 */

/** Broadcast an event to all connected WebSocket clients. */
export type BroadcastFn = (channel: string, payload: unknown) => void

/**
 * Everything the execute phase needs, produced by the setup phase. All the
 * work that must happen before a run streams — and that is identical regardless
 * of where the run executes — lives here.
 */
export interface PreparedRun {
  agent: AgentConfig
  /** The persisted `runs` row (status 'running'). */
  run: ExecutionRun
  runId: string
  /** Resolved working directory: a git worktree, a fixed dir, or an ephemeral tmp dir. */
  workspacePath: string
  /** True when the workspace is an ephemeral tmp dir to be deleted after the run. */
  isEphemeral: boolean
  /** The bare clone a worktree was cut from — present only for repo-backed runs. */
  worktreeClonePath?: string
  /** Path to the per-run MCP config file written during setup. */
  mcpConfigPath: string
  /** Set when push-credential resolution failed; surfaced into the run log. */
  pushCredentialError?: string
  triggerContext?: TriggerContext
  startedBy?: string
}

/** A strategy for executing a prepared run. */
export interface Executor {
  readonly kind: RunExecutor
  /**
   * Execute a prepared run: stream its events and finalize it. Returns the run
   * record to hand back to the caller (updated to `launched` for the GUI Cursor
   * runner; otherwise the initial `running` record while streaming continues in
   * the background).
   */
  execute(prepared: PreparedRun, broadcast: BroadcastFn): Promise<ExecutionRun>
}

/** Resolve the configured executor kind. Defaults to `inproc`. */
export function getExecutorKind(): RunExecutor {
  return process.env.CONDUIT_EXECUTOR === 'job' ? 'job' : 'inproc'
}

/**
 * Out-of-process executor: dispatches the run to a Kubernetes Job (one pod per
 * run) for per-run memory isolation. The dispatch/supervision implementation
 * (K8s Job spec, watch/reconcile, the `conduit-run` entrypoint, RO-cache storage)
 * is a follow-on (P3 changes B/C/F); until then this stub fails fast so a
 * mis-set `CONDUIT_EXECUTOR=job` is obvious rather than silently dropping runs.
 */
export class JobExecutor implements Executor {
  readonly kind = 'job' as const

  execute(_prepared: PreparedRun, _broadcast: BroadcastFn): Promise<ExecutionRun> {
    return Promise.reject(
      new Error(
        'CONDUIT_EXECUTOR=job is not yet implemented on this build. ' +
          'Unset CONDUIT_EXECUTOR (or set it to "inproc") to run in-process.'
      )
    )
  }
}
