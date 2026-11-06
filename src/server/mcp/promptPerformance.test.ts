import { describe, it, expect, vi } from 'vitest'

vi.mock('../../main/db/queries/agents', () => ({ updateAgent: vi.fn() }))
vi.mock('../../main/db/queries/runs', () => ({ listRuns: vi.fn() }))
vi.mock('../../main/db/queries/promptRevisions', () => ({}))

import { promptPerformance } from './tools/prompts'
import type { ExecutionRun, PromptRevision } from '../../shared/types'

const rev = (id: string, createdAt: number): PromptRevision => ({
  id, agentId: 'a', prompt: id, source: 'mcp', createdAt,
})
const run = (id: string, startedAt: number, status: ExecutionRun['status'], durationMs?: number): ExecutionRun => ({
  id, agentId: 'a', status, startedAt, durationMs, logPath: '',
})

describe('promptPerformance', () => {
  it('buckets runs by the revision live when they started, newest revision first', () => {
    const result = promptPerformance(
      [rev('v2', 200), rev('v1', 100)],
      [
        run('early', 50, 'failed'),
        run('a', 110, 'failed', 1000),
        run('b', 150, 'completed', 3000),
        run('c', 210, 'completed', 500),
        run('d', 220, 'running'),
      ]
    )
    expect(result.revisions.map((r) => r.revisionId)).toEqual(['v2', 'v1'])
    expect(result.revisions[0]).toMatchObject({ runs: 2, byStatus: { completed: 1, running: 1 }, successRate: 1, effectiveTo: undefined })
    expect(result.revisions[1]).toMatchObject({
      runs: 2, successRate: 0.5, avgDurationMs: 2000, sampleFailedRunIds: ['a'],
    })
    expect(result.beforeHistory).toMatchObject({ runs: 1, byStatus: { failed: 1 } })
  })

  it('handles agents with no revision history', () => {
    const result = promptPerformance([], [run('x', 1, 'completed')])
    expect(result.revisions).toEqual([])
    expect(result.beforeHistory).toMatchObject({ runs: 1, successRate: 1 })
  })
})
