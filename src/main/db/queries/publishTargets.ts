import { eq } from 'drizzle-orm'
import { getDb } from '../index'
import { publishTargets } from '../schema'
import type { PublishTarget, SlackPublishConfig } from '../../../shared/types'

function rowToPublishTarget(row: typeof publishTargets.$inferSelect): PublishTarget {
  return {
    id: row.id,
    name: row.name,
    type: row.type as PublishTarget['type'],
    config: JSON.parse(row.config) as SlackPublishConfig,
    enabled: row.enabled,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

export async function listPublishTargets(): Promise<PublishTarget[]> {
  const rows = await getDb().select().from(publishTargets)
  return rows.map(rowToPublishTarget)
}

export async function getPublishTarget(id: string): Promise<PublishTarget | null> {
  const rows = await getDb().select().from(publishTargets).where(eq(publishTargets.id, id))
  if (rows.length === 0) return null
  return rowToPublishTarget(rows[0])
}

export async function createPublishTarget(
  data: Omit<PublishTarget, 'id' | 'createdAt' | 'updatedAt'>
): Promise<PublishTarget> {
  const now = Date.now()
  const id = crypto.randomUUID()

  await getDb().insert(publishTargets).values({
    id,
    name: data.name,
    type: data.type,
    config: JSON.stringify(data.config),
    enabled: data.enabled,
    createdAt: now,
    updatedAt: now,
  })

  const created = await getPublishTarget(id)
  if (!created) throw new Error(`Failed to create publish target with id ${id}`)
  return created
}

export async function updatePublishTarget(
  id: string,
  data: Partial<Omit<PublishTarget, 'id' | 'createdAt' | 'updatedAt'>>
): Promise<PublishTarget> {
  const now = Date.now()

  const updateValues: Partial<typeof publishTargets.$inferInsert> = { updatedAt: now }

  if (data.name !== undefined) updateValues.name = data.name
  if (data.type !== undefined) updateValues.type = data.type
  if (data.config !== undefined) updateValues.config = JSON.stringify(data.config)
  if (data.enabled !== undefined) updateValues.enabled = data.enabled

  await getDb().update(publishTargets).set(updateValues).where(eq(publishTargets.id, id))

  const updated = await getPublishTarget(id)
  if (!updated) throw new Error(`Publish target with id ${id} not found after update`)
  return updated
}

export async function deletePublishTarget(id: string): Promise<void> {
  await getDb().delete(publishTargets).where(eq(publishTargets.id, id))
}
