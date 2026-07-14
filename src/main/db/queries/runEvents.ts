import { eq, and, asc, gt } from 'drizzle-orm'
import { getDb, rawQuery } from '../index'
import { runEvents } from '../schema'
import type { RunEvent } from '../../../shared/types'

/**
 * Query layer for the append-only `run_events` log — the RDS event bus + durable
 * run-log store (P3 eventing contract). A run's producer appends events here; the
 * control-plane reads them to serve `runs:getLog` and (for Job runs) re-broadcasts
 * them to WebSocket clients via LISTEN/NOTIFY. Ordering is by the monotonic `seq`
 * Postgres assigns on insert.
 */

/** One persisted event with its assigned ordering key. */
export interface StoredRunEvent {
  seq: number
  event: RunEvent
}

function parseEvent(json: string): RunEvent | null {
  try {
    return JSON.parse(json) as RunEvent
  } catch {
    return null
  }
}

/**
 * Append a batch of events for a run. Inserted in one statement so `seq` is
 * assigned in call order (and, since callers serialize their appends, in event
 * order). When `notify` is set, a `NOTIFY run_events, '<runId>'` is issued after
 * the insert so a control-plane LISTENer wakes and re-broadcasts the new events —
 * used by the out-of-process (Job) executor whose producer is a different pod.
 * The in-process executor broadcasts directly and passes `notify: false` to avoid
 * double-delivery.
 */
export async function appendRunEvents(
  runId: string,
  events: RunEvent[],
  opts: { notify?: boolean } = {}
): Promise<void> {
  if (events.length === 0) return
  const now = Date.now()
  await getDb()
    .insert(runEvents)
    .values(events.map((event) => ({ runId, eventJson: JSON.stringify(event), createdAt: now })))
  if (opts.notify) {
    // pg_notify rather than a raw LISTEN/NOTIFY string so the runId is safely
    // parameterized. Best-effort: a failed notify must not fail the append (the
    // control-plane also reconciles on its own), so swallow errors here.
    try {
      await rawQuery(`SELECT pg_notify('run_events', $1)`, [runId])
    } catch {
      // ignore — the events are persisted; the notify is only a fan-out hint.
    }
  }
}

/** All of a run's events, in order. Malformed rows are skipped (never throw). */
export async function getRunEvents(runId: string): Promise<RunEvent[]> {
  const rows = await getDb()
    .select({ eventJson: runEvents.eventJson })
    .from(runEvents)
    .where(eq(runEvents.runId, runId))
    .orderBy(asc(runEvents.seq))
  const out: RunEvent[] = []
  for (const r of rows) {
    const parsed = parseEvent(r.eventJson)
    if (parsed) out.push(parsed)
  }
  return out
}

/** A run's events with `seq > afterSeq`, in order — for incremental fan-out. */
export async function getRunEventsSince(runId: string, afterSeq: number): Promise<StoredRunEvent[]> {
  const rows = await getDb()
    .select({ seq: runEvents.seq, eventJson: runEvents.eventJson })
    .from(runEvents)
    .where(and(eq(runEvents.runId, runId), gt(runEvents.seq, afterSeq)))
    .orderBy(asc(runEvents.seq))
  const out: StoredRunEvent[] = []
  for (const r of rows) {
    const parsed = parseEvent(r.eventJson)
    if (parsed) out.push({ seq: r.seq, event: parsed })
  }
  return out
}

/** Remove all events for a run (e.g. log-retention cleanup). */
export async function deleteRunEvents(runId: string): Promise<void> {
  await getDb().delete(runEvents).where(eq(runEvents.runId, runId))
}
