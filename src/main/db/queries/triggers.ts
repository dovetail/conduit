import { eq } from 'drizzle-orm'
import { getDb } from '../index'
import { triggers } from '../schema'
import type { Trigger, TriggerConfig } from '../../../shared/types'

function rowToTrigger(row: typeof triggers.$inferSelect): Trigger {
  return {
    id: row.id,
    agentId: row.agentId,
    name: row.name,
    type: row.type as Trigger['type'],
    config: JSON.parse(row.config) as TriggerConfig,
    enabled: row.enabled,
    lastTriggeredAt: row.lastTriggeredAt ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

export async function listTriggers(agentId: string): Promise<Trigger[]> {
  const rows = await getDb().select().from(triggers).where(eq(triggers.agentId, agentId))
  return rows.map(rowToTrigger)
}

export async function listAllEnabledTriggers(): Promise<Trigger[]> {
  const rows = await getDb().select().from(triggers).where(eq(triggers.enabled, true))
  return rows.map(rowToTrigger)
}

export async function getTrigger(id: string): Promise<Trigger | null> {
  const rows = await getDb().select().from(triggers).where(eq(triggers.id, id))
  if (rows.length === 0) return null
  return rowToTrigger(rows[0])
}

export async function createTrigger(
  data: Omit<Trigger, 'id' | 'createdAt' | 'updatedAt'>
): Promise<Trigger> {
  const now = Date.now()
  const id = crypto.randomUUID()

  await getDb().insert(triggers).values({
    id,
    agentId: data.agentId,
    name: data.name,
    type: data.type,
    config: JSON.stringify(data.config),
    enabled: data.enabled,
    lastTriggeredAt: data.lastTriggeredAt ?? null,
    createdAt: now,
    updatedAt: now,
  })

  const created = await getTrigger(id)
  if (!created) throw new Error(`Failed to create trigger with id ${id}`)
  return created
}

export async function updateTrigger(
  id: string,
  data: Partial<Omit<Trigger, 'id' | 'createdAt' | 'updatedAt'>>
): Promise<Trigger> {
  const now = Date.now()
  const updateValues: Partial<typeof triggers.$inferInsert> = { updatedAt: now }

  if (data.name !== undefined) updateValues.name = data.name
  if (data.type !== undefined) updateValues.type = data.type
  if (data.config !== undefined) updateValues.config = JSON.stringify(data.config)
  if (data.enabled !== undefined) updateValues.enabled = data.enabled
  if (data.lastTriggeredAt !== undefined) updateValues.lastTriggeredAt = data.lastTriggeredAt

  await getDb().update(triggers).set(updateValues).where(eq(triggers.id, id))

  const updated = await getTrigger(id)
  if (!updated) throw new Error(`Trigger with id ${id} not found after update`)
  return updated
}

export async function deleteTrigger(id: string): Promise<void> {
  await getDb().delete(triggers).where(eq(triggers.id, id))
}
