import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { PublishTarget, Repository } from '../shared/types'

vi.mock('../main/db/queries/access', () => ({ canAccessEntity: vi.fn() }))
vi.mock('../main/db/queries/repositories', () => ({ getRepository: vi.fn() }))
vi.mock('../main/db/queries/publishTargets', () => ({ getPublishTarget: vi.fn() }))

import { canAccessEntity } from '../main/db/queries/access'
import { getRepository } from '../main/db/queries/repositories'
import { getPublishTarget } from '../main/db/queries/publishTargets'
import { resolveAgentReferences } from './agentReferences'

const viewer = { userId: 'user-1', userGroupIds: ['group-1'] }

const REPO: Repository = {
  id: 'repo-1',
  name: 'platform',
  url: 'https://user:secret@github.com/org/platform.git',
  defaultBranch: 'main',
  authMethod: 'github',
  syncStatus: 'ready',
  clonePath: '/data/repos/platform',
  createdAt: 0,
  updatedAt: 0,
}

const TARGET: PublishTarget = {
  id: 'target-1',
  name: 'Team Slack',
  type: 'slack',
  config: { channel: 'C123', webhookUrl: 'https://hooks.slack.com/services/SECRET' },
  enabled: true,
  createdAt: 0,
  updatedAt: 0,
}

beforeEach(() => {
  vi.mocked(canAccessEntity).mockReset()
  vi.mocked(getRepository).mockReset()
  vi.mocked(getPublishTarget).mockReset()
})

describe('resolveAgentReferences', () => {
  it('reports nothing for an agent with no attachments', async () => {
    expect(await resolveAgentReferences({}, viewer)).toEqual({ repository: undefined, publishTargets: [] })
    expect(getRepository).not.toHaveBeenCalled()
  })

  it('marks an attached repository the viewer can see as visible', async () => {
    vi.mocked(getRepository).mockResolvedValue(REPO)
    vi.mocked(canAccessEntity).mockResolvedValue(true)

    const { repository } = await resolveAgentReferences({ repositoryId: 'repo-1' }, viewer)

    expect(repository).toMatchObject({
      id: 'repo-1',
      access: 'visible',
      name: 'platform',
      defaultBranch: 'main',
      syncStatus: 'ready',
    })
    expect(canAccessEntity).toHaveBeenCalledWith('repository', 'repo-1', 'user-1', ['group-1'])
  })

  it('still reports the name and sync status of a repository the viewer cannot see', async () => {
    vi.mocked(getRepository).mockResolvedValue({ ...REPO, syncStatus: 'error', syncError: 'auth failed' })
    vi.mocked(canAccessEntity).mockResolvedValue(false)

    const { repository } = await resolveAgentReferences({ repositoryId: 'repo-1' }, viewer)

    expect(repository).toEqual({
      id: 'repo-1',
      access: 'hidden',
      name: 'platform',
      defaultBranch: 'main',
      syncStatus: 'error',
      syncError: 'auth failed',
    })
  })

  it('reports a deleted repository as missing without checking access', async () => {
    vi.mocked(getRepository).mockResolvedValue(null)

    const { repository } = await resolveAgentReferences({ repositoryId: 'gone' }, viewer)

    expect(repository).toEqual({ id: 'gone', access: 'missing' })
    expect(canAccessEntity).not.toHaveBeenCalled()
  })

  it('resolves each publish target by visibility, keeping the stored order', async () => {
    vi.mocked(getPublishTarget).mockImplementation(async (id) =>
      id === 'gone' ? null : { ...TARGET, id, name: `target ${id}` }
    )
    vi.mocked(canAccessEntity).mockImplementation(async (_type, id) => id !== 'hidden')

    const { publishTargets } = await resolveAgentReferences({ publishTargetIds: ['shared', 'hidden', 'gone'] }, viewer)

    expect(publishTargets).toEqual([
      { id: 'shared', access: 'visible', name: 'target shared', type: 'slack', enabled: true },
      { id: 'hidden', access: 'hidden', name: 'target hidden', type: 'slack', enabled: true },
      { id: 'gone', access: 'missing' },
    ])
  })

  it('never returns URLs, configs or paths', async () => {
    vi.mocked(getRepository).mockResolvedValue(REPO)
    vi.mocked(getPublishTarget).mockResolvedValue(TARGET)
    vi.mocked(canAccessEntity).mockResolvedValue(false)

    const result = await resolveAgentReferences({ repositoryId: 'repo-1', publishTargetIds: ['target-1'] }, viewer)

    const serialised = JSON.stringify(result)
    expect(serialised).not.toContain('secret')
    expect(serialised).not.toContain('SECRET')
    expect(serialised).not.toContain('/data/repos')
  })
})
