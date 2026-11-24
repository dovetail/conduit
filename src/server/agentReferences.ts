import { canAccessEntity } from '../main/db/queries/access'
import { getPublishTarget } from '../main/db/queries/publishTargets'
import { getRepository } from '../main/db/queries/repositories'
import type {
  AgentConfig,
  AgentPublishTargetReference,
  AgentReferenceAccess,
  AgentReferences,
  AgentRepositoryReference,
} from '../shared/types'

export interface ReferenceViewer {
  userId: string
  userGroupIds: string[]
}

async function accessFor(
  entityType: 'repository' | 'publishTarget',
  id: string,
  exists: boolean,
  viewer: ReferenceViewer
): Promise<AgentReferenceAccess> {
  if (!exists) return 'missing'
  return (await canAccessEntity(entityType, id, viewer.userId, viewer.userGroupIds)) ? 'visible' : 'hidden'
}

/**
 * Resolve what an agent is attached to, for one viewer.
 *
 * Runs load the attached repository and publish targets by id and never check
 * who can see them, so an agent keeps using an entity that is not shared with
 * the person editing it. The editor's pickers list only visible entities. This
 * reports the attachments the pickers cannot show, by name and status only: no
 * URL, config, token or path leaves the server.
 */
export async function resolveAgentReferences(
  agent: Pick<AgentConfig, 'repositoryId' | 'publishTargetIds'>,
  viewer: ReferenceViewer
): Promise<AgentReferences> {
  let repository: AgentRepositoryReference | undefined
  if (agent.repositoryId) {
    const repo = await getRepository(agent.repositoryId)
    const access = await accessFor('repository', agent.repositoryId, repo !== null, viewer)
    repository = repo
      ? {
          id: repo.id,
          access,
          name: repo.name,
          defaultBranch: repo.defaultBranch,
          syncStatus: repo.syncStatus,
          syncError: repo.syncError,
        }
      : { id: agent.repositoryId, access }
  }

  const publishTargets = await Promise.all(
    (agent.publishTargetIds ?? []).map(async (id): Promise<AgentPublishTargetReference> => {
      const target = await getPublishTarget(id)
      const access = await accessFor('publishTarget', id, target !== null, viewer)
      return target ? { id, access, name: target.name, type: target.type, enabled: target.enabled } : { id, access }
    })
  )

  return { repository, publishTargets }
}
