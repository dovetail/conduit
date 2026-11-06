import { describeToolUse } from '../../shared/runEvents'
import type { RunEvent, RunEventKind, RunLog } from '../../shared/types'

/**
 * LLM-oriented views of a run log: a compact digest for triage, and a filtered,
 * paginated, size-bounded event listing. Both formats (structured events and
 * legacy ANSI terminal entries) are normalized into events first. Pure.
 */

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
}

export function truncateText(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}… [${text.length - max} more chars]`
}

export function normalizeRunLog(log: RunLog): RunEvent[] {
  if (log.format === 'events') return log.events
  return log.entries.map((e) => ({
    t: e.t,
    kind: 'raw' as const,
    text: stripAnsi(e.chunk),
    stream: e.stream,
  }))
}

function eventText(e: RunEvent): string {
  switch (e.kind) {
    case 'tool_use': {
      const d = describeToolUse(e.toolName, e.toolInput)
      return d.subtitle ? `${e.toolName ?? d.title}: ${d.subtitle}` : (e.toolName ?? d.title)
    }
    case 'tool_result':
      return e.content ?? ''
    default:
      return e.text ?? e.content ?? ''
  }
}

export interface RunDigest {
  format: RunLog['format']
  eventCount: number
  firstEventAt?: number
  lastEventAt?: number
  /** Tool name → number of calls. */
  toolCalls: Record<string, number>
  /** Tool results flagged as errors, most recent last (bounded). */
  toolErrors: Array<{ index: number; toolName?: string; excerpt: string }>
  /** The CLI's terminal result marker, when present. */
  result?: { isError: boolean; text: string }
  /** Last few assistant messages, oldest first. */
  lastAssistantMessages: string[]
  /** Last few stderr/system lines, oldest first. */
  stderrTail: string[]
}

const MAX_TOOL_ERRORS = 10
const MAX_ASSISTANT = 3
const MAX_STDERR = 15

export function digestRunLog(log: RunLog): RunDigest {
  const events = normalizeRunLog(log)
  const toolNames = new Map<string, string | undefined>()
  const toolCalls: Record<string, number> = {}
  const toolErrors: RunDigest['toolErrors'] = []
  const assistant: string[] = []
  const stderr: string[] = []
  let result: RunDigest['result']

  events.forEach((e, index) => {
    switch (e.kind) {
      case 'tool_use': {
        const name = e.toolName ?? 'tool'
        toolCalls[name] = (toolCalls[name] ?? 0) + 1
        if (e.toolUseId) toolNames.set(e.toolUseId, name)
        break
      }
      case 'tool_result':
        if (e.isError) {
          toolErrors.push({
            index,
            toolName: e.toolUseId ? toolNames.get(e.toolUseId) : undefined,
            excerpt: truncateText((e.content ?? '').trim(), 400),
          })
          if (toolErrors.length > MAX_TOOL_ERRORS) toolErrors.shift()
        }
        break
      case 'assistant':
        if (e.text?.trim()) {
          assistant.push(truncateText(e.text.trim(), 1500))
          if (assistant.length > MAX_ASSISTANT) assistant.shift()
        }
        break
      case 'result':
        result = { isError: !!e.isError, text: truncateText((e.text ?? '').trim(), 2000) }
        break
      case 'raw':
        if (e.stream === 'stderr' || e.stream === 'system') {
          for (const line of (e.text ?? '').split(/\r?\n/)) {
            const trimmed = line.trim()
            if (!trimmed) continue
            stderr.push(truncateText(trimmed, 400))
            if (stderr.length > MAX_STDERR) stderr.shift()
          }
        }
        break
    }
  })

  return {
    format: log.format,
    eventCount: events.length,
    firstEventAt: events[0]?.t,
    lastEventAt: events[events.length - 1]?.t,
    toolCalls,
    toolErrors,
    result,
    lastAssistantMessages: assistant,
    stderrTail: stderr,
  }
}

export interface RunLogQuery {
  kinds?: RunEventKind[]
  /** Case-insensitive substring match against the event's text / tool name. */
  search?: string
  onlyErrors?: boolean
  /** Return the last N matching events (takes precedence over offset). */
  tail?: number
  offset?: number
  limit: number
  maxCharsPerEvent: number
}

export interface RunLogPage {
  totalEvents: number
  matchedEvents: number
  returned: number
  /** Index (into the matched list) of the first returned event. */
  startIndex: number
  hasMore: boolean
  events: Array<{
    index: number
    t: number
    kind: RunEventKind
    stream?: string
    toolName?: string
    isError?: boolean
    text: string
  }>
}

export function queryRunLog(log: RunLog, q: RunLogQuery): RunLogPage {
  const events = normalizeRunLog(log)
  const needle = q.search?.toLowerCase()
  const kinds = q.kinds && q.kinds.length > 0 ? new Set(q.kinds) : null
  const toolNames = new Map<string, string | undefined>()

  const matched: RunLogPage['events'] = []
  events.forEach((e, index) => {
    if (e.kind === 'tool_use' && e.toolUseId) toolNames.set(e.toolUseId, e.toolName)
    if (kinds && !kinds.has(e.kind)) return
    if (q.onlyErrors && !e.isError && e.stream !== 'stderr') return
    const toolName = e.toolName ?? (e.toolUseId ? toolNames.get(e.toolUseId) : undefined)
    const text = eventText(e)
    if (needle && !text.toLowerCase().includes(needle) && !(toolName ?? '').toLowerCase().includes(needle)) {
      return
    }
    matched.push({
      index,
      t: e.t,
      kind: e.kind,
      stream: e.stream,
      toolName,
      isError: e.isError || undefined,
      text: truncateText(text.trim(), q.maxCharsPerEvent),
    })
  })

  const limit = Math.max(1, q.limit)
  const start =
    q.tail != null
      ? Math.max(0, matched.length - Math.max(1, q.tail))
      : Math.min(Math.max(0, q.offset ?? 0), matched.length)
  const count = q.tail != null ? Math.min(limit, matched.length - start) : limit
  const page = matched.slice(start, start + count)
  return {
    totalEvents: events.length,
    matchedEvents: matched.length,
    returned: page.length,
    startIndex: start,
    hasMore: start + page.length < matched.length,
    events: page,
  }
}

/** Render a page as compact plain text (for resources and prompt embedding). */
export function renderRunLogPage(page: RunLogPage): string {
  const lines = page.events.map((e) => {
    const label = e.kind === 'raw' ? `raw/${e.stream ?? 'stdout'}` : e.kind
    const tool = e.toolName ? ` ${e.toolName}` : ''
    const err = e.isError ? ' [error]' : ''
    return `#${e.index} ${new Date(e.t).toISOString()} ${label}${tool}${err}: ${e.text}`
  })
  const header = `${page.returned} of ${page.matchedEvents} matching events (${page.totalEvents} total)`
  return [header, ...lines].join('\n')
}
