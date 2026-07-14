import type { PoolClient } from 'pg'
import type { RunEvent } from '../shared/types'
import { getPool } from '../main/db/index'
import { getRunEventsSince, type StoredRunEvent } from '../main/db/queries/runEvents'
import { reporter } from './observability'

/**
 * The RDS-backed run-event bus (P3 eventing contract).
 *
 * When a run executes out-of-process (as a Kubernetes Job), its pod appends each
 * `RunEvent` to the `run_events` table and issues `NOTIFY run_events, '<runId>'`.
 * The control-plane owns every browser WebSocket, so it must fan those events out
 * to its clients. This bus holds one Postgres connection open on `LISTEN
 * run_events`; on each notification it reads the run's new events (those with a
 * `seq` past the last it forwarded) and re-`broadcast()`s them as `run:events`,
 * exactly as the in-process runner does for its own runs.
 *
 * In-process runs broadcast directly and do NOT notify, so this bus stays inert
 * for them — no double-delivery. It exists so flipping `CONDUIT_EXECUTOR=job`
 * later needs no further control-plane wiring.
 */

export type BroadcastFn = (channel: string, payload: unknown) => void

/**
 * Pure fan-out decision: from a run's events newer-than-`lastSeq`, return the
 * events to broadcast and the new high-water `seq`. Kept side-effect-free so the
 * de-duplication (never re-send an event already forwarded) is unit-testable.
 */
export function selectUnsentEvents(
  rows: StoredRunEvent[],
  lastSeq: number
): { events: RunEvent[]; maxSeq: number } {
  let maxSeq = lastSeq
  const events: RunEvent[] = []
  for (const r of rows) {
    if (r.seq <= lastSeq) continue
    events.push(r.event)
    if (r.seq > maxSeq) maxSeq = r.seq
  }
  return { events, maxSeq }
}

/** Delay before attempting to re-establish a dropped LISTEN connection. */
const RECONNECT_DELAY_MS = 2_000

export class RunEventBus {
  private client: PoolClient | null = null
  private stopped = false
  /** High-water `seq` already broadcast, per run — so a re-read never re-sends. */
  private readonly lastSeq = new Map<string, number>()

  constructor(private readonly broadcast: BroadcastFn) {}

  /** Begin listening. Never throws — a failure schedules a reconnect instead, so
   *  a transient DB hiccup at startup can't crash the server. */
  async start(): Promise<void> {
    await this.connect()
  }

  stop(): void {
    this.stopped = true
    this.release()
  }

  private release(): void {
    const client = this.client
    this.client = null
    if (client) {
      client.removeAllListeners('notification')
      client.removeAllListeners('error')
      // Return the dedicated connection to the pool.
      try {
        client.release()
      } catch {
        // already released / errored — nothing to do.
      }
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped) return
    this.release()
    const timer = setTimeout(() => {
      void this.connect()
    }, RECONNECT_DELAY_MS)
    if (typeof timer.unref === 'function') timer.unref()
  }

  private async connect(): Promise<void> {
    if (this.stopped) return
    try {
      const client = await getPool().connect()
      this.client = client
      client.on('notification', (msg) => {
        if (msg.channel === 'run_events' && msg.payload) {
          void this.onNotify(msg.payload)
        }
      })
      // A dropped connection (RDS failover, idle timeout) must not go unnoticed —
      // reconnect so live Job runs keep streaming.
      client.on('error', (err) => {
        reporter.captureException(err, { tags: { component: 'runEventBus', op: 'connection' } })
        this.scheduleReconnect()
      })
      await client.query('LISTEN run_events')
    } catch (err) {
      reporter.captureException(err, { tags: { component: 'runEventBus', op: 'connect' } })
      this.scheduleReconnect()
    }
  }

  private async onNotify(runId: string): Promise<void> {
    try {
      const last = this.lastSeq.get(runId) ?? 0
      const rows = await getRunEventsSince(runId, last)
      const { events, maxSeq } = selectUnsentEvents(rows, last)
      if (events.length > 0) {
        this.lastSeq.set(runId, maxSeq)
        this.broadcast('run:events', { runId, events })
      }
    } catch (err) {
      reporter.captureException(err, { tags: { component: 'runEventBus', op: 'onNotify', runId } })
    }
  }
}
