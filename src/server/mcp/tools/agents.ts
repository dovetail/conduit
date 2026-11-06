import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { createAgent, deleteAgent, listAgents, updateAgent } from '../../../main/db/queries/agents'
import { listRuns } from '../../../main/db/queries/runs'
import { listTriggers } from '../../../main/db/queries/triggers'
import { getRepository } from '../../../main/db/queries/repositories'
import { getPublishTarget } from '../../../main/db/queries/publishTargets'
import { canAccessEntity } from '../../../main/db/queries/access'
import { listGlobalMcps } from '../../../main/db/queries/globalMcps'
import { ClientError } from '../../errors'
import { checkMcpServerHealth, listMcpServerTools } from '../../mcpServerProbe'
import { isOwnedBy, requireAgent, requireAgentOwner, type McpCaller } from '../context'
import { applyRecordPatch, mergeMcpEntry, redactAgent, redactMcpEntry, redactTrigger } from '../redact'
import { registerTool, type ToolEnv } from '../registry'
import { summarizeRun } from './runs'
import type { AgentConfig, McpServerEntry } from '../../../shared/types'

export const runnerSchema = z.enum(['claude', 'amp', 'cursor'])
const effortSchema = z.enum(['low', 'medium', 'high', 'xhigh', 'max'])

export const mcpServerEntrySchema = z
  .object({
    type: z
      .enum(['url', 'http', 'streamable-http', 'sse', 'stdio'])
      .optional()
      .describe("Transport. Use 'http' for remote Streamable-HTTP servers, 'stdio' for local commands."),
    url: z.string().optional().describe('Server URL (remote servers).'),
    command: z.string().optional().describe('Executable to launch (stdio servers).'),
    args: z.array(z.string()).optional(),
    headers: z
      .record(z.string(), z.string())
      .optional()
      .describe('HTTP headers. Send "[redacted]" to keep a stored value unchanged.'),
    env: z
      .record(z.string(), z.string())
      .optional()
      .describe('Environment for stdio servers. Send "[redacted]" to keep a stored value unchanged.'),
  })
  .describe('An MCP server definition, in the same shape as an entry of .mcp.json "mcpServers".')

const MCP_KEY_RE = /^[A-Za-z0-9_-]{1,64}$/

function assertMcpEntry(entry: McpServerEntry): void {
  if (!entry.url && !entry.command) {
    throw new ClientError('An MCP server needs either a url (remote) or a command (stdio).')
  }
}

async function assertReferences(
  caller: McpCaller,
  data: { repositoryId?: string | null; publishTargetIds?: string[] }
): Promise<void> {
  if (data.repositoryId) {
    const repo = await getRepository(data.repositoryId)
    if (!repo || !(await canAccessEntity('repository', data.repositoryId, caller.userId, caller.userGroupIds))) {
      throw new ClientError(`Repository "${data.repositoryId}" was not found or is not accessible to you.`)
    }
  }
  for (const id of data.publishTargetIds ?? []) {
    const target = await getPublishTarget(id)
    if (!target || !(await canAccessEntity('publishTarget', id, caller.userId, caller.userGroupIds))) {
      throw new ClientError(`Publish target "${id}" was not found or is not accessible to you.`)
    }
  }
}

export function agentSummary(agent: AgentConfig, caller: McpCaller) {
  return {
    id: agent.id,
    name: agent.name,
    description: agent.description,
    runner: agent.runner,
    model: agent.model,
    effort: agent.effort,
    repositoryId: agent.repositoryId,
    publishTargetIds: agent.publishTargetIds ?? [],
    mcpServerKeys: Object.keys(agent.mcpConfig?.mcpServers ?? {}),
    envVarKeys: Object.keys(agent.envVars ?? {}),
    promptChars: agent.prompt.length,
    isOwner: isOwnedBy(caller, agent.ownerId),
    updatedAt: agent.updatedAt,
  }
}

