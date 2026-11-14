import type { RunRetryInfo, TriggerContext } from '../shared/types'
import { classifyRunFailure } from './runFailure'

/**
 * Automatic retry for triggered runs that die early on a transient upstream
 * error — the model provider throttled or dropped the connection before the
 * agent did anything. Without it a scheduled bot is simply skipped for the day
 * (a single `[resource_exhausted]` from the Cursor API cost the DB Performance
 * bot its whole 01:00 run).
 *
 * Deliberately narrow:
 * - only runs started by a trigger (cron/webhook/slack); a person watching a
 *   manual run can press Run again,
 * - only a run that failed within `maxRunMs` — a run that got further may
 *   already have pushed branches or opened PRs, and a retry would redo that,
 * - only failures classified `provider_unavailable`, never agent bugs, bad
 *   credentials, or kills.
 */

/** Retries after the first attempt. `0` turns auto-retry off. */
export const DEFAULT_RUN_RETRY_MAX_ATTEMPTS = 2
/** A run that lasted longer than this before failing is not retried. */
export const DEFAULT_RUN_RETRY_MAX_RUN_MS = 15 * 60_000
/** Wait before retry n (1-based); the last entry repeats. Quotas recover slowly. */
export const RUN_RETRY_DELAYS_MS = [5 * 60_000, 15 * 60_000]

export interface RunRetryPlan {
  /** 1-based number of the retry about to start. */
  attempt: number
  /** Retries the run may use in total. */
  maxAttempts: number
  delayMs: number
  retry: RunRetryInfo
}

export function resolveRunRetryMaxAttempts(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.CONDUIT_RUN_RETRY_MAX_ATTEMPTS?.trim()
  if (!raw) return DEFAULT_RUN_RETRY_MAX_ATTEMPTS
  const n = Number(raw)
  return Number.isInteger(n) && n >= 0 ? n : DEFAULT_RUN_RETRY_MAX_ATTEMPTS
}

export function runRetryDelayMs(attempt: number): number {
  return RUN_RETRY_DELAYS_MS[Math.min(attempt, RUN_RETRY_DELAYS_MS.length) - 1]!
}

/** Decide whether a just-failed run should be started again, and when. */
export function planTransientRetry(opts: {
  runId: string
  lastLine: string | undefined
  exitCode: number | null | undefined
  durationMs: number
  triggerContext: TriggerContext | undefined
  maxAttempts?: number
  maxRunMs?: number
}): RunRetryPlan | null {
  const { runId, lastLine, exitCode, durationMs, triggerContext } = opts
  if (!triggerContext) return null
  const maxAttempts = opts.maxAttempts ?? resolveRunRetryMaxAttempts()
  const used = triggerContext.retry?.attempt ?? 0
  if (used >= maxAttempts) return null
  if (durationMs > (opts.maxRunMs ?? DEFAULT_RUN_RETRY_MAX_RUN_MS)) return null
  if (classifyRunFailure(lastLine, exitCode) !== 'provider_unavailable') return null

  const attempt = used + 1
  return {
    attempt,
    maxAttempts,
    delayMs: runRetryDelayMs(attempt),
    retry: { attempt, previousRunId: runId },
  }
}
