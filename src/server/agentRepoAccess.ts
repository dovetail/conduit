import type { AgentReferenceAccess } from '../shared/types'
import { ClientError } from './errors'

/** Access of a repository id for the viewer: visible, hidden (exists, not shared) or missing. */
export type RepositoryAccessOf = (repositoryId: string) => Promise<AgentReferenceAccess>

function normalize(id: string | null | undefined): string | null {
  return id ? id : null
}

/**
 * Guard the repository an agent points at.
 *
 * - Choosing a repository requires that it exists and is shared with the viewer.
 * - Moving off a repository the viewer can't see is refused, so someone the repo
 *   isn't shared with can't clear or swap a workspace they can't see. A deleted
 *   repository is not a secret, so it can always be cleared or replaced.
 * - Sending the unchanged value is always fine (editors autosave the whole
 *   draft), so an agent keeps working with a repository its editor can't see.
 */
export async function assertAgentRepositoryChangeAllowed(
  current: string | null | undefined,
  next: string | null | undefined,
  accessOf: RepositoryAccessOf
): Promise<void> {
  const from = normalize(current)
  const to = normalize(next)
  if (from === to) return

  if (to && (await accessOf(to)) !== 'visible') {
    throw new ClientError('You do not have access to that repository')
  }
  if (from && (await accessOf(from)) === 'hidden') {
    throw new ClientError("This agent uses a repository that isn't shared with you, so it can't be changed")
  }
}
