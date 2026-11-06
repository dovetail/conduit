import { and, eq, isNull } from 'drizzle-orm'
import { getDb } from '../index'
import { agents } from '../schema'
import { getVisibleEntityIds } from './access'
import { findAgentMcpKeyConflictWithGlobals } from './globalMcps'
import type { AgentConfig, McpServersConfig } from '../../../shared/types'

/** Reject agent MCP server keys that collide with an existing global MCP. */
async function assertNoGlobalMcpKeyConflict(mcpConfig: McpServersConfig | undefined): Promise<void> {
  const conflict = await findAgentMcpKeyConflictWithGlobals(Object.keys(mcpConfig?.mcpServers ?? {}))
  if (conflict) {
    throw new Error(
      `This agent has an MCP named "${conflict}" that conflicts with a global MCP of the same name. ` +
        'MCP names must be unique across global and agent scopes.'
    )
  }
}

function rowToAgentConfig(row: typeof agents.$inferSelect): AgentConfig {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? undefined,
    runner: row.runner as AgentConfig['runner'],
    prompt: row.prompt,
    envVars: JSON.parse(row.envVars ?? '{}') as Record<string, string>,
    mcpConfig: JSON.parse(row.mcpConfig ?? '{"mcpServers":{}}') as McpServersConfig,
    gistId: row.gistId ?? undefined,
    workingDir: row.workingDir ?? undefined,
    publishTargetIds: row.publishTargetIds ? JSON.parse(row.publishTargetIds) as string[] : undefined,
    repositoryId: row.repositoryId ?? undefined,
    effort: (row.effort ?? undefined) as AgentConfig['effort'],
    model: row.model ?? undefined,
    bgTaskTimeoutSeconds: row.bgTaskTimeoutSeconds ?? undefined,
    memoryCapMb: row.memoryCapMb ?? undefined,
    workerMemoryMib: row.workerMemoryMib ?? undefined,
    enableRepoMcps: row.enableRepoMcps ?? false,
    ownerId: row.ownerId ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

export async function listAgents(userId: string, userGroupIds: string[]): Promise<AgentConfig[]> {
  const visibleIds = await getVisibleEntityIds('agent', userId, userGroupIds)
  if (visibleIds.length === 0) return []
  // Soft-deleted agents are hidden from every listing.
  const rows = await getDb().select().from(agents).where(isNull(agents.deletedAt))
  return rows.filter(r => visibleIds.includes(r.id)).map(rowToAgentConfig)
}

export async function getAgent(id: string): Promise<AgentConfig | null> {
  // Exclude soft-deleted agents. This single guard makes a deleted agent inert
  // everywhere it's fetched by id — run starts, publishing, chat, MCP OAuth.
  const rows = await getDb()
    .select()
    .from(agents)
    .where(and(eq(agents.id, id), isNull(agents.deletedAt)))
  if (rows.length === 0) return null
  return rowToAgentConfig(rows[0])
}

export async function createAgent(
  data: Omit<AgentConfig, 'id' | 'createdAt' | 'updatedAt'>,
  ownerId: string
): Promise<AgentConfig> {
  const now = Date.now()
  const id = crypto.randomUUID()

  await assertNoGlobalMcpKeyConflict(data.mcpConfig)

  await getDb().insert(agents).values({
    id,
    name: data.name,
    description: data.description ?? null,
    runner: data.runner,
    prompt: data.prompt,
    envVars: JSON.stringify(data.envVars ?? {}),
    mcpConfig: JSON.stringify(data.mcpConfig ?? { mcpServers: {} }),
    gistId: data.gistId ?? null,
    workingDir: data.workingDir ?? null,
    publishTargetIds: data.publishTargetIds ? JSON.stringify(data.publishTargetIds) : null,
    repositoryId: data.repositoryId ?? null,
    effort: data.effort ?? null,
    model: data.model ?? null,
    bgTaskTimeoutSeconds: data.bgTaskTimeoutSeconds ?? null,
    memoryCapMb: data.memoryCapMb ?? null,
    workerMemoryMib: data.workerMemoryMib ?? null,
    enableRepoMcps: data.enableRepoMcps ?? false,
    ownerId,
    createdAt: now,
    updatedAt: now,
  })

  const created = await getAgent(id)
  if (!created) throw new Error(`Failed to create agent with id ${id}`)
  return created
}

export async function updateAgent(
  id: string,
  data: Partial<Omit<AgentConfig, 'id' | 'createdAt' | 'updatedAt'>>
): Promise<AgentConfig> {
  const now = Date.now()

  const updateValues: Partial<typeof agents.$inferInsert> = {
    updatedAt: now,
  }

  if (data.mcpConfig !== undefined) await assertNoGlobalMcpKeyConflict(data.mcpConfig)

  if (data.name !== undefined) updateValues.name = data.name
  if ('description' in data) updateValues.description = data.description ?? null
  if (data.runner !== undefined) updateValues.runner = data.runner
  if (data.prompt !== undefined) updateValues.prompt = data.prompt
  if (data.envVars !== undefined) updateValues.envVars = JSON.stringify(data.envVars)
  if (data.mcpConfig !== undefined) updateValues.mcpConfig = JSON.stringify(data.mcpConfig)
  if ('gistId' in data) updateValues.gistId = data.gistId ?? null
  if ('workingDir' in data) updateValues.workingDir = data.workingDir ?? null
  if ('publishTargetIds' in data) updateValues.publishTargetIds = data.publishTargetIds ? JSON.stringify(data.publishTargetIds) : null
  if ('repositoryId' in data) updateValues.repositoryId = data.repositoryId ?? null
  if ('effort' in data) updateValues.effort = data.effort ?? null
  if ('model' in data) updateValues.model = data.model ?? null
  if ('bgTaskTimeoutSeconds' in data) updateValues.bgTaskTimeoutSeconds = data.bgTaskTimeoutSeconds ?? null
  if ('memoryCapMb' in data) updateValues.memoryCapMb = data.memoryCapMb ?? null
  if ('workerMemoryMib' in data) updateValues.workerMemoryMib = data.workerMemoryMib ?? null
  if ('enableRepoMcps' in data) updateValues.enableRepoMcps = data.enableRepoMcps ?? false

  await getDb().update(agents).set(updateValues).where(eq(agents.id, id))

  const updated = await getAgent(id)
  if (!updated) throw new Error(`Agent with id ${id} not found after update`)
  return updated
}

/**
 * Soft-delete: never remove the row. `runs.agent_id` references `agents.id` with
 * ON DELETE RESTRICT, so a hard DELETE fails for any agent that has ever run — and
 * would destroy its run history besides. We stamp `deletedAt` instead, which hides
 * the agent from every listing while keeping its runs (and their FK) intact.
 *
 * Shares are deliberately preserved so a manual DB-level restore (`deleted_at =
 * NULL`) brings the agent back with its sharing untouched.
 */
export async function deleteAgent(id: string): Promise<void> {
  const now = Date.now()
  await getDb().update(agents).set({ deletedAt: now, updatedAt: now }).where(eq(agents.id, id))
}
