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
 * - Moving off the current repository is always allowed, including one the viewer
 *   can't see. Whoever can edit the agent already controls what it runs, and
 *   without this nobody could replace a repository after its owner left or
 *   stopped sharing it.
 * - Sending the unchanged value is always fine (editors autosave the whole
 *   draft), so an agent keeps working with a repository its editor can't see.
 */
export async function assertAgentRepositoryChangeAllowed(
  current: string | null | undefined,
  next: string | null | undefined,
  accessOf: RepositoryAccessOf
): Promise<void> {
  const to = normalize(next)
  if (normalize(current) === to) return

  if (to && (await accessOf(to)) !== 'visible') {
    throw new ClientError('You do not have access to that repository')
  }
}