export async function agentDetail(agent: AgentConfig, env: ToolEnv) {
  const [triggers, runs, repo] = await Promise.all([
    listTriggers(agent.id),
    listRuns(agent.id),
    agent.repositoryId ? getRepository(agent.repositoryId) : Promise.resolve(null),
  ])
  const publishTargets = await Promise.all(
    (agent.publishTargetIds ?? []).map(async (id) => {
      const t = await getPublishTarget(id)
      return t ? { id, name: t.name, type: t.type, enabled: t.enabled } : { id, missing: true }
    })
  )
  const { prompt, ...config } = redactAgent(agent)
  return {
    ...config,
    isOwner: isOwnedBy(env.caller, agent.ownerId),
    promptChars: prompt.length,
    promptPreview: prompt.slice(0, 500),
    repository: repo
      ? { id: repo.id, name: repo.name, url: repo.url, defaultBranch: repo.defaultBranch, syncStatus: repo.syncStatus }
      : undefined,
    publishTargets,
    triggers: triggers.map((t) => redactTrigger(t)),
    recentRuns: runs.slice(0, 5).map(summarizeRun),
  }
}

export function registerAgentTools(server: McpServer, env: ToolEnv): void {
  registerTool(server, env, {
    name: 'list_agents',
    title: 'List agents',
    description:
      'List the Conduit agents visible to you (owned or shared). Returns a summary per agent; use get_agent for full configuration.',
    access: 'read',
    input: {
      query: z.string().optional().describe('Case-insensitive filter on name or description.'),
      runner: runnerSchema.optional(),
    },
    run: async ({ query, runner }, { caller }) => {
      const needle = query?.toLowerCase()
      const agents = (await listAgents(caller.userId, caller.userGroupIds))
        .filter((a) => !runner || a.runner === runner)
        .filter(
          (a) =>
            !needle ||
            a.name.toLowerCase().includes(needle) ||
            (a.description ?? '').toLowerCase().includes(needle)
        )
        .sort((a, b) => b.updatedAt - a.updatedAt)
      return { count: agents.length, agents: agents.map((a) => agentSummary(a, caller)) }
    },
  })

  registerTool(server, env, {
    name: 'get_agent',
    title: 'Get agent',
    description:
      'Full configuration of one agent: runner/model, repository, MCP servers, env var names, publish targets, triggers, and the five most recent runs. Secret values are shown as "[redacted]". The prompt is truncated here; use get_agent_prompt for the full text.',
    access: 'read',
    input: { agentId: z.string() },
    run: async ({ agentId }, toolEnv) => agentDetail(await requireAgent(toolEnv.caller, agentId), toolEnv),
  })

  registerTool(server, env, {
    name: 'create_agent',
    title: 'Create agent',
    description:
      'Create a new agent owned by you. Use list_repositories / list_publish_targets to find ids to attach. Returns the created agent.',
    access: 'write',
    input: {
      name: z.string().min(1),
      runner: runnerSchema.describe("Agent CLI: 'claude' (Claude Code), 'amp', or 'cursor' (cursor-agent)."),
      prompt: z.string().min(1).describe('The task prompt the agent runs with.'),
      description: z.string().optional(),
      model: z.string().optional().describe("Exact model id for the cursor runner (e.g. 'claude-opus-5-high')."),
      effort: effortSchema.optional().describe('Reasoning effort (claude runner).'),
      repositoryId: z.string().optional().describe('Managed repository to use as the workspace.'),
      publishTargetIds: z.array(z.string()).optional().describe('Publish targets notified when a run completes.'),
      envVars: z.record(z.string(), z.string()).optional(),
      mcpServers: z.record(z.string(), mcpServerEntrySchema).optional().describe('Agent-scoped MCP servers by key.'),
      enableRepoMcps: z.boolean().optional().describe("Also load MCP servers from the repository's .mcp.json."),
      bgTaskTimeoutSeconds: z.number().int().min(0).optional(),
      memoryCapMb: z.number().int().min(0).optional(),
      workerMemoryMib: z
        .number()
        .int()
        .min(4096)
        .max(16384)
        .refine((n) => n % 1024 === 0, 'must be a multiple of 1024')
        .optional()
        .describe('Fargate task memory in MiB (4096–16384, steps of 1024, at 2 vCPU). Unset uses 8192.'),
    },
    run: async (args, { caller, deps }) => {
      await assertReferences(caller, args)
      for (const [key, entry] of Object.entries(args.mcpServers ?? {})) {
        if (!MCP_KEY_RE.test(key)) throw new ClientError(`Invalid MCP server key "${key}".`)
        assertMcpEntry(entry)
      }
      const agent = await createAgent(
        {
          name: args.name,
          runner: args.runner,
          prompt: args.prompt,
          description: args.description,
          model: args.model,
          effort: args.effort,
          repositoryId: args.repositoryId,
          publishTargetIds: args.publishTargetIds,
          envVars: args.envVars ?? {},
          mcpConfig: { mcpServers: args.mcpServers ?? {} },
          enableRepoMcps: args.enableRepoMcps,
          bgTaskTimeoutSeconds: args.bgTaskTimeoutSeconds,
          memoryCapMb: args.memoryCapMb,
          workerMemoryMib: args.workerMemoryMib,
        },
        caller.userId
      )
      deps.broadcast('entity:changed', { entity: 'agent', id: agent.id })
      return redactAgent(agent)
    },
  })

  registerTool(server, env, {
    name: 'update_agent',
    title: 'Update agent settings',
    description:
      'Change an agent\'s settings. Only the fields you pass change; pass null to clear an optional field. envVars is a patch: a string sets a variable, null removes it, "[redacted]" keeps the stored value. To change the prompt use update_agent_prompt / edit_agent_prompt (they keep revision history); to change MCP servers use set_agent_mcp_server / remove_agent_mcp_server.',
    access: 'write',
    idempotent: true,
    input: {
      agentId: z.string(),
      name: z.string().min(1).optional(),
      description: z.string().nullable().optional(),
      runner: runnerSchema.optional(),
      model: z.string().nullable().optional(),
      effort: effortSchema.nullable().optional(),
      repositoryId: z.string().nullable().optional(),
      publishTargetIds: z.array(z.string()).optional(),
      envVars: z.record(z.string(), z.string().nullable()).optional(),
      enableRepoMcps: z.boolean().optional(),
      bgTaskTimeoutSeconds: z.number().int().min(0).nullable().optional(),
      memoryCapMb: z.number().int().min(0).nullable().optional(),
      workerMemoryMib: z
        .number()
        .int()
        .min(4096)
        .max(16384)
        .refine((n) => n % 1024 === 0, 'must be a multiple of 1024')
        .nullable()
        .optional()
        .describe('Fargate task memory in MiB. Null clears it back to the 8192 default.'),
    },
    run: async ({ agentId, envVars, ...fields }, { caller, deps }) => {
      const agent = await requireAgent(caller, agentId)
      await assertReferences(caller, fields)
      const patch: Partial<Omit<AgentConfig, 'id' | 'createdAt' | 'updatedAt'>> = {}
      if (fields.name !== undefined) patch.name = fields.name
      if (fields.runner !== undefined) patch.runner = fields.runner
      if (fields.publishTargetIds !== undefined) patch.publishTargetIds = fields.publishTargetIds
      if (fields.enableRepoMcps !== undefined) patch.enableRepoMcps = fields.enableRepoMcps
      for (const key of ['description', 'model', 'effort', 'repositoryId', 'bgTaskTimeoutSeconds', 'memoryCapMb', 'workerMemoryMib'] as const) {
        if (fields[key] !== undefined) (patch as Record<string, unknown>)[key] = fields[key] ?? undefined
      }
      if (envVars) patch.envVars = applyRecordPatch(agent.envVars ?? {}, envVars, 'Env var')
      if (Object.keys(patch).length === 0) throw new ClientError('No changes were provided.')
      const updated = await updateAgent(agentId, patch)
      deps.broadcast('entity:changed', { entity: 'agent', id: agentId })
      return redactAgent(updated)
    },
  })

  registerTool(server, env, {
    name: 'delete_agent',
    title: 'Delete agent',
    description:
      "Delete an agent you own (soft delete: run history is kept, triggers stop firing). confirmName must equal the agent's current name.",
    access: 'write',
    destructive: true,
    input: { agentId: z.string(), confirmName: z.string() },
    run: async ({ agentId, confirmName }, { caller, deps }) => {
      const agent = await requireAgentOwner(caller, agentId)
      if (confirmName !== agent.name) {
        throw new ClientError(`confirmName does not match the agent's name ("${agent.name}").`)
      }
      await deleteAgent(agentId)
      for (const trigger of await listTriggers(agentId)) deps.unregisterTrigger(trigger.id)
      deps.broadcast('entity:changed', { entity: 'agent', id: agentId })
      return { deleted: true, agentId }
    },
  })

  registerTool(server, env, {
    name: 'set_agent_mcp_server',
    title: 'Add or replace an agent MCP server',
    description:
      'Add an MCP server to an agent, or replace the one with the same key. Header/env values sent as "[redacted]" keep their stored values, so you can round-trip a definition read from get_agent. Keys must be unique across agent and global MCP servers.',
    access: 'write',
    idempotent: true,
    input: {
      agentId: z.string(),
      key: z.string().describe('Server key (letters, digits, "-" or "_"). Tools appear to the agent as mcp__<key>__<tool>.'),
      server: mcpServerEntrySchema,
    },
    run: async ({ agentId, key, server: entry }, { caller, deps }) => {
      if (!MCP_KEY_RE.test(key)) throw new ClientError(`Invalid MCP server key "${key}".`)
      const agent = await requireAgent(caller, agentId)
      const servers = agent.mcpConfig?.mcpServers ?? {}
      const merged = mergeMcpEntry(entry as McpServerEntry, servers[key])
      assertMcpEntry(merged)
      const updated = await updateAgent(agentId, {
        mcpConfig: { mcpServers: { ...servers, [key]: merged } },
      })
      deps.broadcast('entity:changed', { entity: 'agent', id: agentId })
      return { agentId, key, server: redactMcpEntry(updated.mcpConfig.mcpServers[key]!) }
    },
  })

  registerTool(server, env, {
    name: 'remove_agent_mcp_server',
    title: 'Remove an agent MCP server',
    description: 'Remove an agent-scoped MCP server by key.',
    access: 'write',
    destructive: true,
    idempotent: true,
    input: { agentId: z.string(), key: z.string() },
    run: async ({ agentId, key }, { caller, deps }) => {
      const agent = await requireAgent(caller, agentId)
      const servers = { ...(agent.mcpConfig?.mcpServers ?? {}) }
      if (!(key in servers)) throw new ClientError(`Agent has no MCP server "${key}".`)
      delete servers[key]
      await updateAgent(agentId, { mcpConfig: { mcpServers: servers } })
      deps.broadcast('entity:changed', { entity: 'agent', id: agentId })
      return { removed: true, agentId, key }
    },
  })

  registerTool(server, env, {
    name: 'check_mcp_server',
    title: 'Check an MCP server',
    description:
      "Probe an MCP server the way a run would (using your stored OAuth token, if any): reports health ('healthy' | 'unhealthy' | 'unauthorized') and the tools it exposes. Pass agentId to check one of that agent's servers, or omit it to check a global MCP server by key.",
    access: 'read',
    openWorld: true,
    input: { serverKey: z.string(), agentId: z.string().optional() },
    run: async ({ serverKey, agentId }, { caller }) => {
      let entry: McpServerEntry | undefined
      if (agentId) {
        entry = (await requireAgent(caller, agentId)).mcpConfig?.mcpServers?.[serverKey]
      } else {
        entry = (await listGlobalMcps(caller.userId, caller.userGroupIds)).find(
          (g) => g.serverKey === serverKey
        )?.serverConfig
      }
      if (!entry) throw new ClientError(`No MCP server "${serverKey}" found${agentId ? ' on that agent' : ''}.`)
      const [health, tools] = await Promise.all([
        checkMcpServerHealth(entry, caller.userId),
        listMcpServerTools(entry, caller.userId),
      ])
      return { serverKey, server: redactMcpEntry(entry), health, tools: tools.tools, toolsError: tools.error }
    },
  })
}
