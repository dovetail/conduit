import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { GetPromptResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { listAgents } from '../../main/db/queries/agents'
import { listRecentRuns, listRuns } from '../../main/db/queries/runs'
import { listPromptRevisions } from '../../main/db/queries/promptRevisions'
import { listRepositories } from '../../main/db/queries/repositories'
import { listPublishTargets } from '../../main/db/queries/publishTargets'
import { readRunLog } from '../utils'
import { requireAgent, requireRun } from './context'
import { digestRunLog } from './runDigest'
import { jsonText, type ToolEnv } from './registry'
import { failureKind, summarizeRun } from './tools/runs'
import { promptPerformance } from './tools/prompts'

function userMessage(text: string, description: string): GetPromptResult {
  return { description, messages: [{ role: 'user', content: { type: 'text', text } }] }
}

function positiveNumber(value: string | undefined, fallback: number): number {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

export function registerPrompts(server: McpServer, { caller }: ToolEnv): void {
  server.registerPrompt(
    'investigate-run',
    {
      title: 'Investigate a run',
      description: 'Diagnose why a Conduit run failed or misbehaved, with its digest pre-loaded.',
      argsSchema: { runId: z.string().describe('The run to investigate.') },
    },
    async ({ runId }) => {
      const { run, agent } = await requireRun(caller, runId)
      const digest = digestRunLog(readRunLog(runId))
      return userMessage(
        [
          `Investigate Conduit run ${runId} of agent "${agent.name}" (${agent.id}, runner ${agent.runner}).`,
          '',
          'Run:',
          jsonText({ ...summarizeRun(run), failureKind: failureKind(run) }),
          '',
          'Log digest:',
          jsonText(digest),
          '',
          'Work through it:',
          '1. Decide whether this is an infrastructure problem (failureKind authentication, launch_config, disk_full, worker_control, process_signal) or the agent itself (agent_error, or a completed run that did the wrong thing).',
          '2. Use get_run_log (onlyErrors, search, tail) to find the first thing that went wrong — not just the last line.',
          '3. For infrastructure causes, check get_conduit_status, get_agent, and check_mcp_server as relevant.',
          '4. For agent behaviour, read get_agent_prompt and say which instruction was missing, ambiguous, or ignored.',
          '5. Report the root cause with evidence (event indexes), then the smallest fix. Do not change configuration or prompts unless asked.',
        ].join('\n'),
        `Investigate run ${runId}`
      )
    }
  )

  server.registerPrompt(
    'improve-agent-prompt',
    {
      title: 'Improve an agent prompt',
      description:
        "Review an agent's prompt against its recent run outcomes and propose (or apply) targeted improvements.",
      argsSchema: {
        agentId: z.string(),
        goal: z.string().optional().describe('What should improve (e.g. "stop opening duplicate PRs").'),
      },
    },
    async ({ agentId, goal }) => {
      const agent = await requireAgent(caller, agentId)
      const [runs, revisions] = await Promise.all([listRuns(agentId), listPromptRevisions(agentId, 200)])
      const recent = runs.slice(0, 15).map((r) => ({ ...summarizeRun(r), failureKind: failureKind(r) }))
      return userMessage(
        [
          `Improve the prompt of Conduit agent "${agent.name}" (${agent.id}).`,
          goal ? `Goal: ${goal}` : 'Goal: make runs succeed more reliably and do exactly what the prompt intends.',
          '',
          `Runner: ${agent.runner}${agent.model ? ` (model ${agent.model})` : ''}. Prompt updatedAt: ${agent.updatedAt}.`,
          '',
          'Current prompt:',
          '<prompt>',
          agent.prompt,
          '</prompt>',
          '',
          'Recent runs (newest first):',
          jsonText(recent),
          '',
          'Outcomes by prompt revision:',
          jsonText(promptPerformance(revisions, runs)),
          '',
          'Work through it:',
          '1. Read 2–3 representative runs (get_run, then get_run_log) — failures first, but also a success to see what good looks like.',
          '2. Tie each problem to the prompt: a missing instruction, an ambiguity, a conflicting rule, or missing context/tools (then the fix may be configuration, not the prompt).',
          '3. Propose specific edits, each with the evidence behind it. Keep the prompt\'s structure and voice; avoid rewriting what already works.',
          '4. Only if asked to apply: use edit_agent_prompt for each change with a note citing the run ids, then optionally start_run and compare with get_prompt_performance. A bad change can be undone with restore_prompt_revision.',
        ].join('\n'),
        `Improve the prompt of ${agent.name}`
      )
    }
  )

  server.registerPrompt(
    'triage-failures',
    {
      title: 'Triage recent failures',
      description: 'Group recent failed runs by cause and point at what to fix first.',
      argsSchema: {
        agentId: z.string().optional().describe('Limit to one agent; omit for every agent you can see.'),
        hours: z.string().optional().describe('Look-back window in hours (default 24).'),
      },
    },
    async ({ agentId, hours }) => {
      const windowHours = positiveNumber(hours, 24)
      const agents = agentId ? [await requireAgent(caller, agentId)] : await listAgents(caller.userId, caller.userGroupIds)
      const names = new Map(agents.map((a) => [a.id, a.name]))
      const failed = await listRecentRuns({
        agentIds: agents.map((a) => a.id),
        status: 'failed',
        since: Date.now() - windowHours * 3_600_000,
        limit: 100,
      })
      return userMessage(
        [
          `Triage the ${failed.length} failed Conduit run(s) from the last ${windowHours}h${agentId ? ` for agent ${names.get(agentId)}` : ''}.`,
          '',
          jsonText(failed.map((r) => ({ ...summarizeRun(r), agentName: names.get(r.agentId), failureKind: failureKind(r) }))),
          '',
          'Group them by root cause (failureKind is a first cut — confirm with get_run on one or two per group).',
          'For each group give: affected agents, run count, the cause with evidence, and the fix (configuration, credentials, infrastructure, or prompt).',
          'Order groups by impact. If nothing failed, say so and check get_conduit_status for anything else unhealthy.',
        ].join('\n'),
        'Triage recent failures'
      )
    }
  )

  server.registerPrompt(
    'design-agent',
    {
      title: 'Design a new agent',
      description: 'Plan and (on confirmation) create a Conduit agent for a goal, using the repositories and publish targets available.',
      argsSchema: { goal: z.string().describe('What the agent should accomplish, and when it should run.') },
    },
    async ({ goal }) => {
      const [repos, targets] = await Promise.all([
        listRepositories(caller.userId, caller.userGroupIds),
        listPublishTargets(caller.userId, caller.userGroupIds),
      ])
      return userMessage(
        [
          `Design a Conduit agent for this goal: ${goal}`,
          '',
          'Available repositories:',
          jsonText(repos.map((r) => ({ id: r.id, name: r.name, defaultBranch: r.defaultBranch, syncStatus: r.syncStatus }))),
          '',
          'Available publish targets:',
          jsonText(targets.map((t) => ({ id: t.id, name: t.name, type: t.type, enabled: t.enabled }))),
          '',
          'Runners: claude (Claude Code), amp, cursor (cursor-agent; set model for an exact model id).',
          '',
          'Propose: name, description, runner, repository (if it works on code), a complete prompt (objective, context, step-by-step procedure, constraints, definition of done, and what to output), MCP servers it needs (list_global_mcp_servers first — globals are already loaded), publish targets, and a trigger (cron schedule, webhook, or Slack mention).',
          'Ask for confirmation, then create it with create_agent and create_trigger. Suggest a first start_run to validate it.',
        ].join('\n'),
        'Design a new agent'
      )
    }
  )
}
