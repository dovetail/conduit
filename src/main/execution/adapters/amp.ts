/**
 * Build the CLI arguments for the `amp` binary.
 * The prompt is NOT included here — it is written to stdin after spawn to avoid
 * being consumed by --mcp-config's variadic <configs...> parser.
 */
export function buildAmpArgs(mcpConfigPath: string): string[] {
  return [
    'run',
    '--dangerously-allow-all',
    '--mcp-config',
    mcpConfigPath,
  ]
}

import type { RunEventInit } from '../../../shared/types'
import { capText } from '../../../shared/runEvents'
import { parseRunUsage } from '../../../shared/usage'

interface AmpStreamEvent {
  type: string
  message?: {
    content?: Array<{
      type: string
      text?: string
      id?: string
      name?: string
      input?: unknown
    }>
  }
  name?: string
  input?: unknown
  content?: unknown
  tool_use_id?: string
  result?: string
  subtype?: string
}

/**
 * Parse a single NDJSON line from the amp stream-json output.
 * Amp uses a compatible format to claude's stream-json.
 * Returns a human-readable string, or null if the line should be ignored.
 */
export function parseAmpOutput(line: string): string | null {
  const trimmed = line.trim()
  if (!trimmed) return null

  let event: AmpStreamEvent
  try {
    event = JSON.parse(trimmed)
  } catch {
    // Not JSON — return the raw line
    return trimmed
  }

  switch (event.type) {
    case 'assistant': {
      const content = event.message?.content ?? []
      const parts: string[] = []
      for (const block of content) {
        if (block.type === 'text' && block.text) {
          parts.push(block.text)
        } else if (block.type === 'tool_use' && block.name) {
          parts.push(`[tool: ${block.name}]`)
        }
      }
      return parts.length > 0 ? parts.join('') : null
    }

    case 'tool_use': {
      const name = event.name ?? 'unknown'
      return `[tool: ${name}]`
    }

    case 'tool_result': {
      const raw = JSON.stringify(event.content ?? '')
      const truncated = raw.length > 100 ? raw.slice(0, 100) + '…' : raw
      return `[result: ${truncated}]`
    }

    case 'result': {
      if (event.subtype === 'success' || event.result === 'success') {
        return '\n✓ Completed'
      }
      return '\n✗ Failed'
    }

    default:
      return null
  }
}

/**
 * Parse a single NDJSON line from the amp stream-json output into structured
 * RunEvents (without a timestamp — the runner stamps `t`). Mirrors
 * parseClaudeEvents; Amp emits tool_use / tool_result as either content blocks
 * on an assistant message or as top-level events.
 */
export function parseAmpEvents(line: string): RunEventInit[] {
  const trimmed = line.trim()
  if (!trimmed) return []

  let event: AmpStreamEvent
  try {
    event = JSON.parse(trimmed)
  } catch {
    return [{ kind: 'raw', stream: 'stdout', text: trimmed }]
  }

  const events: RunEventInit[] = []
  switch (event.type) {
    case 'assistant': {
      for (const block of event.message?.content ?? []) {
        if (block.type === 'text' && block.text) {
          events.push({ kind: 'assistant', text: block.text })
        } else if (block.type === 'tool_use' && block.name) {
          events.push({
            kind: 'tool_use',
            toolUseId: block.id,
            toolName: block.name,
            toolInput: block.input,
          })
        }
      }
      break
    }

    case 'tool_use': {
      events.push({ kind: 'tool_use', toolName: event.name, toolInput: event.input })
      break
    }

    case 'tool_result': {
      const text =
        typeof event.content === 'string' ? event.content : JSON.stringify(event.content ?? '')
      events.push({ kind: 'tool_result', toolUseId: event.tool_use_id, content: capText(text) })
      break
    }

    case 'result': {
      const ok = event.subtype === 'success' || event.result === 'success'
      events.push({ kind: 'result', isError: !ok, text: ok ? 'Completed' : 'Failed', usage: parseRunUsage(event) })
      break
    }

    default:
      break
  }
  return events
}
