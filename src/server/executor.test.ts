import { describe, it, expect, afterEach } from 'vitest'
import { getExecutorKind, JobExecutor, type PreparedRun } from './executor'

const original = process.env.CONDUIT_EXECUTOR
afterEach(() => {
  if (original === undefined) delete process.env.CONDUIT_EXECUTOR
  else process.env.CONDUIT_EXECUTOR = original
})

describe('getExecutorKind', () => {
  it('defaults to inproc when CONDUIT_EXECUTOR is unset', () => {
    delete process.env.CONDUIT_EXECUTOR
    expect(getExecutorKind()).toBe('inproc')
  })

  it('returns job only for the exact value "job"', () => {
    process.env.CONDUIT_EXECUTOR = 'job'
    expect(getExecutorKind()).toBe('job')
  })

  it('treats any other value as inproc (fail-safe default)', () => {
    process.env.CONDUIT_EXECUTOR = 'kubernetes'
    expect(getExecutorKind()).toBe('inproc')
  })
})

describe('JobExecutor', () => {
  it('reports the job kind', () => {
    expect(new JobExecutor().kind).toBe('job')
  })

  it('fails fast until the Job dispatch path lands, rather than silently dropping the run', async () => {
    await expect(
      new JobExecutor().execute({} as PreparedRun, () => {})
    ).rejects.toThrow(/not yet implemented/i)
  })
})
