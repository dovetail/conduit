import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { RunEvent } from '../shared/types'

// Mock the RDS event store + reporter so we exercise readRunLog's source
// precedence (RDS first, on-disk fallback) without a database or log file.
const getRunEvents = vi.fn<[], Promise<RunEvent[]>>()
vi.mock('../main/db/queries/runEvents', () => ({ getRunEvents: () => getRunEvents() }))
const captureException = vi.fn()
vi.mock('./observability', () => ({ reporter: { captureException: (...a: unknown[]) => captureException(...a) } }))

import { readRunLog, readRunOutputText } from './utils'

beforeEach(() => {
  getRunEvents.mockReset()
  captureException.mockReset()
})

describe('readRunLog (RDS-first, on-disk fallback)', () => {
  it('serves the run log from RDS run_events when present', async () => {
    getRunEvents.mockResolvedValue([
      { t: 1, kind: 'assistant', text: 'hello' },
      { t: 2, kind: 'result', isError: false, text: 'Completed' },
    ])
    const log = await readRunLog('run-rds')
    expect(log.format).toBe('events')
    if (log.format === 'events') expect(log.events).toHaveLength(2)
  })

  it('falls back to the on-disk log when RDS has no events (historical run)', async () => {
    getRunEvents.mockResolvedValue([])
    // No log file exists for this random id, so the fallback yields an empty
    // events log — proving the fallback branch ran rather than throwing.
    const log = await readRunLog('run-missing-000')
    expect(log).toEqual({ format: 'events', events: [] })
    expect(captureException).not.toHaveBeenCalled()
  })

  it('reports and falls back when the RDS read throws', async () => {
    getRunEvents.mockRejectedValue(new Error('rds down'))
    const log = await readRunLog('run-err-000')
    expect(log).toEqual({ format: 'events', events: [] })
    expect(captureException).toHaveBeenCalledOnce()
  })
})

describe('readRunOutputText', () => {
  it('joins assistant narration from RDS events', async () => {
    getRunEvents.mockResolvedValue([
      { t: 1, kind: 'assistant', text: 'first' },
      { t: 2, kind: 'tool_use', toolName: 'Bash', toolInput: { command: 'ls' } },
      { t: 3, kind: 'assistant', text: 'second' },
    ])
    expect(await readRunOutputText('run-rds')).toBe('first\nsecond')
  })
})
