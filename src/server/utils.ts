import * as fs from 'fs'
import * as path from 'path'
import { LOGS_DIR } from '../main/utils/paths'
import { isRunEvent } from '../shared/runEvents'
import type { LogEntry, RunLog } from '../shared/types'

/** Parse a run's JSONL log into raw objects, skipping blank/malformed lines. */
function readRawLines(runId: string): unknown[] {
  const logPath = path.join(LOGS_DIR, `${runId}.jsonl`)
  if (!fs.existsSync(logPath)) return []
  const raw = fs.readFileSync(logPath, 'utf8')
  const out: unknown[] = []
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      out.push(JSON.parse(trimmed))
    } catch {
      // Skip malformed JSONL lines
    }
  }
  return out
}

/**
 * Tag parsed log rows by format so the client can pick a renderer. New runs
 * persist structured `RunEvent`s; pre-existing runs persisted ANSI `LogEntry`
 * chunks. The format is inferred from the first *meaningful* row (a `kind`
 * field ⇒ events; a `chunk` field ⇒ terminal). Delivery-sequence metadata-only
 * rows (`_deliverySequence` without `kind`/`chunk`) are skipped so sequenced
 * remote logs still render as events. An empty log is reported as an empty
 * events log so the structured view still renders. Pure (no I/O) so the
 * detection is unit-testable.
 */
export function runLogFromRows(rows: unknown[]): RunLog {
  const meaningful = rows.filter((row) => isRunEvent(row) || isLegacyLogEntry(row))
  if (meaningful.length === 0) return { format: 'events', events: [] }
  if (isRunEvent(meaningful[0])) {
    return { format: 'events', events: rows.filter(isRunEvent) }
  }
  const entries = meaningful.filter(isLegacyLogEntry)
  return { format: 'terminal', entries }
}

function isLegacyLogEntry(row: unknown): row is LogEntry {
  return !!row && typeof row === 'object' && typeof (row as LogEntry).chunk === 'string'
}

/**
 * Read a run's log, tagged by format so the client can pick a renderer. A
 * missing log is reported as an empty events log.
 */
export function readRunLog(runId: string): RunLog {
  return runLogFromRows(readRawLines(runId))
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, '')
}

/**
 * The run's textual output for publish-target delivery, one entry per message.
 * For structured logs this is the assistant narration (which carries any
 * publish-block markers), falling back to raw stdout/system text; for old
 * terminal logs it's the ANSI-stripped stdout — matching the pre-structured
 * behaviour.
 */
export function readRunOutputMessages(runId: string): string[] {
  const log = readRunLog(runId)
  if (log.format === 'events') {
    const assistant = log.events
      .filter((e) => e.kind === 'assistant' && e.text)
      .map((e) => e.text!.trim())
      .filter(Boolean)
    if (assistant.length > 0) return assistant
    return log.events
      .filter((e) => e.kind === 'raw' && e.text)
      .map((e) => stripAnsi(e.text!).trim())
      .filter(Boolean)
  }
  return log.entries
    .filter((e) => e.stream === 'stdout')
    .map((e) => stripAnsi(e.chunk).trim())
    .filter(Boolean)
}
