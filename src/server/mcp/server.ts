import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { McpCaller, McpDeps } from './context'
import { registerPrompts } from './prompts'
import { registerResources } from './resources'
import type { ToolEnv } from './registry'
import { registerAgentTools } from './tools/agents'
import { registerPromptTools } from './tools/prompts'
import { registerRunTools } from './tools/runs'
import { registerTriggerTools } from './tools/triggers'
import { registerWorkspaceTools } from './tools/workspace'

export const CONDUIT_MCP_SERVER_NAME = 'conduit'
export const CONDUIT_MCP_SERVER_VERSION = '1.0.0'

const INSTRUCTIONS = `Conduit runs AI CLI agents (Claude Code, Amp, Cursor) on demand or on triggers.
An agent = a prompt + a runner + optional repository workspace, MCP servers, env vars, publish targets, and triggers (cron / webhook / Slack).
Every execution is a run with a status and a structured log.

Start with get_conduit_status for an overview, then list_agents.
- Configure: get_agent, create_agent, update_agent, set_agent_mcp_server, create_trigger, ...
- Investigate: list_runs (status "failed"), get_run (digest + failure classification), get_run_log (filter/search/tail).
- Prompts: get_agent_prompt, edit_agent_prompt (exact-substring edit), get_prompt_performance (outcomes per revision), restore_prompt_revision.

Secret values are always returned as "[redacted]"; sending "[redacted]" back in a write keeps the stored value.
Every prompt change records a revision with your note, so explain why you changed it.
Tools that create, change, delete, or start things are only available with a write-scoped token.`

/** Build an MCP server bound to one caller. Tools/prompts/resources are filtered by the caller's scope. */
export function createConduitMcpServer(caller: McpCaller, deps: McpDeps): McpServer {
  const server = new McpServer(
    { name: CONDUIT_MCP_SERVER_NAME, version: CONDUIT_MCP_SERVER_VERSION },
    { instructions: INSTRUCTIONS }
  )
  const env: ToolEnv = { caller, deps }
  registerWorkspaceTools(server, env)
  registerAgentTools(server, env)
  registerTriggerTools(server, env)
  registerRunTools(server, env)
  registerPromptTools(server, env)
  registerPrompts(server, env)
  registerResources(server, env)
  return server
}
