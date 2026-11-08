import { describe, it, expect } from 'vitest'
import { parseRunUsage, formatRunMetering, totalTokens, formatCostUsd } from './usage'

describe('parseRunUsage', () => {
  it('reads Claude Code snake_case cost, tokens, turns and timing', () => {
    expect(
      parseRunUsage({
        type: 'result',
        subtype: 'success',
        duration_ms: 12_000,
        duration_api_ms: 9_000,
        num_turns: 4,
        total_cost_usd: 0.4231,
        usage: {
          input_tokens: 100,
          output_tokens: 250,
          cache_read_input_tokens: 5000,
          cache_creation_input_tokens: 700,
        },
      })
    ).toEqual({
      costUsd: 0.4231,
      inputTokens: 100,
      outputTokens: 250,
      cacheReadTokens: 5000,
      cacheWriteTokens: 700,
      numTurns: 4,
      cliDurationMs: 12_000,
      apiDurationMs: 9_000,
    })
  })

  it('reads Cursor camelCase token counts and omits the cost it does not report', () => {
    const usage = parseRunUsage({
      type: 'result',
      subtype: 'success',
      duration_ms: 3000,
      usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 40 },
    })
    expect(usage).toEqual({
      inputTokens: 10,
      outputTokens: 20,
      cacheReadTokens: 30,
      cacheWriteTokens: 40,
      cliDurationMs: 3000,
    })
    expect(usage).not.toHaveProperty('costUsd')
  })

  it('keeps a reported zero cost but ignores junk values', () => {
    expect(parseRunUsage({ total_cost_usd: 0 })).toEqual({ costUsd: 0 })
    expect(parseRunUsage({ total_cost_usd: 'a lot', usage: { input_tokens: -1 } })).toBeUndefined()
  })

  it('returns undefined when the event carries nothing', () => {
    expect(parseRunUsage({ type: 'result', subtype: 'success' })).toBeUndefined()
    expect(parseRunUsage(null)).toBeUndefined()
  })
})

describe('formatRunMetering', () => {
  it('summarizes session time, cost and tokens', () => {
    expect(
      formatRunMetering(123_000, { costUsd: 0.42, inputTokens: 1200, outputTokens: 3400, cacheReadTokens: 50_000, numTurns: 3 })
    ).toBe('Session 2m 3s · cost $0.42 · tokens 1.2k in / 3.4k out / 50.0k cached · 3 turns')
  })

  it('shows only the session time when the CLI reported no usage', () => {
    expect(formatRunMetering(5000, undefined)).toBe('Session 5s')
  })

  it('never renders a sub-cent cost as zero', () => {
    expect(formatCostUsd(0.004)).toBe('<$0.01')
    expect(formatCostUsd(0)).toBe('$0.00')
  })
})

describe('totalTokens', () => {
  it('sums the reported token fields', () => {
    expect(totalTokens({ inputTokens: 1, outputTokens: 2, cacheReadTokens: 3 })).toBe(6)
    expect(totalTokens({ costUsd: 1 })).toBeUndefined()
  })
})
