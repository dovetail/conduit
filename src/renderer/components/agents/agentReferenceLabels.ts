import type {
  AgentPublishTargetReference,
  AgentReferences,
  AgentRepositoryReference,
  PublishTarget,
  PublishTargetType,
  Repository,
} from '@shared/types'

/**
 * Wording for what an agent is attached to when the viewer cannot see it.
 *
 * The editor's pickers list only repositories and publish targets that are
 * shared with the viewer, but a run uses the ones stored on the agent whoever
 * can see them. These helpers keep such an attachment visible, and never
 * describe it as "ephemeral" or "None".
 */

/** Text for the repository an agent is attached to, or undefined when none is. */
export function attachedRepositoryName(
  repositoryId: string | undefined,
  visibleRepo: Repository | undefined,
  reference: AgentRepositoryReference | undefined
): string | undefined {
  if (!repositoryId) return undefined
  if (visibleRepo) return `${visibleRepo.name} (${visibleRepo.defaultBranch})`
  if (reference?.access === 'missing') return 'repository no longer exists'
  if (reference?.name) return `${reference.name} (${reference.defaultBranch}), not shared with you`
  return 'repository not shared with you'
}

/** One-line workspace description for the collapsed section summary. */
export function workspaceLabel(input: {
  repositoryId: string | undefined
  workingDir: string | undefined
  visibleRepo: Repository | undefined
  reference: AgentRepositoryReference | undefined
}): string {
  const repoName = attachedRepositoryName(input.repositoryId, input.visibleRepo, input.reference)
  if (repoName) return repoName
  return input.workingDir ? 'custom dir' : 'ephemeral'
}

/**
 * Extra `<option>` for the repository picker when the stored repository is not in
 * the viewer's list. Without it the browser shows the first option ("None"),
 * which misreports the agent as having no repository.
 */
export function unlistedRepositoryOption(
  repositoryId: string | undefined,
  visibleRepos: readonly Repository[],
  reference: AgentRepositoryReference | undefined
): { value: string; label: string } | undefined {
  if (!repositoryId || visibleRepos.some((r) => r.id === repositoryId)) return undefined
  if (reference?.access === 'missing') {
    return { value: repositoryId, label: 'Repository no longer exists' }
  }
  const name = reference?.name ?? 'Attached repository'
  return { value: repositoryId, label: `${name} (not shared with you)` }
}

export interface UnlistedPublishTarget {
  id: string
  name: string
  type?: PublishTargetType
  enabled?: boolean
  access: 'hidden' | 'missing'
  /** Why the target is not in the picker. */
  note: string
}

/** Publish targets stored on the agent that the viewer's list does not contain. */
export function unlistedPublishTargets(
  publishTargetIds: readonly string[] | undefined,
  visibleTargets: readonly PublishTarget[],
  references: AgentReferences | undefined
): UnlistedPublishTarget[] {
  const unlistedIds = (publishTargetIds ?? []).filter((id) => !visibleTargets.some((t) => t.id === id))
  return unlistedIds.map((id) => {
    const reference: AgentPublishTargetReference | undefined = references?.publishTargets.find((t) => t.id === id)
    const access = reference?.access === 'missing' ? 'missing' : 'hidden'
    return {
      id,
      name: reference?.name ?? 'Attached publish target',
      type: reference?.type,
      enabled: reference?.enabled,
      access,
      note: access === 'missing' ? 'No longer exists' : 'Not shared with you',
    }
  })
}
