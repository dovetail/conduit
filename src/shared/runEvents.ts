import type { RunEvent, RunEventInit } from './types'

/**
 * Display helpers for structured run events. This is the single source of truth
 * for turning a tool call into a human-readable header — used by the client to
 * render tool rows and by the server to compute a run's `lastLine` activity
 * excerpt. Pure and unit-tested; no ANSI, no rendering concerns.
 */

export interface ToolDescription {
  /** The tool's short name, e.g. 'Bash', 'Read', or an MCP server name. */
  title: string
  /** The most salient argument, e.g. the file path or command. */
  subtitle?: string
}

function asRecord(input: unknown): Record<string, unknown> {
  return input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s
}

/**
 * Bound a tool_result's stored output so a single huge result can't bloat the
 * log file or the live payload. Keeps the head and tail (where the useful
 * signal usually is) with a marker for the omitted middle.
 */
export function capText(text: string, max = 12000): string {
  if (text.length <= max) return text
  const head = text.slice(0, Math.floor(max * 0.7))
  const tail = text.slice(-Math.floor(max * 0.15))
  const omitted = text.length - head.length - tail.length
  return `${head}\n\n… ${omitted} characters omitted …\n\n${tail}`
}

/**
 * Describe a tool call as a one-line header: a title plus its most salient
 * argument. Falls back to the bare tool name for tools with no obvious argument.
 */
export function describeToolUse(toolName: string | undefined, input: unknown): ToolDescription {
  const name = toolName ?? 'tool'
  const args = asRecord(input)
  const str = (k: string): string | undefined => {
    const v = args[k]
    return typeof v === 'string' && v.length > 0 ? v : undefined
  }

  if (name === 'Bash') {
    const cmd = str('command')
    return { title: 'Bash', subtitle: cmd ? truncate(cmd, 200) : undefined }
  }
  if (name === 'Read' || name === 'Write' || name === 'Edit' || name === 'MultiEdit') {
    return { title: name, subtitle: str('file_path') }
  }
  if (name === 'NotebookEdit') {
    return { title: 'NotebookEdit', subtitle: str('notebook_path') }
  }
  if (name === 'Glob') {
    return { title: 'Glob', subtitle: str('pattern') }
  }
  if (name === 'Grep') {
    const pattern = str('pattern')
    const path = str('path')
    return { title: 'Grep', subtitle: pattern ? `${pattern}${path ? ` in ${path}` : ''}` : path }
  }
  if (name === 'Agent' || name === 'Task') {
    const desc = str('description') ?? str('prompt')
    return { title: 'Agent', subtitle: desc ? truncate(desc, 120) : undefined }
  }
  if (name === 'WebFetch') {
    return { title: 'WebFetch', subtitle: str('url') }
  }
  if (name === 'WebSearch') {
    return { title: 'WebSearch', subtitle: str('query') }
  }
  if (name.startsWith('mcp__')) {
    const parts = name.split('__')
    const server = parts[1] || 'mcp'
    const tool = parts.slice(2).join('__') || 'tool'
    return { title: server, subtitle: tool }
  }
  // TodoWrite, ToolSearch, and anything else: just the name.
  return { title: name }
}

function firstNonEmptyLine(text: string | undefined, max: number): string {
  const t = (text ?? '').trim()
  if (!t) return ''
  const line = t.split(/\r?\n/).find((l) => l.trim()) ?? ''
  return truncate(line.trim(), max)
}

/**
 * A plain-text one-liner summarizing an event, for the runs-list activity label
 * / `lastLine`. Returns '' for events that don't represent meaningful activity
 * (tool results, the terminal result marker) so the last real activity sticks.
 */
export function summarizeEvent(ev: RunEventInit): string {
  switch (ev.kind) {
    case 'assistant':
      return firstNonEmptyLine(ev.text, 140)
    case 'tool_use': {
      const d = describeToolUse(ev.toolName, ev.toolInput)
      return d.subtitle ? `${d.title} ${d.subtitle}` : d.title
    }
    case 'raw':
      return firstNonEmptyLine(ev.text, 140)
    default:
      return ''
  }
}

/**
 * Serialize a run's structured events into a plain-text transcript for download —
 * a fully-expanded version of the on-screen log (assistant narration, each tool
 * call with its output, and the final result). Tool results are paired to their
 * call by `toolUseId`, matching the rendered view, so a collapsed UI still yields
 * a complete log file. Pure and unit-tested.
 */
export function runLogToText(events: RunEvent[]): string {
  const resultByToolUse = new Map<string, RunEvent>()
  for (const e of events) {
    if (e.kind === 'tool_result' && e.toolUseId) resultByToolUse.set(e.toolUseId, e)
  }

  const lines: string[] = []
  const pushIndented = (text: string) => {
    for (const l of text.trimEnd().split('\n')) lines.push(`    ${l}`)
  }

  for (const e of events) {
    switch (e.kind) {
      case 'assistant':
        if (e.text?.trim()) lines.push(`● ${e.text.trim()}`, '')
        break
      case 'tool_use': {
        const d = describeToolUse(e.toolName, e.toolInput)
        lines.push(d.subtitle ? `❯ ${d.title} ${d.subtitle}` : `❯ ${d.title}`)
        const output = (e.toolUseId ? resultByToolUse.get(e.toolUseId)?.content : undefined) ?? ''
        if (output.trim()) pushIndented(output)
        lines.push('')
        break
      }
      case 'raw':
        if (e.text?.trim()) lines.push(e.text.trimEnd(), '')
        break
      case 'result':
        lines.push(e.isError ? '✗ Failed' : '✓ Completed')
        break
      case 'metering':
        if (e.text?.trim()) lines.push(e.text.trim())
        break
      // tool_result rows are consumed via the toolUseId map above.
    }
  }

  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n'
}

/** Narrow a parsed JSONL object to a RunEvent (has the `kind` discriminant). */
export function isRunEvent(value: unknown): value is RunEvent {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as { kind?: unknown }).kind === 'string'
  )
}
