import { describe, it, expect } from 'vitest'
import type { TriggerContext } from '../shared/types'
import {
  DEFAULT_RUN_RETRY_MAX_ATTEMPTS,
  RUN_RETRY_DELAYS_MS,
  planTransientRetry,
  resolveRunRetryMaxAttempts,
} from './runRetry'

const TRANSIENT = 'RetriableError: [resource_exhausted] Error'
const cron: TriggerContext = { triggerId: 't1', triggerType: 'cron' }

function plan(over: Partial<Parameters<typeof planTransientRetry>[0]> = {}) {
  return planTransientRetry({
    runId: 'run-1',
    lastLine: TRANSIENT,
    exitCode: 1,
    durationMs: 5 * 60_000,
    triggerContext: cron,
    maxAttempts: 2,
    ...over,
  })
}

describe('planTransientRetry', () => {
  it('retries an early transient failure of a triggered run after the first delay', () => {
    expect(plan()).toEqual({
      attempt: 1,
      maxAttempts: 2,
      delayMs: RUN_RETRY_DELAYS_MS[0],
      retry: { attempt: 1, previousRunId: 'run-1' },
    })
  })

  it('uses the longer delay for the second retry and stops after the last', () => {
    const second = plan({ triggerContext: { ...cron, retry: { attempt: 1, previousRunId: 'run-0' } } })
    expect(second).toMatchObject({ attempt: 2, delayMs: RUN_RETRY_DELAYS_MS[1] })
    expect(plan({ triggerContext: { ...cron, retry: { attempt: 2, previousRunId: 'run-0' } } })).toBeNull()
  })

  it('does not retry a manual run', () => {
    expect(plan({ triggerContext: undefined })).toBeNull()
  })

  it('does not retry a run that got far enough to have side effects', () => {
    expect(plan({ durationMs: 47 * 60_000 })).toBeNull()
  })

  it('does not retry agent errors, bad credentials, or kills', () => {
    expect(plan({ lastLine: 'TypeError: something broke' })).toBeNull()
    expect(plan({ lastLine: 'Warning: The provided API key is invalid.' })).toBeNull()
    expect(plan({ exitCode: null })).toBeNull()
  })

  it('is off when no retries are allowed', () => {
    expect(plan({ maxAttempts: 0 })).toBeNull()
  })
})

describe('resolveRunRetryMaxAttempts', () => {
  it('defaults, honours an override including 0, and ignores garbage', () => {
    expect(resolveRunRetryMaxAttempts({})).toBe(DEFAULT_RUN_RETRY_MAX_ATTEMPTS)
    expect(resolveRunRetryMaxAttempts({ CONDUIT_RUN_RETRY_MAX_ATTEMPTS: '0' })).toBe(0)
    expect(resolveRunRetryMaxAttempts({ CONDUIT_RUN_RETRY_MAX_ATTEMPTS: '3' })).toBe(3)
    expect(resolveRunRetryMaxAttempts({ CONDUIT_RUN_RETRY_MAX_ATTEMPTS: 'many' })).toBe(
      DEFAULT_RUN_RETRY_MAX_ATTEMPTS
    )
  })
})
