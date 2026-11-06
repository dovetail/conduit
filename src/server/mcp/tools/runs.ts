import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { listAgents } from '../../../main/db/queries/agents'
import { listRecentRuns } from '../../../main/db/queries/runs'
import { readRunLog } from '../../utils'
import { classifyRunFailure } from '../../runFailure'
import { ClientError } from '../../errors'
import { requireAgent, requireRun } from '../context'
import { digestRunLog, queryRunLog } from '../runDigest'
import { registerTool, type ToolEnv } from '../registry'
import type { ExecutionRun } from '../../../shared/types'

const statusSchema = z.enum(['running', 'completed', 'failed', 'stopped', 'launched'])
const kindSchema = z.enum(['assistant', 'tool_use', 'tool_result', 'result', 'raw'])

export function summarizeRun(run: ExecutionRun) {
  return {
    id: run.id,
    agentId: run.agentId,
    status: run.status,
    startedAt: new Date(run.startedAt).toISOString(),
    endedAt: run.endedAt ? new Date(run.endedAt).toISOString() : undefined,
    durationMs: run.durationMs,
    exitCode: run.exitCode,
    trigger: run.triggerContext?.triggerType ?? 'manual',
    lastLine: run.lastLine,
  }
}

export function failureKind(run: ExecutionRun): string | undefined {
  return run.status === 'failed' ? classifyRunFailure(run.lastLine, run.exitCode) : undefined
}

export function registerRunTools(server: McpServer, env: ToolEnv): void {
  registerTool(server, env, {
    name: 'list_runs',
    title: 'List runs',
    description:
      'List recent runs, newest first — for one agent, or across every agent visible to you. Filter by status (e.g. "failed") and time window to triage problems.',
    access: 'read',
    input: {
      agentId: z.string().optional(),
      status: statusSchema.optional(),
      sinceHours: z.number().positive().optional().describe('Only runs started within this many hours.'),
      limit: z.number().int().min(1).max(200).optional().describe('Default 20.'),
    },
    run: async ({ agentId, status, sinceHours, limit }, { caller }) => {
      const agents = agentId
        ? [await requireAgent(caller, agentId)]
        : await listAgents(caller.userId, caller.userGroupIds)
      const names = new Map(agents.map((a) => [a.id, a.name]))
      const runs = await listRecentRuns({
        agentIds: agents.map((a) => a.id),
        status,
        since: sinceHours ? Date.now() - sinceHours * 3_600_000 : undefined,
        limit: limit ?? 20,
      })
      return {
        count: runs.length,
        runs: runs.map((r) => ({ ...summarizeRun(r), agentName: names.get(r.agentId), failureKind: failureKind(r) })),
      }
    },
  })

  registerTool(server, env, {
    name: 'get_run',
    title: 'Get run',
    description:
      'One run with a triage digest: status, timing, trigger, failure classification (authentication, launch_config, disk_full, process_signal, worker_control, agent_error), tool-call counts, tool errors, the final result, the last assistant messages, and the stderr tail. Use get_run_log to page through the full log.',
    access: 'read',
    input: { runId: z.string() },
    run: async ({ runId }, { caller }) => {
      const { run, agent } = await requireRun(caller, runId)
      return {
        run: {
          ...summarizeRun(run),
          agentName: agent.name,
          startedBy: run.startedBy,
          workerKind: run.workerKind,
          workerId: run.workerId,
          triggerContext: run.triggerContext,
        },
        failureKind: failureKind(run),
        digest: digestRunLog(readRunLog(runId)),
      }
    },
  })

  registerTool(server, env, {
    name: 'get_run_log',
    title: 'Read run log',
    description:
      'Page through a run\'s log events. Filter by kind (assistant, tool_use, tool_result, result, raw), by a case-insensitive search string, or to errors only. Use tail to read the end of the log. Each event\'s text is truncated to maxCharsPerEvent.',
    access: 'read',
    input: {
      runId: z.string(),
      kinds: z.array(kindSchema).optional(),
      search: z.string().optional(),
      onlyErrors: z.boolean().optional().describe('Only tool errors, failed results, and stderr.'),
      tail: z.number().int().min(1).max(500).optional().describe('Return the last N matching events.'),
      offset: z.number().int().min(0).optional().describe('Index into the matching events (ignored with tail).'),
      limit: z.number().int().min(1).max(500).optional().describe('Default 100.'),
      maxCharsPerEvent: z.number().int().min(100).max(20000).optional().describe('Default 2000.'),
    },
    run: async ({ runId, ...q }, { caller }) => {
      await requireRun(caller, runId)
      return queryRunLog(readRunLog(runId), {
        kinds: q.kinds,
        search: q.search,
        onlyErrors: q.onlyErrors,
        tail: q.tail,
        offset: q.offset,
        limit: q.limit ?? q.tail ?? 100,
        maxCharsPerEvent: q.maxCharsPerEvent ?? 2000,
      })
    },
  })

  registerTool(server, env, {
    name: 'start_run',
    title: 'Start a run',
    description:
      'Start a run of an agent now, attributed to you (your stored runner credentials are used). Fails if the agent already has a run in progress. Poll get_run for the outcome.',
    access: 'write',
    input: { agentId: z.string() },
    run: async ({ agentId }, { caller, deps }) => {
      await requireAgent(caller, agentId)
      return summarizeRun(await deps.startRun(agentId, caller.userId))
    },
  })

  registerTool(server, env, {
    name: 'stop_run',
    title: 'Stop a run',
    description: 'Stop a run that is in progress.',
    access: 'write',
    destructive: true,
    input: { runId: z.string() },
    run: async ({ runId }, { caller, deps }) => {
      const { run } = await requireRun(caller, runId)
      if (run.status !== 'running') throw new ClientError(`Run is not running (status: ${run.status}).`)
      await deps.stopRun(runId)
      return { stopRequested: true, runId }
    },
  })
}
