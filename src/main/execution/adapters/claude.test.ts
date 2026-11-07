import { describe, it, expect } from 'vitest'
import { parseClaudeEvents } from './claude'

const line = (obj: unknown) => JSON.stringify(obj)

describe('parseClaudeEvents', () => {
  it('returns [] for blank lines', () => {
    expect(parseClaudeEvents('')).toEqual([])
    expect(parseClaudeEvents('   ')).toEqual([])
  })

  it('wraps non-JSON lines as a raw stdout event', () => {
    expect(parseClaudeEvents('starting up…')).toEqual([
      { kind: 'raw', stream: 'stdout', text: 'starting up…' },
    ])
  })

  it('parses an assistant text block', () => {
    expect(parseClaudeEvents(line({ type: 'assistant', message: { content: [{ type: 'text', text: 'Hello' }] } }))).toEqual([
      { kind: 'assistant', text: 'Hello' },
    ])
  })

  it('parses text + tool_use in one assistant message into separate events', () => {
    const events = parseClaudeEvents(
      line({
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: "I'll read the file." },
            { type: 'tool_use', id: 'tu_1', name: 'Read', input: { file_path: 'a.ts' } },
          ],
        },
      })
    )
    expect(events).toEqual([
      { kind: 'assistant', text: "I'll read the file." },
      { kind: 'tool_use', toolUseId: 'tu_1', toolName: 'Read', toolInput: { file_path: 'a.ts' } },
    ])
  })

  it('skips thinking blocks', () => {
    const events = parseClaudeEvents(
      line({ type: 'assistant', message: { content: [{ type: 'thinking', text: 'hmm' }] } })
    )
    expect(events).toEqual([])
  })

  it('parses a tool_result from a user message and links it by tool_use_id', () => {
    const events = parseClaudeEvents(
      line({
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'file contents' }] },
      })
    )
    expect(events).toEqual([
      { kind: 'tool_result', toolUseId: 'tu_1', content: 'file contents', isError: false },
    ])
  })

  it('flags an errored tool_result and extracts array content', () => {
    const events = parseClaudeEvents(
      line({
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'tu_2', is_error: true, content: [{ type: 'text', text: 'boom' }] },
          ],
        },
      })
    )
    expect(events).toEqual([{ kind: 'tool_result', toolUseId: 'tu_2', content: 'boom', isError: true }])
  })

  it('parses the terminal result marker', () => {
    expect(parseClaudeEvents(line({ type: 'result', subtype: 'success' }))).toEqual([
      { kind: 'result', isError: false, text: 'Completed' },
    ])
    expect(parseClaudeEvents(line({ type: 'result', subtype: 'error_max_turns' }))).toEqual([
      { kind: 'result', isError: true, text: 'Failed' },
    ])
  })

  it('attaches cost and token usage to the result event, including failed runs', () => {
    const result = {
      type: 'result',
      duration_ms: 90_000,
      duration_api_ms: 60_000,
      num_turns: 6,
      total_cost_usd: 1.25,
      usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 40 },
    }
    const expected = {
      costUsd: 1.25,
      inputTokens: 10,
      outputTokens: 20,
      cacheReadTokens: 30,
      cacheWriteTokens: 40,
      numTurns: 6,
      cliDurationMs: 90_000,
      apiDurationMs: 60_000,
    }
    expect(parseClaudeEvents(line({ ...result, subtype: 'success' }))).toEqual([
      { kind: 'result', isError: false, text: 'Completed', usage: expected },
    ])
    expect(parseClaudeEvents(line({ ...result, subtype: 'error_max_turns' }))).toEqual([
      { kind: 'result', isError: true, text: 'Failed', usage: expected },
    ])
  })

  it('caps very large tool_result content', () => {
    const huge = 'x'.repeat(50_000)
    const events = parseClaudeEvents(
      line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't', content: huge }] } })
    )
    const content = events[0].content!
    expect(content.length).toBeLessThan(huge.length)
    expect(content).toContain('characters omitted')
  })

  it('ignores unknown event types', () => {
    expect(parseClaudeEvents(line({ type: 'system', subtype: 'init' }))).toEqual([])
  })
})
