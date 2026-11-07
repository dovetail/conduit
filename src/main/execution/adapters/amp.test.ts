import { describe, it, expect } from 'vitest'
import { parseAmpEvents } from './amp'

const line = (obj: unknown) => JSON.stringify(obj)

describe('parseAmpEvents', () => {
  it('attaches whatever usage the result event reports', () => {
    expect(
      parseAmpEvents(line({ type: 'result', subtype: 'success', duration_ms: 2000, num_turns: 2, usage: { input_tokens: 9, output_tokens: 3 } }))
    ).toEqual([
      {
        kind: 'result',
        isError: false,
        text: 'Completed',
        usage: { inputTokens: 9, outputTokens: 3, numTurns: 2, cliDurationMs: 2000 },
      },
    ])
  })

  it('leaves usage unset when the result event reports none', () => {
    expect(parseAmpEvents(line({ type: 'result', subtype: 'success' }))).toEqual([
      { kind: 'result', isError: false, text: 'Completed' },
    ])
  })
})
