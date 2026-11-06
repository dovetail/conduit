/**
 * Adapter for the Cursor CLI (`cursor-agent`) — a headless agent runner.
 *
 * Runs in print mode with stream-json output:
 *   cursor-agent -p --output-format stream-json --force --approve-mcps --trust [--model <id>]
 *
 * - `--force` is Cursor's "Run Everything" mode (`--yolo` alias): commands and
 *   edits execute without approval — the headless equivalent of Claude's
 *   `--dangerously-skip-permissions` / Amp's `--dangerously-allow-all`.
 * - `--approve-mcps` auto-approves any MCP servers the workspace/user config
 *   provides so the run never blocks on a confirmation prompt.
 * - `--trust` accepts Conduit's newly materialized workspace without an
 *   interactive trust prompt.
 * - The prompt is written to stdin after spawn (cursor-agent reads piped stdin
 *   as the prompt in print mode).
 *
 * MCP note: cursor-agent has no `--mcp-config` flag — it loads MCP servers from
 * the workspace's `.cursor/mcp.json` and the user's global Cursor config, so
 * the worker merges Conduit's managed MCP config into the workspace file for
 * the run (see server/workers/cursorMcpConfig.ts).
 */
export interface CursorArgsOptions {
  /** Exact model identifier from `cursor-agent models`. Unset = CLI default ('auto'). */
  model?: string
  /**
   * Retained in the serializable RunSpec for compatibility with existing
   * agents that stored one of the old UI's base models separately from effort.
   * New configurations use an exact model identifier and ignore this field.
   */
  effort?: string
}

/** Base identifiers offered by the old Cursor model picker. Only these are
 * eligible for legacy effort composition; arbitrary/exact IDs pass through. */
const LEGACY_CURSOR_BASE_MODELS = new Set([
  'claude-opus-5',
  'claude-opus-4-8',
  'claude-sonnet-5',
  'gpt-5.6-sol',
  'gpt-5.5',
  'kimi-k3',
])

function resolveCursorModel(model: string, effort?: string): string {
  return effort && LEGACY_CURSOR_BASE_MODELS.has(model) ? `${model}-${effort}` : model
}

/**
 * Build the CLI arguments for `cursor-agent`. The prompt is NOT included — it
 * is written to stdin after spawn.
 */
export function buildCursorArgs(opts: CursorArgsOptions = {}): string[] {
  const args = ['-p', '--output-format', 'stream-json', '--force', '--approve-mcps', '--trust']
  const model = opts.model?.trim()
  if (model) args.push('--model', resolveCursorModel(model, opts.effort))
  return args
}

import type { RunEventInit } from '../../../shared/types'
import { capText } from '../../../shared/runEvents'

interface CursorContentBlock {
  type: string
  text?: string
}

interface CursorStreamEvent {
  type: string
  subtype?: string
  call_id?: string
  is_error?: boolean
  /** Present on the system/init event: the display name of the running model. */
  model?: string
  message?: {
    content?: CursorContentBlock[]
  }
  /** Tool payloads are nested under a single tool-type key, e.g.
   * `{ shellToolCall: { args: {...}, result: {...} } }`. */
  tool_call?: Record<string, unknown>
}

/** Display-name overrides so Cursor's tools reuse the familiar run-log labels
 * (and their `describeToolUse` subtitles — shellToolCall's args carry `command`). */
const CURSOR_TOOL_NAMES: Record<string, string> = {
  shellToolCall: 'Bash',
  readToolCall: 'Read',
  writeToolCall: 'Write',
  editToolCall: 'Edit',
  strReplaceToolCall: 'Edit',
  deleteToolCall: 'Delete',
  grepToolCall: 'Grep',
  globToolCall: 'Glob',
  mcpToolCall: 'MCP',
  webSearchToolCall: 'WebSearch',
  fetchToolCall: 'WebFetch',
}

