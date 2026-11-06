import { ResourceTemplate, type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { listAgents } from '../../main/db/queries/agents'
import { readRunLog } from '../utils'
import { requireAgent, requireRun } from './context'
import { digestRunLog, queryRunLog, renderRunLogPage } from './runDigest'
import { jsonText, type ToolEnv } from './registry'
import { agentDetail } from './tools/agents'
import { failureKind, summarizeRun } from './tools/runs'

function variable(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '')
}

export function registerResources(server: McpServer, env: ToolEnv): void {
  const { caller } = env

  server.registerResource(
    'agent',
    new ResourceTemplate('conduit://agents/{agentId}', {
      list: async () => ({
        resources: (await listAgents(caller.userId, caller.userGroupIds)).map((a) => ({
          uri: `conduit://agents/${a.id}`,
          name: a.name,
          description: a.description ?? `${a.runner} agent`,
          mimeType: 'application/json',
        })),
      }),
    }),
    {
      title: 'Agent configuration',
      description: 'An agent\'s configuration (secrets redacted), triggers, and recent runs.',
      mimeType: 'application/json',
    },
    async (uri, vars) => {
      const agent = await requireAgent(caller, variable(vars.agentId))
      return { contents: [{ uri: uri.href, mimeType: 'application/json', text: jsonText(await agentDetail(agent, env)) }] }
    }
  )

  server.registerResource(
    'agent-prompt',
    new ResourceTemplate('conduit://agents/{agentId}/prompt', {
      list: async () => ({
        resources: (await listAgents(caller.userId, caller.userGroupIds)).map((a) => ({
          uri: `conduit://agents/${a.id}/prompt`,
          name: `${a.name} — prompt`,
          mimeType: 'text/markdown',
        })),
      }),
    }),
    { title: 'Agent prompt', description: "An agent's current prompt.", mimeType: 'text/markdown' },
    async (uri, vars) => {
      const agent = await requireAgent(caller, variable(vars.agentId))
      return { contents: [{ uri: uri.href, mimeType: 'text/markdown', text: agent.prompt }] }
    }
  )

  server.registerResource(
    'run',
    new ResourceTemplate('conduit://runs/{runId}', { list: undefined }),
    { title: 'Run digest', description: 'A run with its triage digest.', mimeType: 'application/json' },
    async (uri, vars) => {
      const runId = variable(vars.runId)
      const { run, agent } = await requireRun(caller, runId)
      const body = {
        run: { ...summarizeRun(run), agentName: agent.name },
        failureKind: failureKind(run),
        digest: digestRunLog(readRunLog(runId)),
      }
      return { contents: [{ uri: uri.href, mimeType: 'application/json', text: jsonText(body) }] }
    }
  )

  server.registerResource(
    'run-log',
    new ResourceTemplate('conduit://runs/{runId}/log', { list: undefined }),
    { title: 'Run log', description: 'The last 300 events of a run log as plain text.', mimeType: 'text/plain' },
    async (uri, vars) => {
      const runId = variable(vars.runId)
      await requireRun(caller, runId)
      const page = queryRunLog(readRunLog(runId), { tail: 300, limit: 300, maxCharsPerEvent: 1000 })
      return { contents: [{ uri: uri.href, mimeType: 'text/plain', text: renderRunLogPage(page) }] }
    }
  )
}
