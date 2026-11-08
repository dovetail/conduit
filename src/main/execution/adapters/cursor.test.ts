import { describe, it, expect } from 'vitest'
import { buildCursorArgs, parseCursorEvents } from './cursor'

const line = (obj: unknown) => JSON.stringify(obj)

describe('buildCursorArgs', () => {
  it('runs headless in Run Everything mode and trusts the materialized workspace', () => {
    expect(buildCursorArgs()).toEqual([
      '-p',
      '--output-format',
      'stream-json',
      '--force',
      '--approve-mcps',
      '--trust',
    ])
  })

  it('adds --model when a model is set', () => {
    expect(buildCursorArgs({ model: 'composer-2.5' })).toContain('composer-2.5')
    const args = buildCursorArgs({ model: 'composer-2.5' })
    expect(args[args.indexOf('--model') + 1]).toBe('composer-2.5')
  })

  it('does not invent an unsupported variant for a fixed model identifier', () => {
    const args = buildCursorArgs({ model: 'composer-2.5', effort: 'high' })
    expect(args[args.indexOf('--model') + 1]).toBe('composer-2.5')
  })

  it('does not rewrite an exact effort-qualified identifier from a stale effort value', () => {
    const args = buildCursorArgs({ model: 'claude-opus-5-high', effort: 'low' })
    expect(args[args.indexOf('--model') + 1]).toBe('claude-opus-5-high')
  })

  it('preserves the old base-model plus effort format for existing agents', () => {
    const args = buildCursorArgs({ model: 'claude-opus-4-8', effort: 'low' })
    expect(args[args.indexOf('--model') + 1]).toBe('claude-opus-4-8-low')
  })

  it('ignores effort when no model is set', () => {
    expect(buildCursorArgs({ effort: 'high' })).not.toContain('--model')
  })
})

describe('parseCursorEvents', () => {
  it('returns [] for blank lines', () => {
    expect(parseCursorEvents('')).toEqual([])
    expect(parseCursorEvents('   ')).toEqual([])
  })

  it('wraps non-JSON lines as a raw stdout event (e.g. the invalid-model error)', () => {
    expect(parseCursorEvents('Cannot use this model: foo. Available models: …')).toEqual([
      { kind: 'raw', stream: 'stdout', text: 'Cannot use this model: foo. Available models: …' },
    ])
  })

  it('parses an assistant text message', () => {
    expect(
      parseCursorEvents(line({ type: 'assistant', message: { content: [{ type: 'text', text: 'Done.' }] } }))
    ).toEqual([{ kind: 'assistant', text: 'Done.' }])
  })

  it('parses a tool_call started event, mapping shellToolCall to Bash with its args', () => {
    const events = parseCursorEvents(
      line({
        type: 'tool_call',
        subtype: 'started',
        call_id: 'Shell_0-abc',
        tool_call: { shellToolCall: { args: { command: 'echo hi' } } },
      })
    )
    expect(events).toEqual([
      { kind: 'tool_use', toolUseId: 'Shell_0-abc', toolName: 'Bash', toolInput: { command: 'echo hi' } },
    ])
  })

  it('derives a display name for unknown tool types', () => {
    const events = parseCursorEvents(
      line({
        type: 'tool_call',
        subtype: 'started',
        call_id: 'x',
        tool_call: { codebaseSearchToolCall: { args: { query: 'foo' } } },
      })
    )
    expect(events[0].toolName).toBe('CodebaseSearch')
  })

  it('parses a completed shell tool_call into a tool_result with stdout', () => {
    const events = parseCursorEvents(
      line({
        type: 'tool_call',
        subtype: 'completed',
        call_id: 'Shell_0-abc',
        tool_call: {
          shellToolCall: {
            args: { command: 'echo hi' },
            result: { success: { stdout: 'hi\n', stderr: '', exitCode: 0 } },
          },
        },
      })
    )
    expect(events).toEqual([{ kind: 'tool_result', toolUseId: 'Shell_0-abc', content: 'hi\n', isError: false }])
  })

  it('flags non-zero shell exits as errors with the exit code', () => {
    const events = parseCursorEvents(
      line({
        type: 'tool_call',
        subtype: 'completed',
        call_id: 'Shell_1',
        tool_call: {
          shellToolCall: {
            args: { command: 'false' },
            result: { success: { stdout: '', stderr: 'boom', exitCode: 1 } },
          },
        },
      })
    )
    expect(events[0].isError).toBe(true)
    expect(events[0].content).toContain('Exit code 1')
    expect(events[0].content).toContain('boom')
  })

  it('serializes non-shell tool results as JSON', () => {
    const events = parseCursorEvents(
      line({
        type: 'tool_call',
        subtype: 'completed',
        call_id: 'r1',
        tool_call: { readToolCall: { args: { path: 'a.ts' }, result: { success: { lines: 10 } } } },
      })
    )
    expect(events[0].kind).toBe('tool_result')
    expect(events[0].content).toContain('"lines": 10')
    expect(events[0].isError).toBe(false)
  })

  it('attaches the token usage the result event reports', () => {
    const events = parseCursorEvents(
      line({
        type: 'result',
        subtype: 'success',
        is_error: false,
        duration_ms: 4200,
        usage: { inputTokens: 5, outputTokens: 7 },
      })
    )
    expect(events).toEqual([
      {
        kind: 'result',
        isError: false,
        text: 'Completed',
        usage: { inputTokens: 5, outputTokens: 7, cliDurationMs: 4200 },
      },
    ])
  })

  it('parses the terminal result marker', () => {
    expect(parseCursorEvents(line({ type: 'result', subtype: 'success', is_error: false }))).toEqual([
      { kind: 'result', isError: false, text: 'Completed' },
    ])
    expect(parseCursorEvents(line({ type: 'result', subtype: 'error', is_error: true }))).toEqual([
      { kind: 'result', isError: true, text: 'Failed' },
    ])
  })

  it('surfaces the init event as a system line naming the model', () => {
    expect(parseCursorEvents(line({ type: 'system', subtype: 'init', model: 'Kimi K3 Low' }))).toEqual([
      { kind: 'raw', stream: 'system', text: '[cursor-agent started — model: Kimi K3 Low]' },
    ])
  })

  it('skips user and thinking events', () => {
    expect(parseCursorEvents(line({ type: 'user', message: { content: [] } }))).toEqual([])
    expect(parseCursorEvents(line({ type: 'thinking', subtype: 'delta', text: 'hmm' }))).toEqual([])
  })
})
