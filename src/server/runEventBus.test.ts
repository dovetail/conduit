import { describe, it, expect } from 'vitest'
import { selectUnsentEvents } from './runEventBus'
import type { RunEvent } from '../shared/types'
import type { StoredRunEvent } from '../main/db/queries/runEvents'

const ev = (text: string): RunEvent => ({ t: 1, kind: 'raw', stream: 'stdout', text })
const row = (seq: number, text: string): StoredRunEvent => ({ seq, event: ev(text) })

describe('selectUnsentEvents', () => {
  it('returns all events when nothing has been sent yet, reporting the high-water seq', () => {
    const { events, maxSeq } = selectUnsentEvents([row(1, 'a'), row(2, 'b')], 0)
    expect(events.map((e) => e.text)).toEqual(['a', 'b'])
    expect(maxSeq).toBe(2)
  })

  it('skips events already forwarded (seq <= lastSeq) so none are re-delivered', () => {
    const { events, maxSeq } = selectUnsentEvents([row(1, 'a'), row(2, 'b'), row(3, 'c')], 2)
    expect(events.map((e) => e.text)).toEqual(['c'])
    expect(maxSeq).toBe(3)
  })

  it('returns nothing and preserves lastSeq when every row is already sent', () => {
    const { events, maxSeq } = selectUnsentEvents([row(1, 'a'), row(2, 'b')], 5)
    expect(events).toEqual([])
    expect(maxSeq).toBe(5)
  })

  it('handles an empty row set', () => {
    expect(selectUnsentEvents([], 3)).toEqual({ events: [], maxSeq: 3 })
  })
})
