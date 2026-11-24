import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { PublishTarget, Repository } from '../shared/types'

vi.mock('../main/db/queries/access', () => ({ canAccessEntity: vi.fn() }))
vi.mock('../main/db/queries/repositories', () => ({ getRepository: vi.fn() }))
vi.mock('../main/db/queries/publishTargets', () => ({ getPublishTarget: vi.fn() }))

import { canAccessEntity } from '../main/db/queries/access'
import { getRepository } from '../main/db/queries/repositories'
import { getPublishTarget } from '../main/db/queries/publishTargets'
import { dropInaccessibleReferences } from './agentCreateReferences'

const viewer = { userId: 'user-1', userGroupIds: ['group-1'] }

const REPO: Repository = {
  id: 'repo-1',
  name: 'platform',
  url: 'https://github.com/org/platform.git',
  defaultBranch: 'main',
  authMethod: 'github',
  syncStatus: 'ready',
  clonePath: '/data/repos/platform',
  createdAt: 0,
  updatedAt: 0,
}

function target(id: string): PublishTarget {
  return { id, name: id, type: 'slack', config: {}, enabled: true, createdAt: 0, updatedAt: 0 }
}

beforeEach(() => {
  vi.mocked(canAccessEntity).mockReset()
  vi.mocked(getRepository).mockReset()
  vi.mocked(getPublishTarget).mockReset()
  vi.mocked(getRepository).mockImplementation(async (id) => ({ ...REPO, id }))
  vi.mocked(getPublishTarget).mockImplementation(async (id) => target(id))
})

describe('dropInaccessibleReferences', () => {
  it('keeps a repository the user can access', async () => {
    vi.mocked(canAccessEntity).mockResolvedValue(true)

    const result = await dropInaccessibleReferences({ repositoryId: 'repo-1' }, viewer)

    expect(result.repositoryId).toBe('repo-1')
    expect(canAccessEntity).toHaveBeenCalledWith('repository', 'repo-1', 'user-1', ['group-1'])
  })

  it('removes a repository the user cannot access', async () => {
    vi.mocked(canAccessEntity).mockResolvedValue(false)

    const result = await dropInaccessibleReferences({ repositoryId: 'repo-1' }, viewer)

    expect(result.repositoryId).toBeUndefined()
  })

  it('removes a repository that was deleted without checking access', async () => {
    vi.mocked(getRepository).mockResolvedValue(null)

    const result = await dropInaccessibleReferences({ repositoryId: 'gone' }, viewer)

    expect(result.repositoryId).toBeUndefined()
    expect(canAccessEntity).not.toHaveBeenCalled()
  })

  it('removes only the publish targets the user cannot access and keeps their order', async () => {
    vi.mocked(getPublishTarget).mockImplementation(async (id) => (id === 'gone' ? null : target(id)))
    vi.mocked(canAccessEntity).mockImplementation(async (_type, id) => id !== 'hidden')

    const result = await dropInaccessibleReferences({ publishTargetIds: ['b', 'hidden', 'a', 'gone', 'c'] }, viewer)

    expect(result.publishTargetIds).toEqual(['b', 'a', 'c'])
    expect(canAccessEntity).toHaveBeenCalledWith('publishTarget', 'hidden', 'user-1', ['group-1'])
  })

  it('sets publish targets to undefined when none remain', async () => {
    vi.mocked(canAccessEntity).mockResolvedValue(false)

    const result = await dropInaccessibleReferences({ publishTargetIds: ['a', 'b'] }, viewer)

    expect(result.publishTargetIds).toBeUndefined()
  })

  it('handles the repository and the publish targets independently', async () => {
    vi.mocked(canAccessEntity).mockImplementation(async (type) => type === 'publishTarget')

    const result = await dropInaccessibleReferences({ repositoryId: 'repo-1', publishTargetIds: ['a'] }, viewer)

    expect(result).toEqual({ repositoryId: undefined, publishTargetIds: ['a'] })
  })

  it('leaves other fields untouched', async () => {
    vi.mocked(canAccessEntity).mockResolvedValue(false)

    const result = await dropInaccessibleReferences({ name: 'copy', repositoryId: 'repo-1' }, viewer)

    expect(result).toEqual({ name: 'copy', repositoryId: undefined, publishTargetIds: undefined })
  })

  it('returns input without references as it is and does not look anything up', async () => {
    const none = { name: 'plain' }
    const emptyTargets = { publishTargetIds: [] as string[] }

    expect(await dropInaccessibleReferences(none, viewer)).toBe(none)
    expect(await dropInaccessibleReferences(emptyTargets, viewer)).toBe(emptyTargets)
    expect(getRepository).not.toHaveBeenCalled()
    expect(getPublishTarget).not.toHaveBeenCalled()
    expect(canAccessEntity).not.toHaveBeenCalled()
  })
})
