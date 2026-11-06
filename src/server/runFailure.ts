import { isDiskFullError } from './gitOps'
import type { CaptureContext, SeverityLevel } from '../shared/observability'
import type { RunnerType } from '../shared/types'

/** A run-failure captured for the error reporter. */
export interface RunFailureReport {
  message: string
  level: SeverityLevel
  ctx: CaptureContext
}

export type RunFailureKind =
  | 'authentication'
  | 'disk_full'
  | 'process_signal'
  | 'worker_control'
  | 'launch_config'
  | 'agent_error'

const API_KEY_FAILURE_RE = /invalid api key|the provided api key is invalid/i
/** Line-anchored CLI auth rejection — not mid-sentence upstream 401s. */
const CLI_AUTH_LINE_RE =
  /^(?:(?:claude|amp|cursor)\s*:\s*)?(?:unauthorized|authentication failed)\b/i
/** Missing/absent credential diagnostics from the agent CLIs. */
const MISSING_API_KEY_RE =
  /\b(?:(?:CURSOR|ANTHROPIC|AMP)_API_KEY|API[_ ]?KEY)\b.{0,40}\b(?:is\s+)?(?:not\s+set|missing|absent|unset)\b|\bno\s+api[_ ]?key\b|\bapi[_ ]?key\s+not\s+set\b/i
const CLI_LOGIN_RE = /\b(?:not logged in|login required)\b/i

/** Immediate runner startup rejection (bad model id, removed flag) — not an agent crash. */
const LAUNCH_CONFIG_RE = /\bcannot use this model\b|\bunknown option\b/i

const WORKER_CONTROL_PREFIX = '[Conduit: worker '

const REDACTED = '[redacted]'

/** True when the last line is a Conduit-generated worker-control failure. */
export function isDerivedWorkerControlFailure(lastLine: string | undefined): boolean {
  return (lastLine ?? '').trim().startsWith(WORKER_CONTROL_PREFIX)
}

/** Last non-empty line of CLI output (auth / launch diagnostics are usually here). */
function trailingDiagnosticLine(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
  return lines.length > 0 ? lines[lines.length - 1]! : text.trim()
}

function isAuthenticationFailure(lastLine: string): boolean {
  const line = trailingDiagnosticLine(lastLine)
  return (
    API_KEY_FAILURE_RE.test(line) ||
    CLI_AUTH_LINE_RE.test(line) ||
    MISSING_API_KEY_RE.test(line) ||
    CLI_LOGIN_RE.test(line)
  )
}

function isLaunchConfigFailure(lastLine: string): boolean {
  return LAUNCH_CONFIG_RE.test(trailingDiagnosticLine(lastLine))
}

/**
 * Strip secret-like material from a diagnostic line before attaching it to a
 * reporter payload. Sentry's server-side scrubber otherwise replaces the whole
 * line with `[Filtered]`, which leaves operators with no signal.
 */
export function redactFailureLastLine(line: string): string {
  let s = line
  // Assignment-style: api_key=… / token: … / secret=… / password …
  s = s.replace(
    /\b((?:api[_\s-]?key|token|secret|password)\s*[=:]\s*)(\S+)/gi,
    `$1${REDACTED}`
  )
  // Bearer tokens
  s = s.replace(/\bBearer\s+\S+/gi, `Bearer ${REDACTED}`)
  // sk-… API key shapes (and similar opaque secrets)
  s = s.replace(/\bsk-[A-Za-z0-9_-]+\b/g, REDACTED)
  // Long hex blobs (installation tokens, digests, etc.)
  s = s.replace(/\b[0-9a-fA-F]{32,}\b/g, REDACTED)
  // Other token-shaped base64url blobs (24+ chars of alnum/_/-)
  s = s.replace(/\b[A-Za-z0-9_-]{40,}\b/g, REDACTED)
  return s
}

