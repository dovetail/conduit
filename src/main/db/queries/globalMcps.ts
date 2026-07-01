import { eq } from 'drizzle-orm'
import { getDb } from '../index'
import { globalMcpServers } from '../schema'
import { getVisibleEntityIds } from './access'
import { deleteSharesForEntity } from './shares'
import type { GlobalMcpServer, McpServerEntry } from '../../../shared/types'

function rowToGlobalMcpServer(row: typeof globalMcpServers.$inferSelect): GlobalMcpServer {
  return {
    id: row.id,
    name: row.name,
    serverKey: row.serverKey,
    serverConfig: JSON.parse(row.serverConfig) as McpServerEntry,
    enabled: row.enabled,
    ownerId: row.ownerId ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

/** MCP server keys are compared case-insensitively for uniqueness. */
function normalizeKey(key: string): string {
  return key.trim().toLowerCase()
}

/**
 * If an existing global MCP has the same serverKey (case-insensitive) as
 * `serverKey`, return its display name; otherwise null. Pass `excludeId` to
 * ignore one row (the server itself when updating).
 */
export async function findGlobalMcpKeyConflict(serverKey: string, excludeId?: string): Promise<string | null> {
  const target = normalizeKey(serverKey)
  const rows = await getDb().select().from(globalMcpServers)
  const hit = rows.find((r) => normalizeKey(r.serverKey) === target && r.id !== excludeId)
  return hit ? hit.name : null
}

/**
 * Given a set of agent MCP server keys, return the first that collides
 * (case-insensitively) with an existing global MCP serverKey, or null if none.
 * Agent and global MCPs share a namespace at run time (global + agent servers
 * are merged by key), so a duplicate would silently shadow the global.
 */
export async function findAgentMcpKeyConflictWithGlobals(keys: string[]): Promise<string | null> {
  if (keys.length === 0) return null
  const rows = await getDb().select().from(globalMcpServers)
  const globalKeys = new Set(rows.map((r) => normalizeKey(r.serverKey)))
  for (const k of keys) {
    if (globalKeys.has(normalizeKey(k))) return k
  }
  return null
}

export async function listGlobalMcps(userId: string, userGroupIds: string[]): Promise<GlobalMcpServer[]> {
  const visibleIds = await getVisibleEntityIds('globalMcpServer', userId, userGroupIds)
  if (visibleIds.length === 0) return []
  const rows = await getDb().select().from(globalMcpServers)
  return rows.filter(r => visibleIds.includes(r.id)).map(rowToGlobalMcpServer)
}

export async function listEnabledGlobalMcps(): Promise<GlobalMcpServer[]> {
  const rows = await getDb().select().from(globalMcpServers).where(eq(globalMcpServers.enabled, true))
  return rows.map(rowToGlobalMcpServer)
}

export async function createGlobalMcp(
  data: Omit<GlobalMcpServer, 'id' | 'createdAt' | 'updatedAt'>,
  ownerId: string
): Promise<GlobalMcpServer> {
  const now = Date.now()
  const id = crypto.randomUUID()

  const conflict = await findGlobalMcpKeyConflict(data.serverKey)
  if (conflict) {
    throw new Error(`An MCP named "${data.serverKey}" already exists (global MCP "${conflict}"). MCP names must be unique.`)
  }

  await getDb().insert(globalMcpServers).values({
    id,
    name: data.name,
    serverKey: data.serverKey,
    serverConfig: JSON.stringify(data.serverConfig),
    enabled: data.enabled,
    ownerId,
    createdAt: now,
    updatedAt: now,
  })

  const rows = await getDb().select().from(globalMcpServers).where(eq(globalMcpServers.id, id))
  if (rows.length === 0) throw new Error(`Failed to create global MCP server with id ${id}`)
  return rowToGlobalMcpServer(rows[0])
}

export async function updateGlobalMcp(
  id: string,
  data: Partial<Omit<GlobalMcpServer, 'id' | 'createdAt' | 'updatedAt'>>
): Promise<GlobalMcpServer> {
  const now = Date.now()

  const updateValues: Partial<typeof globalMcpServers.$inferInsert> = {
    updatedAt: now,
  }

  if (data.name !== undefined) updateValues.name = data.name
  if (data.serverKey !== undefined) {
    const conflict = await findGlobalMcpKeyConflict(data.serverKey, id)
    if (conflict) {
      throw new Error(`An MCP named "${data.serverKey}" already exists (global MCP "${conflict}"). MCP names must be unique.`)
    }
    updateValues.serverKey = data.serverKey
  }
  if (data.serverConfig !== undefined) updateValues.serverConfig = JSON.stringify(data.serverConfig)
  if (data.enabled !== undefined) updateValues.enabled = data.enabled

  await getDb().update(globalMcpServers).set(updateValues).where(eq(globalMcpServers.id, id))

  const rows = await getDb().select().from(globalMcpServers).where(eq(globalMcpServers.id, id))
  if (rows.length === 0) throw new Error(`Global MCP server with id ${id} not found after update`)
  return rowToGlobalMcpServer(rows[0])
}

export async function getGlobalMcp(id: string): Promise<GlobalMcpServer | null> {
  const rows = await getDb().select().from(globalMcpServers).where(eq(globalMcpServers.id, id))
  return rows.length ? rowToGlobalMcpServer(rows[0]) : null
}

export async function deleteGlobalMcp(id: string): Promise<void> {
  await deleteSharesForEntity('globalMcpServer', id)
  await getDb().delete(globalMcpServers).where(eq(globalMcpServers.id, id))
}
