import { eq } from 'drizzle-orm'
import { getDb } from '../index'
import { globalMcpServers } from '../schema'
import type { GlobalMcpServer, McpServerEntry } from '../../../shared/types'

function rowToGlobalMcpServer(row: typeof globalMcpServers.$inferSelect): GlobalMcpServer {
  return {
    id: row.id,
    name: row.name,
    serverKey: row.serverKey,
    serverConfig: JSON.parse(row.serverConfig) as McpServerEntry,
    enabled: row.enabled,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

export async function listGlobalMcps(): Promise<GlobalMcpServer[]> {
  const rows = await getDb().select().from(globalMcpServers)
  return rows.map(rowToGlobalMcpServer)
}

export async function listEnabledGlobalMcps(): Promise<GlobalMcpServer[]> {
  const rows = await getDb().select().from(globalMcpServers).where(eq(globalMcpServers.enabled, true))
  return rows.map(rowToGlobalMcpServer)
}

export async function createGlobalMcp(
  data: Omit<GlobalMcpServer, 'id' | 'createdAt' | 'updatedAt'>
): Promise<GlobalMcpServer> {
  const now = Date.now()
  const id = crypto.randomUUID()

  await getDb().insert(globalMcpServers).values({
    id,
    name: data.name,
    serverKey: data.serverKey,
    serverConfig: JSON.stringify(data.serverConfig),
    enabled: data.enabled,
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

  const updateValues: Partial<typeof globalMcpServers.$inferInsert> = { updatedAt: now }

  if (data.name !== undefined) updateValues.name = data.name
  if (data.serverKey !== undefined) updateValues.serverKey = data.serverKey
  if (data.serverConfig !== undefined) updateValues.serverConfig = JSON.stringify(data.serverConfig)
  if (data.enabled !== undefined) updateValues.enabled = data.enabled

  await getDb().update(globalMcpServers).set(updateValues).where(eq(globalMcpServers.id, id))

  const rows = await getDb().select().from(globalMcpServers).where(eq(globalMcpServers.id, id))
  if (rows.length === 0) throw new Error(`Global MCP server with id ${id} not found after update`)
  return rowToGlobalMcpServer(rows[0])
}

export async function deleteGlobalMcp(id: string): Promise<void> {
  await getDb().delete(globalMcpServers).where(eq(globalMcpServers.id, id))
}
