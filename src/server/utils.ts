import * as fs from 'fs'
import * as path from 'path'
import { LOGS_DIR } from '../main/utils/paths'
import { isRunEvent } from '../shared/runEvents'
import { getRunEvents } from '../main/db/queries/runEvents'
import { reporter } from './observability'
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
 * chunks. The format is inferred from the first row's shape (a `kind` field ⇒
 * events). An empty log is reported as an empty events log so the structured view
 * still renders. Pure (no I/O) so the detection is unit-testable.
 */
export function runLogFromRows(rows: unknown[]): RunLog {
  if (rows.length === 0) return { format: 'events', events: [] }
  if (isRunEvent(rows[0])) {
    return { format: 'events', events: rows.filter(isRunEvent) }
  }
  const entries = rows.filter(
    (r): r is LogEntry =>
      !!r && typeof r === 'object' && typeof (r as LogEntry).chunk === 'string'
  )
  return { format: 'terminal', entries }
}

/**
 * Read a run's log, tagged by format so the client can pick a renderer.
 *
 * Prefers the RDS `run_events` store (P3 change D) so any control-plane replica
 * can serve any run's log — removing the pod-local `/data/logs/<runId>.jsonl`
 * coupling. Falls back to the on-disk JSONL for runs that predate `run_events`
 * (historical runs, or a run whose events never reached RDS), so no history is
 * lost. A missing log is reported as an empty events log.
 */
export async function readRunLog(runId: string): Promise<RunLog> {
  try {
    const events = await getRunEvents(runId)
    if (events.length > 0) return { format: 'events', events }
  } catch (err) {
    // RDS unavailable/transient — fall through to the on-disk log rather than fail.
    reporter.captureException(err, { tags: { component: 'utils', op: 'readRunEvents', runId } })
  }
  return runLogFromRows(readRawLines(runId))
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, '')
}

/**
 * The run's textual output for publish-target delivery. For structured logs this
 * is the assistant narration (which carries any `<!--CONDUIT:PUBLISH-->` markers),
 * falling back to raw stdout/system text; for old terminal logs it's the
 * ANSI-stripped stdout — matching the pre-structured behaviour.
 */
export async function readRunOutputText(runId: string): Promise<string> {
  const log = await readRunLog(runId)
  if (log.format === 'events') {
    const assistant = log.events
      .filter((e) => e.kind === 'assistant' && e.text)
      .map((e) => e.text!.trim())
      .filter(Boolean)
      .join('\n')
    if (assistant) return assistant
    return log.events
      .filter((e) => e.kind === 'raw' && e.text)
      .map((e) => stripAnsi(e.text!).trim())
      .filter(Boolean)
      .join('\n')
  }
  return log.entries
    .filter((e) => e.stream === 'stdout')
    .map((e) => stripAnsi(e.chunk).trim())
    .filter(Boolean)
    .join('\n')
}
