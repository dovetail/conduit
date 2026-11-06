import { and, eq, desc, gte, inArray } from 'drizzle-orm'
import { getDb } from '../index'
import { runs } from '../schema'
import type { ExecutionRun, RunStatus, TriggerContext } from '../../../shared/types'

function rowToExecutionRun(row: typeof runs.$inferSelect): ExecutionRun {
  return {
    id: row.id,
    agentId: row.agentId,
    status: row.status as RunStatus,
    startedAt: row.startedAt,
    endedAt: row.endedAt ?? undefined,
    durationMs: row.durationMs ?? undefined,
    workspacePath: row.workspacePath ?? undefined,
    logPath: row.logPath,
    exitCode: row.exitCode ?? undefined,
    triggerContext: row.triggerContext ? JSON.parse(row.triggerContext) as TriggerContext : undefined,
    startedBy: row.startedBy ?? undefined,
    lastLine: row.lastLine ?? undefined,
    workerKind: row.workerKind ?? undefined,
    workerId: row.workerId ?? undefined,
  }
}

export async function listRuns(agentId: string): Promise<ExecutionRun[]> {
  const rows = await getDb()
    .select()
    .from(runs)
    .where(eq(runs.agentId, agentId))
    .orderBy(desc(runs.startedAt))
  return rows.map(rowToExecutionRun)
}

/** Most recent runs across the given agents, newest first, optionally filtered. */
export async function listRecentRuns(opts: {
  agentIds: string[]
  status?: RunStatus
  since?: number
  limit: number
}): Promise<ExecutionRun[]> {
  if (opts.agentIds.length === 0) return []
  const conds = [inArray(runs.agentId, opts.agentIds)]
  if (opts.status) conds.push(eq(runs.status, opts.status))
  if (opts.since != null) conds.push(gte(runs.startedAt, opts.since))
  const rows = await getDb()
    .select()
    .from(runs)
    .where(and(...conds))
    .orderBy(desc(runs.startedAt))
    .limit(opts.limit)
  return rows.map(rowToExecutionRun)
}

export async function getRun(id: string): Promise<ExecutionRun | null> {
  const rows = await getDb().select().from(runs).where(eq(runs.id, id))
  if (rows.length === 0) return null
  return rowToExecutionRun(rows[0])
}

export async function createRun(
  data: Omit<ExecutionRun, 'id'>
): Promise<ExecutionRun> {
  const id = crypto.randomUUID()

  await getDb().insert(runs).values({
    id,
    agentId: data.agentId,
    status: data.status,
    startedAt: data.startedAt,
    endedAt: data.endedAt ?? null,
    durationMs: data.durationMs ?? null,
    workspacePath: data.workspacePath ?? null,
    logPath: data.logPath,
    exitCode: data.exitCode ?? null,
    triggerContext: data.triggerContext ? JSON.stringify(data.triggerContext) : null,
    startedBy: data.startedBy ?? null,
    workerKind: data.workerKind ?? null,
    workerId: data.workerId ?? null,
  })

  const created = await getRun(id)
  if (!created) throw new Error(`Failed to create run with id ${id}`)
  return created
}

function toUpdateValues(data: Partial<Omit<ExecutionRun, 'id'>>): Partial<typeof runs.$inferInsert> {
  const updateValues: Partial<typeof runs.$inferInsert> = {}

  if (data.agentId !== undefined) updateValues.agentId = data.agentId
  if (data.status !== undefined) updateValues.status = data.status
  if (data.startedAt !== undefined) updateValues.startedAt = data.startedAt
  if ('endedAt' in data) updateValues.endedAt = data.endedAt ?? null
  if ('durationMs' in data) updateValues.durationMs = data.durationMs ?? null
  if ('workspacePath' in data) updateValues.workspacePath = data.workspacePath ?? null
  if (data.logPath !== undefined) updateValues.logPath = data.logPath
  if ('exitCode' in data) updateValues.exitCode = data.exitCode ?? null
  if ('lastLine' in data) updateValues.lastLine = data.lastLine ?? null
  if ('workerKind' in data) updateValues.workerKind = data.workerKind ?? null
  if ('workerId' in data) updateValues.workerId = data.workerId ?? null

  return updateValues
}

export async function updateRun(
  id: string,
  data: Partial<Omit<ExecutionRun, 'id'>>
): Promise<ExecutionRun> {
  await getDb().update(runs).set(toUpdateValues(data)).where(eq(runs.id, id))

  const updated = await getRun(id)
  if (!updated) throw new Error(`Run with id ${id} not found after update`)
  return updated
}

/**
 * Persist a terminal update only while the row is still `running`. Replacement-process
 * replay of an already-finalized matching run resolves as a no-op so publish/finalize
 * cannot run twice.
 */
export async function updateRunIfRunning(
  id: string,
  data: Partial<Omit<ExecutionRun, 'id'>>
): Promise<ExecutionRun | null> {
  const rows = await getDb()
    .update(runs)
    .set(toUpdateValues(data))
    .where(and(eq(runs.id, id), eq(runs.status, 'running')))
    .returning()
  if (rows.length === 0) return null
  return rowToExecutionRun(rows[0])
}

/**
 * The agent's currently-running run, if any. DB-backed (unlike the runner's
 * in-process active set) so the one-live-run-per-agent rule holds regardless
 * of which worker factory or pod executes runs.
 */
export async function getRunningRunForAgent(agentId: string): Promise<ExecutionRun | null> {
  const rows = await getDb()
    .select()
    .from(runs)
    .where(and(eq(runs.agentId, agentId), eq(runs.status, 'running')))
    .orderBy(desc(runs.startedAt))
    .limit(1)
  return rows.length > 0 ? rowToExecutionRun(rows[0]) : null
}

export async function getOrphanedRuns(): Promise<ExecutionRun[]> {
  const rows = await getDb()
    .select()
    .from(runs)
    .where(eq(runs.status, 'running'))
  return rows.map(rowToExecutionRun)
}