/** Stable operational cause for a failed agent run. */
export function classifyRunFailure(
  lastLine: string | undefined,
  exitCode: number | null | undefined
): RunFailureKind {
  const text = lastLine ?? ''
  if (isDerivedWorkerControlFailure(text)) return 'worker_control'
  if (isAuthenticationFailure(text)) return 'authentication'
  if (isLaunchConfigFailure(text)) return 'launch_config'
  if (isDiskFullError(text)) return 'disk_full'
  if (typeof exitCode !== 'number') return 'process_signal'
  return 'agent_error'
}

/**
 * Operator-facing run-failure copy. Run failures used to be invisible in
 * Sentry — a non-zero agent exit (or a process killed when the disk filled)
 * was written to the DB as `failed` and never captured.
 */

/** Persist this on the run row when worker prep (clone, worktree, spawn) throws. */
export function failedStartLastLine(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  return `Failed to start run: ${msg}`
}

/**
 * Operator-facing line when the CLI did not exit on its own. SIGTERM is the
 * cooperative cancel path (`stopRun`) and is not described here.
 */
export function killedBySignalLastLine(signal?: string): string {
  const sig = signal ? ` (${signal})` : ''
  return (
    `✗ Run process was killed${sig} — typically out-of-memory or disk-pressure ` +
    'eviction. Check the memory limit and free disk of the host that ran it: the ' +
    'Conduit pod for local runs, or the worker task for remote/Fargate runs ' +
    '(a Fargate agent can raise its workerMemoryMib).'
  )
}

/**
 * Diagnostic to emit when the agent CLI is gone because of a kill, not a
 * normal non-zero exit. `137` is 128+SIGKILL when the runtime reports a
 * numeric code instead of `null` + signal.
 */
export function cliKillDiagnostic(
  code: number | null | undefined,
  signal?: string | null
): string | undefined {
  if (code === 0) return undefined
  if (code === 137) return killedBySignalLastLine('SIGKILL')
  if ((code == null || code === undefined) && signal && signal !== 'SIGTERM') {
    return killedBySignalLastLine(signal)
  }
  return undefined
}

function failureMessage(kind: RunFailureKind, runner: RunnerType, exitCodeTag: string): string {
  switch (kind) {
    case 'authentication':
      return `Agent credential rejected (${runner})`
    case 'launch_config':
      return `Agent runner rejected the launch configuration (${runner})`
    case 'disk_full':
    case 'process_signal':
    case 'worker_control':
    case 'agent_error':
      return `Agent run failed (exit ${exitCodeTag})`
  }
}

/**
 * Build the error-reporter payload for a failed agent run.
 *
 * A disk-exhaustion failure is escalated to `error` and tagged `diskFull:true`
 * so it can be alerted on directly; other failures report at `warning`. The
 * exit code is normalised — `null` means the process was killed by a signal
 * (e.g. OOM / eviction), rendered as "signal".
 */
export function buildRunFailureReport(opts: {
  runId: string
  runner: RunnerType
  exitCode: number | null | undefined
  lastLine: string | undefined
}): RunFailureReport {
  const { runId, runner, exitCode, lastLine } = opts
  const failureKind = classifyRunFailure(lastLine, exitCode)
  const diskFull = failureKind === 'disk_full'
  // `null`/`undefined` exit code ⇒ the process was killed by a signal rather than
  // exiting on its own — typically an OOM kill or a disk-pressure eviction of the
  // agent process. These are the failures that leave the log "just stopping", so
  // escalate them to `error` (like disk-full) instead of hiding them at `warning`.
  const killedBySignal = typeof exitCode !== 'number'
  const exitCodeTag = killedBySignal ? 'signal' : String(exitCode)
  const authentication = failureKind === 'authentication'
  const redactedLastLine =
    lastLine && lastLine.length > 0 ? redactFailureLastLine(lastLine) : undefined
  return {
    message: failureMessage(failureKind, runner, exitCodeTag),
    level: diskFull || killedBySignal ? 'error' : 'warning',
    ctx: {
      tags: {
        component: 'runner',
        op: 'runExit',
        runId,
        runner,
        exitCode: exitCodeTag,
        diskFull: String(diskFull),
        killedBySignal: String(killedBySignal),
        failureKind,
      },
      extra: authentication ? {} : { lastLine: redactedLastLine },
    },
  }
}