/** 'shellToolCall' → 'Bash'; unknown 'fooBarToolCall' → 'FooBar'. */
function cursorToolName(rawName: string): string {
  const known = CURSOR_TOOL_NAMES[rawName]
  if (known) return known
  const stripped = rawName.replace(/ToolCall$/, '')
  return stripped ? stripped[0].toUpperCase() + stripped.slice(1) : rawName
}

function extractCursorTool(
  toolCall: Record<string, unknown> | undefined
): { rawName: string; payload: Record<string, unknown> } {
  const keys = toolCall ? Object.keys(toolCall) : []
  if (keys.length === 0) return { rawName: 'tool', payload: {} }
  const rawName = keys[0]
  const payload = toolCall![rawName]
  return {
    rawName,
    payload: payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {},
  }
}

/** Pull displayable output (and an error flag) out of a completed tool payload. */
function extractCursorToolResult(payload: Record<string, unknown>): { content: string; isError: boolean } {
  const result = payload.result
  if (!result || typeof result !== 'object') return { content: '', isError: false }
  const r = result as Record<string, unknown>

  if (r.error) {
    return { content: typeof r.error === 'string' ? r.error : JSON.stringify(r.error), isError: true }
  }

  const success = r.success
  if (!success || typeof success !== 'object') return { content: JSON.stringify(result), isError: false }
  const s = success as Record<string, unknown>

  // Shell-style results carry stdout/stderr/exitCode — surface them like a terminal.
  if (typeof s.stdout === 'string' || typeof s.stderr === 'string') {
    const exitCode = typeof s.exitCode === 'number' ? s.exitCode : 0
    const out = [s.stdout, s.stderr]
      .filter((v): v is string => typeof v === 'string' && v.length > 0)
      .join('\n')
    if (exitCode !== 0) {
      return { content: `Exit code ${exitCode}\n${out}`.trim(), isError: true }
    }
    return { content: out, isError: false }
  }

  return { content: JSON.stringify(success, null, 2), isError: false }
}

/**
 * Parse a single NDJSON line from `cursor-agent --output-format stream-json`
 * into structured RunEvents (without a timestamp — the runner stamps `t`).
 * Mirrors parseClaudeEvents; Cursor emits tool calls as standalone `tool_call`
 * events rather than assistant content blocks, and `thinking` deltas are skipped.
 * Unparseable lines (e.g. the plain-text "Cannot use this model: …" error)
 * become `raw` events so nothing is dropped.
 */
export function parseCursorEvents(line: string): RunEventInit[] {
  const trimmed = line.trim()
  if (!trimmed) return []

  let event: CursorStreamEvent
  try {
    event = JSON.parse(trimmed)
  } catch {
    return [{ kind: 'raw', stream: 'stdout', text: trimmed }]
  }

  switch (event.type) {
    case 'assistant': {
      const events: RunEventInit[] = []
      for (const block of event.message?.content ?? []) {
        if (block.type === 'text' && block.text) {
          events.push({ kind: 'assistant', text: block.text })
        }
      }
      return events
    }

    case 'tool_call': {
      const { rawName, payload } = extractCursorTool(event.tool_call)
      if (event.subtype === 'started') {
        return [
          {
            kind: 'tool_use',
            toolUseId: event.call_id,
            toolName: cursorToolName(rawName),
            toolInput: payload.args,
          },
        ]
      }
      if (event.subtype === 'completed') {
        const { content, isError } = extractCursorToolResult(payload)
        return [{ kind: 'tool_result', toolUseId: event.call_id, content: capText(content), isError }]
      }
      return []
    }

    case 'result': {
      const ok = event.subtype === 'success' && event.is_error !== true
      return [{ kind: 'result', isError: !ok, text: ok ? 'Completed' : 'Failed' }]
    }

    case 'system':
      // The init event names the model that actually launched — surface it so the
      // run log records which exact model identifier was in effect.
      if (event.subtype === 'init') {
        return [
          {
            kind: 'raw',
            stream: 'system',
            text: `[cursor-agent started — model: ${event.model ?? 'default'}]`,
          },
        ]
      }
      return []

    default:
      // user (prompt echo), thinking deltas — not displayed
      return []
  }
}
