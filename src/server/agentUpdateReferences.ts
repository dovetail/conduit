import { canAccessEntity } from '../main/db/queries/access'
import { getPublishTarget } from '../main/db/queries/publishTargets'
import type { ReferenceViewer } from './agentReferences'
import { ClientError } from './errors'

/**
 * Refuse publish targets that an update newly adds and the viewer cannot use.
 *
 * Editors re-send the stored ids on every autosave, including targets they
 * cannot see, so ids that are already on the agent always pass. Only ids that
 * are not stored yet must exist and be accessible to the viewer.
 */
export async function assertNewPublishTargetsAllowed(
  current: readonly string[] | null | undefined,
  next: readonly string[] | null | undefined,
  viewer: ReferenceViewer
): Promise<void> {
  const stored = new Set(current ?? [])
  for (const id of new Set(next ?? [])) {
    if (stored.has(id)) continue
    const target = await getPublishTarget(id)
    if (!target || !(await canAccessEntity('publishTarget', id, viewer.userId, viewer.userGroupIds))) {
      throw new ClientError('You do not have access to that publish target')
    }
  }
}
