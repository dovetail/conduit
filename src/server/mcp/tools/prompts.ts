import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { updateAgent } from '../../../main/db/queries/agents'
import { listRuns } from '../../../main/db/queries/runs'
import {
  getPromptRevision,
  listPromptRevisions,
  recordPromptChange,
} from '../../../main/db/queries/promptRevisions'
import { ClientError } from '../../errors'
import { requireAgent, type McpCaller, type McpDeps } from '../context'
import { applyPromptEdit, summarizePromptDiff } from '../promptEdit'
import { registerTool, type ToolEnv } from '../registry'
import type { AgentConfig, ExecutionRun, PromptRevision, RunStatus } from '../../../shared/types'

const noteSchema = z
  .string()
  .min(1)
  .describe('Why the prompt changed — recorded in the revision history (e.g. "Clarify PR title format after run X failed").')

const expectedUpdatedAtSchema = z
  .number()
  .optional()
  .describe("Optimistic concurrency: the agent's updatedAt you last read. The change is rejected if the agent changed since.")

async function changePrompt(
  caller: McpCaller,
  deps: McpDeps,
  agent: AgentConfig,
  nextPrompt: string,
  opts: { source: 'mcp' | 'restore'; note?: string; expectedUpdatedAt?: number }
) {
  if (opts.expectedUpdatedAt !== undefined && opts.expectedUpdatedAt !== agent.updatedAt) {
    throw new ClientError(
      `The agent changed since you read it (updatedAt is now ${agent.updatedAt}). Re-read the prompt and retry.`
    )
  }
  if (!nextPrompt.trim()) throw new ClientError('The prompt must not be empty.')
  if (nextPrompt === agent.prompt) throw new ClientError('The new prompt is identical to the current one.')
  const updated = await updateAgent(agent.id, { prompt: nextPrompt })
  const revision = await recordPromptChange({
    agentId: agent.id,
    previousPrompt: agent.prompt,
    previousAt: agent.updatedAt,
    nextPrompt,
    source: opts.source,
    note: opts.note,
    userId: caller.userId,
  })
  deps.broadcast('entity:changed', { entity: 'agent', id: agent.id })
  return {
    agentId: agent.id,
    revisionId: revision?.id,
    updatedAt: updated.updatedAt,
    chars: nextPrompt.length,
    diff: summarizePromptDiff(agent.prompt, nextPrompt),
  }
}

function revisionSummary(rev: PromptRevision, currentId: string | undefined) {
  return {
    id: rev.id,
    source: rev.source,
    note: rev.note,
    createdBy: rev.createdBy,
    createdAt: new Date(rev.createdAt).toISOString(),
    chars: rev.prompt.length,
    preview: rev.prompt.slice(0, 160),
    isCurrent: rev.id === currentId,
  }
}

interface WindowStats {
  runs: number
  byStatus: Partial<Record<RunStatus, number>>
  successRate?: number
  avgDurationMs?: number
  sampleFailedRunIds: string[]
}

function statsFor(runs: ExecutionRun[]): WindowStats {
  const byStatus: Partial<Record<RunStatus, number>> = {}
  let durationTotal = 0
  let durationCount = 0
  for (const run of runs) {
    byStatus[run.status] = (byStatus[run.status] ?? 0) + 1
    if (run.durationMs != null) {
      durationTotal += run.durationMs
      durationCount++
    }
  }
  const finished = (byStatus.completed ?? 0) + (byStatus.failed ?? 0)
  return {
    runs: runs.length,
    byStatus,
    successRate: finished > 0 ? Number(((byStatus.completed ?? 0) / finished).toFixed(3)) : undefined,
    avgDurationMs: durationCount > 0 ? Math.round(durationTotal / durationCount) : undefined,
    sampleFailedRunIds: runs.filter((r) => r.status === 'failed').slice(0, 5).map((r) => r.id),
  }
}

/** Bucket runs by the prompt revision in effect when each run started. Revisions newest first. */
export function promptPerformance(revisions: PromptRevision[], runs: ExecutionRun[]) {
  const ordered = [...revisions].sort((a, b) => a.createdAt - b.createdAt)
  const windows = ordered.map((rev, i) => ({
    rev,
    from: rev.createdAt,
    to: ordered[i + 1]?.createdAt ?? Number.POSITIVE_INFINITY,
  }))
  const firstAt = ordered[0]?.createdAt ?? Number.POSITIVE_INFINITY
  const result = windows
    .map(({ rev, from, to }) => ({
      revisionId: rev.id,
      source: rev.source,
      note: rev.note,
      effectiveFrom: new Date(from).toISOString(),
      effectiveTo: Number.isFinite(to) ? new Date(to).toISOString() : undefined,
      ...statsFor(runs.filter((r) => r.startedAt >= from && r.startedAt < to)),
    }))
    .reverse()
  const before = runs.filter((r) => r.startedAt < firstAt)
  return {
    revisions: result,
    beforeHistory: before.length > 0 ? statsFor(before) : undefined,
  }
}

