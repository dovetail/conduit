import { eq } from 'drizzle-orm'
import { getDb } from '../index'
import { groups, userGroups } from '../schema'
import type { Group } from '../../../shared/types'

function rowToGroup(row: typeof groups.$inferSelect): Group {
  return {
    id: row.id,
    name: row.name,
    parentGroupId: row.parentGroupId ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

export async function upsertGroup(data: { id: string; name: string }): Promise<Group> {
  const now = Date.now()

  await getDb().insert(groups).values({
    id: data.id,
    name: data.name,
    createdAt: now,
    updatedAt: now,
  }).onConflictDoUpdate({
    target: groups.id,
    set: {
      name: data.name,
      updatedAt: now,
    },
  })

  const rows = await getDb().select().from(groups).where(eq(groups.id, data.id))
  if (rows.length === 0) throw new Error(`Failed to upsert group with id ${data.id}`)
  return rowToGroup(rows[0])
}

export async function syncUserGroups(userId: string, groupIds: string[]): Promise<void> {
  await getDb().delete(userGroups).where(eq(userGroups.userId, userId))

  for (const groupId of groupIds) {
    await getDb().insert(userGroups).values({
      userId,
      groupId,
    })
  }
}

export async function getUserGroupIds(userId: string): Promise<string[]> {
  const rows = await getDb()
    .select({ groupId: userGroups.groupId })
    .from(userGroups)
    .where(eq(userGroups.userId, userId))
  return rows.map((r) => r.groupId)
}

export async function listGroups(): Promise<Group[]> {
  const rows = await getDb().select().from(groups)
  return rows.map(rowToGroup)
}
