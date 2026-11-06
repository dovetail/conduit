import { describe, it, expect } from 'vitest'
import { digestRunLog, queryRunLog, renderRunLogPage, truncateText } from './runDigest'
import type { RunEvent, RunLog } from '../../shared/types'

const events: RunEvent[] = [
  { t: 1000, kind: 'assistant', text: 'Looking at the repo' },
  { t: 1001, kind: 'tool_use', toolName: 'Bash', toolUseId: 'u1', toolInput: { command: 'npm test' } },
  { t: 1002, kind: 'tool_result', toolUseId: 'u1', content: 'FAIL src/a.test.ts', isError: true },
  { t: 1003, kind: 'tool_use', toolName: 'Read', toolUseId: 'u2', toolInput: { file_path: '/x.ts' } },
  { t: 1004, kind: 'tool_result', toolUseId: 'u2', content: 'file body' },
  { t: 1005, kind: 'raw', stream: 'stderr', text: 'warning: something\n\nerror: boom' },
  { t: 1006, kind: 'assistant', text: 'Tests fail; giving up' },
  { t: 1007, kind: 'result', isError: true, text: 'Run failed' },
]
const log: RunLog = { format: 'events', events }

describe('digestRunLog', () => {
  it('summarizes tool calls, errors, result, and tails', () => {
    const d = digestRunLog(log)
    expect(d.eventCount).toBe(8)
    expect(d.toolCalls).toEqual({ Bash: 1, Read: 1 })
    expect(d.toolErrors).toEqual([{ index: 2, toolName: 'Bash', excerpt: 'FAIL src/a.test.ts' }])
    expect(d.result).toEqual({ isError: true, text: 'Run failed' })
    expect(d.lastAssistantMessages).toEqual(['Looking at the repo', 'Tests fail; giving up'])
    expect(d.stderrTail).toEqual(['warning: something', 'error: boom'])
    expect(d.firstEventAt).toBe(1000)
    expect(d.lastEventAt).toBe(1007)
  })

  it('normalizes legacy terminal logs and strips ANSI', () => {
    const d = digestRunLog({
      format: 'terminal',
      entries: [
        { t: 1, stream: 'stdout', chunk: '\x1b[32mok\x1b[0m' },
        { t: 2, stream: 'stderr', chunk: '\x1b[31mbad\x1b[0m' },
      ],
    })
    expect(d.format).toBe('terminal')
    expect(d.stderrTail).toEqual(['bad'])
  })

  it('handles an empty log', () => {
    expect(digestRunLog({ format: 'events', events: [] }).eventCount).toBe(0)
  })
})

describe('queryRunLog', () => {
  const base = { limit: 100, maxCharsPerEvent: 2000 }

  it('filters by kind and labels tool results with their tool name', () => {
    const page = queryRunLog(log, { ...base, kinds: ['tool_result'] })
    expect(page.matchedEvents).toBe(2)
    expect(page.events.map((e) => e.toolName)).toEqual(['Bash', 'Read'])
  })

  it('searches text and tool names case-insensitively', () => {
    expect(queryRunLog(log, { ...base, search: 'npm TEST' }).events.map((e) => e.index)).toEqual([1])
    expect(queryRunLog(log, { ...base, search: 'read' }).events.map((e) => e.index)).toEqual([3, 4])
  })

  it('returns only errors and stderr', () => {
    expect(queryRunLog(log, { ...base, onlyErrors: true }).events.map((e) => e.index)).toEqual([2, 5, 7])
  })

  it('pages with offset/limit and tail', () => {
    const first = queryRunLog(log, { ...base, offset: 0, limit: 3 })
    expect(first.events.map((e) => e.index)).toEqual([0, 1, 2])
    expect(first.hasMore).toBe(true)
    const tail = queryRunLog(log, { ...base, tail: 2, limit: 2 })
    expect(tail.events.map((e) => e.index)).toEqual([6, 7])
    expect(tail.startIndex).toBe(6)
    expect(tail.hasMore).toBe(false)
  })

  it('truncates long event text', () => {
    const big: RunLog = { format: 'events', events: [{ t: 0, kind: 'assistant', text: 'x'.repeat(500) }] }
    expect(queryRunLog(big, { limit: 1, maxCharsPerEvent: 100 }).events[0]!.text).toBe(truncateText('x'.repeat(500), 100))
  })

  it('renders a compact text page', () => {
    const text = renderRunLogPage(queryRunLog(log, { ...base, kinds: ['result'] }))
    expect(text).toContain('1 of 1 matching events (8 total)')
    expect(text).toContain('#7 1970-01-01T00:00:01.007Z result [error]: Run failed')
  })
})