export function registerPromptTools(server: McpServer, env: ToolEnv): void {
  registerTool(server, env, {
    name: 'get_agent_prompt',
    title: 'Get agent prompt',
    description: "An agent's full prompt, with its updatedAt (pass it back as expectedUpdatedAt when replacing) and revision count.",
    access: 'read',
    input: { agentId: z.string() },
    run: async ({ agentId }, { caller }) => {
      const agent = await requireAgent(caller, agentId)
      const revisions = await listPromptRevisions(agentId, 200)
      return {
        agentId,
        name: agent.name,
        runner: agent.runner,
        model: agent.model,
        updatedAt: agent.updatedAt,
        chars: agent.prompt.length,
        lines: agent.prompt.split('\n').length,
        revisionCount: revisions.length,
        prompt: agent.prompt,
      }
    },
  })

  registerTool(server, env, {
    name: 'update_agent_prompt',
    title: 'Replace agent prompt',
    description:
      "Replace an agent's whole prompt. Records a revision with your note so it can be restored. Prefer edit_agent_prompt for targeted changes.",
    access: 'write',
    input: { agentId: z.string(), prompt: z.string().min(1), note: noteSchema, expectedUpdatedAt: expectedUpdatedAtSchema },
    run: async ({ agentId, prompt, note, expectedUpdatedAt }, { caller, deps }) =>
      changePrompt(caller, deps, await requireAgent(caller, agentId), prompt, {
        source: 'mcp',
        note,
        expectedUpdatedAt,
      }),
  })

  registerTool(server, env, {
    name: 'edit_agent_prompt',
    title: 'Edit agent prompt',
    description:
      'Targeted edit: replace an exact substring of the prompt. oldText must match exactly once unless replaceAll is set. Records a revision with your note. Returns a diff of the change.',
    access: 'write',
    input: {
      agentId: z.string(),
      oldText: z.string().min(1),
      newText: z.string(),
      replaceAll: z.boolean().optional(),
      note: noteSchema,
    },
    run: async ({ agentId, oldText, newText, replaceAll, note }, { caller, deps }) => {
      const agent = await requireAgent(caller, agentId)
      const edit = applyPromptEdit(agent.prompt, oldText, newText, replaceAll)
      const result = await changePrompt(caller, deps, agent, edit.prompt, { source: 'mcp', note })
      return { ...result, replacements: edit.replacements }
    },
  })

  registerTool(server, env, {
    name: 'list_prompt_revisions',
    title: 'List prompt revisions',
    description:
      "An agent's prompt history, newest first: who changed it, from where (ui, mcp, restore, or the pre-history baseline), and the note.",
    access: 'read',
    input: { agentId: z.string(), limit: z.number().int().min(1).max(200).optional() },
    run: async ({ agentId, limit }, { caller }) => {
      const agent = await requireAgent(caller, agentId)
      const revisions = await listPromptRevisions(agentId, limit ?? 20)
      const current = revisions[0]?.prompt === agent.prompt ? revisions[0]?.id : undefined
      return revisions.map((r) => revisionSummary(r, current))
    },
  })

  registerTool(server, env, {
    name: 'get_prompt_revision',
    title: 'Get prompt revision',
    description: 'The full text of one prompt revision, plus a diff against the current prompt.',
    access: 'read',
    input: { agentId: z.string(), revisionId: z.string() },
    run: async ({ agentId, revisionId }, { caller }) => {
      const agent = await requireAgent(caller, agentId)
      const rev = await getPromptRevision(agentId, revisionId)
      if (!rev) throw new ClientError(`Revision "${revisionId}" not found for this agent.`)
      return {
        ...revisionSummary(rev, undefined),
        isCurrent: rev.prompt === agent.prompt,
        prompt: rev.prompt,
        diffToCurrent: summarizePromptDiff(rev.prompt, agent.prompt),
      }
    },
  })

  registerTool(server, env, {
    name: 'restore_prompt_revision',
    title: 'Restore prompt revision',
    description: "Make an earlier revision the agent's prompt again (recorded as a new 'restore' revision).",
    access: 'write',
    input: { agentId: z.string(), revisionId: z.string(), note: z.string().optional() },
    run: async ({ agentId, revisionId, note }, { caller, deps }) => {
      const agent = await requireAgent(caller, agentId)
      const rev = await getPromptRevision(agentId, revisionId)
      if (!rev) throw new ClientError(`Revision "${revisionId}" not found for this agent.`)
      return changePrompt(caller, deps, agent, rev.prompt, {
        source: 'restore',
        note: note ?? `Restored revision ${revisionId}`,
      })
    },
  })

  registerTool(server, env, {
    name: 'get_prompt_performance',
    title: 'Prompt performance by revision',
    description:
      'Run outcomes grouped by the prompt revision that was live when each run started: run counts by status, success rate, average duration, and sample failed run ids. Use it to tell whether a prompt change helped.',
    access: 'read',
    input: { agentId: z.string() },
    run: async ({ agentId }, { caller }) => {
      await requireAgent(caller, agentId)
      const [revisions, runs] = await Promise.all([listPromptRevisions(agentId, 200), listRuns(agentId)])
      return { agentId, ...promptPerformance(revisions, runs) }
    },
  })
}
