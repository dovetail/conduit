import { eq, desc } from 'drizzle-orm'
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
    triggerContext: row.triggerContext ? (JSON.parse(row.triggerContext) as TriggerContext) : undefined,
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

export async function getRun(id: string): Promise<ExecutionRun | null> {
  const rows = await getDb().select().from(runs).where(eq(runs.id, id))
  if (rows.length === 0) return null
  return rowToExecutionRun(rows[0])
}

export async function createRun(data: Omit<ExecutionRun, 'id'>): Promise<ExecutionRun> {
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
  })

  const created = await getRun(id)
  if (!created) throw new Error(`Failed to create run with id ${id}`)
  return created
}

export async function updateRun(
  id: string,
  data: Partial<Omit<ExecutionRun, 'id'>>
): Promise<ExecutionRun> {
  const updateValues: Partial<typeof runs.$inferInsert> = {}

  if (data.agentId !== undefined) updateValues.agentId = data.agentId
  if (data.status !== undefined) updateValues.status = data.status
  if (data.startedAt !== undefined) updateValues.startedAt = data.startedAt
  if ('endedAt' in data) updateValues.endedAt = data.endedAt ?? null
  if ('durationMs' in data) updateValues.durationMs = data.durationMs ?? null
  if ('workspacePath' in data) updateValues.workspacePath = data.workspacePath ?? null
  if (data.logPath !== undefined) updateValues.logPath = data.logPath
  if ('exitCode' in data) updateValues.exitCode = data.exitCode ?? null

  await getDb().update(runs).set(updateValues).where(eq(runs.id, id))

  const updated = await getRun(id)
  if (!updated) throw new Error(`Run with id ${id} not found after update`)
  return updated
}

export async function getOrphanedRuns(): Promise<ExecutionRun[]> {
  const rows = await getDb().select().from(runs).where(eq(runs.status, 'running'))
  return rows.map(rowToExecutionRun)
}
