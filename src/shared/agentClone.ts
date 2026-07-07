import type { AgentConfig } from './types'

/**
 * Build the `create` payload for cloning an agent.
 *
 * Copies the full configuration but:
 *  - blanks `name` (the user must rename the clone), and
 *  - drops `gistId` — it's a write target ("Update Gist" overwrites that gist by id),
 *    so a clone must not stay linked to the source's gist. The prompt *text* is copied
 *    via `prompt`, so the clone keeps the content but starts gist-unlinked.
 *
 * Identity (`id`), timestamps, and `ownerId` are intentionally omitted: the server
 * assigns a fresh id/timestamps and sets `ownerId` to the acting user. Run history,
 * triggers, and shares live outside `AgentConfig` and are never part of a create
 * payload, so they are excluded for free.
 */
export function buildCloneInput(
  agent: AgentConfig
): Omit<AgentConfig, 'id' | 'createdAt' | 'updatedAt'> {
  return {
    name: '',
    runner: agent.runner,
    prompt: agent.prompt,
    envVars: { ...agent.envVars },
    mcpConfig: agent.mcpConfig,
    gistId: undefined,
    workingDir: agent.workingDir,
    publishTargetIds: agent.publishTargetIds ? [...agent.publishTargetIds] : undefined,
    repositoryId: agent.repositoryId,
    effort: agent.effort,
    enableRepoMcps: agent.enableRepoMcps ?? false,
  }
}
