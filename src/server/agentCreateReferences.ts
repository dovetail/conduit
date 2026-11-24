import { canAccessEntity } from '../main/db/queries/access'
import { getPublishTarget } from '../main/db/queries/publishTargets'
import { getRepository } from '../main/db/queries/repositories'
import type { AgentConfig } from '../shared/types'
import type { ReferenceViewer } from './agentReferences'

type AgentReferenceFields = Pick<AgentConfig, 'repositoryId' | 'publishTargetIds'>

/**
 * Remove the repository and publish targets a new agent may not use.
 *
 * Runs load these by id and never check who can see them, so an id the creator
 * cannot access would give them a repository or target they could not attach
 * themselves. Cloning copies the ids of the source agent, which makes that easy
 * to hit. An id that points at a deleted entity cannot be accessed either, so it
 * is dropped too.
 *
 * - A repository the viewer cannot access becomes `undefined`.
 * - Publish targets the viewer cannot access are removed one by one. The rest
 *   keep their order. If none remain the field becomes `undefined`.
 * - Input without references is returned as it is.
 *
 * Use this only for a new agent. An update re-sends the stored ids of an agent
 * on every autosave, including ones its editor cannot see, and must keep them.
 */
export async function dropInaccessibleReferences<T extends AgentReferenceFields>(
  input: T,
  viewer: ReferenceViewer
): Promise<T> {
  const { repositoryId, publishTargetIds } = input
  if (!repositoryId && !publishTargetIds?.length) return input

  const [repositoryUsable, targetUsable] = await Promise.all([
    repositoryId ? isUsable('repository', repositoryId, viewer) : undefined,
    Promise.all((publishTargetIds ?? []).map((id) => isUsable('publishTarget', id, viewer))),
  ])

  let targets = publishTargetIds
  if (publishTargetIds?.length) {
    const kept = publishTargetIds.filter((_, i) => targetUsable[i])
    targets = kept.length > 0 ? kept : undefined
  }
  return { ...input, repositoryId: repositoryUsable ? repositoryId : undefined, publishTargetIds: targets }
}

async function isUsable(
  entityType: 'repository' | 'publishTarget',
  id: string,
  viewer: ReferenceViewer
): Promise<boolean> {
  const entity = entityType === 'repository' ? await getRepository(id) : await getPublishTarget(id)
  if (!entity) return false
  return canAccessEntity(entityType, id, viewer.userId, viewer.userGroupIds)
}
