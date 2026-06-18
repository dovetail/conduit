import { eq, and } from 'drizzle-orm'
import { getDb } from '../index'
import { shares } from '../schema'
import type { Share, ShareableEntityType } from '../../../shared/types'

function rowToShare(row: typeof shares.$inferSelect): Share {
  return {
    id: row.id,
    entityType: row.entityType as ShareableEntityType,
    entityId: row.entityId,
    targetType: row.targetType as Share['targetType'],
    targetId: row.targetId ?? null,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
  }
}

export async function getShare(id: string): Promise<Share | null> {
  const rows = await getDb().select().from(shares).where(eq(shares.id, id))
  if (rows.length === 0) return null
  return rowToShare(rows[0])
}

export async function listShares(entityType: ShareableEntityType, entityId: string): Promise<Share[]> {
  const rows = await getDb()
    .select()
    .from(shares)
    .where(and(eq(shares.entityType, entityType), eq(shares.entityId, entityId)))
  return rows.map(rowToShare)
}

export async function createShare(data: {
  entityType: ShareableEntityType
  entityId: string
  targetType: 'user' | 'group' | 'everyone'
  targetId?: string
  createdBy: string
}): Promise<Share> {
  const id = crypto.randomUUID()
  const now = Date.now()

  await getDb().insert(shares).values({
    id,
    entityType: data.entityType,
    entityId: data.entityId,
    targetType: data.targetType,
    targetId: data.targetType === 'everyone' ? null : (data.targetId ?? null),
    createdBy: data.createdBy,
    createdAt: now,
  })

  const rows = await getDb().select().from(shares).where(eq(shares.id, id))
  if (rows.length === 0) throw new Error(`Failed to create share with id ${id}`)
  return rowToShare(rows[0])
}

export async function deleteShare(id: string): Promise<void> {
  await getDb().delete(shares).where(eq(shares.id, id))
}

export async function deleteSharesForEntity(entityType: ShareableEntityType, entityId: string): Promise<void> {
  await getDb()
    .delete(shares)
    .where(and(eq(shares.entityType, entityType), eq(shares.entityId, entityId)))
}
