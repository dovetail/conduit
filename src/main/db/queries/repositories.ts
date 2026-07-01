import * as fs from 'fs'
import * as path from 'path'
import { eq } from 'drizzle-orm'
import { getDb } from '../index'
import { repositories, agents } from '../schema'
import { REPOS_DIR } from '../../utils/paths'
import { getVisibleEntityIds } from './access'
import { deleteSharesForEntity } from './shares'
import type { Repository } from '../../../shared/types'

/**
 * Repository write payload at the persistence layer. Unlike the client-facing
 * `RepositoryInput`, the GitHub App key arrives here already encrypted
 * (`githubPrivateKeyEnc`) — encryption happens at the server handler boundary.
 */
export type RepoWriteData = Omit<
  Repository,
  'id' | 'createdAt' | 'updatedAt' | 'syncStatus' | 'clonePath' | 'hasGithubKey'
> & {
  /** AES-256-GCM-encrypted GitHub App private key blob. */
  githubPrivateKeyEnc?: string
}

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
    githubAppId: row.githubAppId ?? undefined,
    // Never expose the encrypted key — surface only whether one is stored.
    hasGithubKey: !!row.githubPrivateKeyEnc,
    commitAuthorName: row.commitAuthorName ?? undefined,
    commitAuthorEmail: row.commitAuthorEmail ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

/**
 * Server-only accessor for a repo's GitHub App credentials, including the
 * encrypted private key. Used for minting installation tokens — never returned
 * over the wire to clients.
 */
export async function getRepositoryCredentials(
  id: string
): Promise<{ githubAppId?: string; githubPrivateKeyEnc?: string } | null> {
  const rows = await getDb().select().from(repositories).where(eq(repositories.id, id))
  if (rows.length === 0) return null
  return {
    githubAppId: rows[0].githubAppId ?? undefined,
    githubPrivateKeyEnc: rows[0].githubPrivateKeyEnc ?? undefined,
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
  data: RepoWriteData,
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
    githubAppId: data.githubAppId ?? null,
    githubPrivateKeyEnc: data.githubPrivateKeyEnc ?? null,
    commitAuthorName: data.commitAuthorName ?? null,
    commitAuthorEmail: data.commitAuthorEmail ?? null,
    createdAt: now,
    updatedAt: now,
  })

  const created = await getRepository(id)
  if (!created) throw new Error(`Failed to create repository with id ${id}`)
  return created
}

export async function updateRepository(
  id: string,
  data: Partial<RepoWriteData & Pick<Repository, 'syncStatus' | 'clonePath'>>
): Promise<Repository> {
  const now = Date.now()

  const updateValues: Partial<typeof repositories.$inferInsert> = {
    updatedAt: now,
  }

  if (data.name !== undefined) updateValues.name = data.name
  if (data.url !== undefined) updateValues.url = data.url
  if (data.defaultBranch !== undefined) updateValues.defaultBranch = data.defaultBranch
  if ('commitAuthorName' in data) updateValues.commitAuthorName = data.commitAuthorName || null
  if ('commitAuthorEmail' in data) updateValues.commitAuthorEmail = data.commitAuthorEmail || null
  if (data.syncStatus !== undefined) updateValues.syncStatus = data.syncStatus
  if ('syncError' in data) updateValues.syncError = data.syncError ?? null
  if ('lastSyncedAt' in data) updateValues.lastSyncedAt = data.lastSyncedAt ?? null
  if ('clonePath' in data) updateValues.clonePath = data.clonePath ?? null
  if (data.authMethod !== undefined) {
    updateValues.authMethod = data.authMethod
    // Drop stored GitHub App credentials when moving away from githubapp auth so
    // a decryptable key doesn't linger (and isn't silently reused on switch-back).
    if (data.authMethod !== 'githubapp') {
      updateValues.githubAppId = null
      updateValues.githubPrivateKeyEnc = null
    }
  }
  if (data.githubAppId !== undefined) updateValues.githubAppId = data.githubAppId || null
  // Only overwrite the stored key when a new (encrypted) one is supplied — an
  // absent githubPrivateKeyEnc leaves the existing key untouched.
  if (data.githubPrivateKeyEnc !== undefined) {
    updateValues.githubPrivateKeyEnc = data.githubPrivateKeyEnc
  }

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
