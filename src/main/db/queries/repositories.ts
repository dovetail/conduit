import * as fs from 'fs'
import * as path from 'path'
import { eq } from 'drizzle-orm'
import { getDb } from '../index'
import { repositories, agents } from '../schema'
import { REPOS_DIR } from '../../utils/paths'
import { getVisibleEntityIds } from './access'
import { deleteSharesForEntity } from './shares'
import type { Repository } from '../../../shared/types'

function rowToRepository(row: typeof repositories.$inferSelect): Repository {
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    defaultBranch: row.defaultBranch,
    authMethod: row.authMethod as Repository['authMethod'],
    syncStatus: row.syncStatus as Repository['syncStatus'],
    syncError: row.syncError ?? undefined,
    lastSyncedAt: row.lastSyncedAt ?? undefined,
    clonePath: row.clonePath ?? undefined,
    ownerId: row.ownerId ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

export async function listRepositories(userId: string, userGroupIds: string[]): Promise<Repository[]> {
  const visibleIds = await getVisibleEntityIds('repository', userId, userGroupIds)
  if (visibleIds.length === 0) return []
  const rows = await getDb().select().from(repositories)
  return rows.filter(r => visibleIds.includes(r.id)).map(rowToRepository)
}

export async function getRepository(id: string): Promise<Repository | null> {
  const rows = await getDb().select().from(repositories).where(eq(repositories.id, id))
  if (rows.length === 0) return null
  return rowToRepository(rows[0])
}

export async function createRepository(
  data: Omit<Repository, 'id' | 'createdAt' | 'updatedAt' | 'syncStatus' | 'clonePath'>,
  ownerId: string
): Promise<Repository> {
  const now = Date.now()
  const id = crypto.randomUUID()
  const clonePath = path.join(REPOS_DIR, id)

  await getDb().insert(repositories).values({
    id,
    name: data.name,
    url: data.url,
    defaultBranch: data.defaultBranch ?? 'main',
    authMethod: data.authMethod ?? 'none',
    syncStatus: 'pending',
    clonePath,
    ownerId,
    createdAt: now,
    updatedAt: now,
  })

  const created = await getRepository(id)
  if (!created) throw new Error(`Failed to create repository with id ${id}`)
  return created
}

export async function updateRepository(
  id: string,
  data: Partial<Omit<Repository, 'id' | 'createdAt' | 'updatedAt'>>
): Promise<Repository> {
  const now = Date.now()

  const updateValues: Partial<typeof repositories.$inferInsert> = {
    updatedAt: now,
  }

  if (data.name !== undefined) updateValues.name = data.name
  if (data.url !== undefined) updateValues.url = data.url
  if (data.defaultBranch !== undefined) updateValues.defaultBranch = data.defaultBranch
  if (data.authMethod !== undefined) updateValues.authMethod = data.authMethod
  if (data.syncStatus !== undefined) updateValues.syncStatus = data.syncStatus
  if ('syncError' in data) updateValues.syncError = data.syncError ?? null
  if ('lastSyncedAt' in data) updateValues.lastSyncedAt = data.lastSyncedAt ?? null
  if ('clonePath' in data) updateValues.clonePath = data.clonePath ?? null

  await getDb().update(repositories).set(updateValues).where(eq(repositories.id, id))

  const updated = await getRepository(id)
  if (!updated) throw new Error(`Repository with id ${id} not found after update`)
  return updated
}

export async function deleteRepository(id: string): Promise<void> {
  // Unset repositoryId on any agents referencing this repo
  const allAgents = await getDb().select().from(agents)
  for (const agent of allAgents) {
    if (agent.repositoryId === id) {
      await getDb().update(agents).set({ repositoryId: null }).where(eq(agents.id, agent.id))
    }
  }

  // Get clone path before deleting the record
  const repo = await getRepository(id)
  const clonePath = repo?.clonePath

  await deleteSharesForEntity('repository', id)
  await getDb().delete(repositories).where(eq(repositories.id, id))

  // Clean up on-disk clone
  if (clonePath) {
    try {
      fs.rmSync(clonePath, { recursive: true, force: true })
    } catch {
      // Ignore — directory may not exist
    }
  }
}
