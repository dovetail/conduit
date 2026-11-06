import { getAgent } from '../../main/db/queries/agents'
import { getRun } from '../../main/db/queries/runs'
import { getTrigger } from '../../main/db/queries/triggers'
import { canAccessEntity, isEntityOwner } from '../../main/db/queries/access'
import { DEV_USER_ID } from '../auth/config'
import { ClientError } from '../errors'
import type {
  AgentConfig,
  ExecutionRun,
  McpAccessTokenScope,
  RequestContext,
  Trigger,
  TriggerContext,
} from '../../shared/types'

/** Who is calling the MCP server, resolved from the bearer token (or dev bypass). */
export interface McpCaller extends RequestContext {
  scope: McpAccessTokenScope
  /** 'token' = personal access token; 'dev' = dev-bypass mode without a token. */
  authKind: 'token' | 'dev'
  tokenId?: string
  tokenName?: string
}

/** Server services the MCP tools act through (injected so tools are testable). */
export interface McpDeps {
  startRun: (agentId: string, startedBy: string, triggerContext?: TriggerContext) => Promise<ExecutionRun>
  stopRun: (runId: string) => Promise<void>
  registerTrigger: (trigger: Trigger) => void
  unregisterTrigger: (triggerId: string) => void
  triggerRepoSync: (repoId: string) => Promise<void>
  /** Broadcast a UI event so open browsers refresh what the MCP client changed. */
  broadcast: (channel: string, payload: unknown) => void
  workerStatus: () => { factory: string; connectedWorkers?: number; activeAssignments?: number }
  /** Public base URL used to build inbound webhook URLs. */
  baseUrl: string
}

const NOT_FOUND = (kind: string, id: string) =>
  new ClientError(`${kind} "${id}" was not found or is not accessible to you.`)

export async function requireAgent(caller: McpCaller, agentId: string): Promise<AgentConfig> {
  const agent = await getAgent(agentId)
  if (!agent || !(await canAccessEntity('agent', agentId, caller.userId, caller.userGroupIds))) {
    throw NOT_FOUND('Agent', agentId)
  }
  return agent
}

export async function requireAgentOwner(caller: McpCaller, agentId: string): Promise<AgentConfig> {
  const agent = await requireAgent(caller, agentId)
  if (caller.userId !== DEV_USER_ID && !(await isEntityOwner('agent', agentId, caller.userId))) {
    throw new ClientError('Only the owner of this agent can do that.')
  }
  return agent
}

export async function requireRun(
  caller: McpCaller,
  runId: string
): Promise<{ run: ExecutionRun; agent: AgentConfig }> {
  const run = await getRun(runId)
  if (!run) throw NOT_FOUND('Run', runId)
  const agent = await getAgent(run.agentId)
  if (!agent || !(await canAccessEntity('agent', run.agentId, caller.userId, caller.userGroupIds))) {
    throw NOT_FOUND('Run', runId)
  }
  return { run, agent }
}

export async function requireTrigger(
  caller: McpCaller,
  triggerId: string
): Promise<{ trigger: Trigger; agent: AgentConfig }> {
  const trigger = await getTrigger(triggerId)
  if (!trigger) throw NOT_FOUND('Trigger', triggerId)
  const agent = await getAgent(trigger.agentId)
  if (!agent || !(await canAccessEntity('agent', trigger.agentId, caller.userId, caller.userGroupIds))) {
    throw NOT_FOUND('Trigger', triggerId)
  }
  return { trigger, agent }
}

export function isOwnedBy(caller: McpCaller, ownerId: string | undefined): boolean {
  return caller.userId === DEV_USER_ID || ownerId === caller.userId
}
