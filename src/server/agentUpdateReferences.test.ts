import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { PublishTarget } from '../shared/types'

vi.mock('../main/db/queries/access', () => ({ canAccessEntity: vi.fn() }))
vi.mock('../main/db/queries/publishTargets', () => ({ getPublishTarget: vi.fn() }))

import { canAccessEntity } from '../main/db/queries/access'
import { getPublishTarget } from '../main/db/queries/publishTargets'
import { assertNewPublishTargetsAllowed } from './agentUpdateReferences'
import { isClientError } from './errors'

const viewer = { userId: 'user-1', userGroupIds: ['group-1'] }

function target(id: string): PublishTarget {
  return { id, name: id, type: 'slack', config: {}, enabled: true, createdAt: 0, updatedAt: 0 }
}

beforeEach(() => {
  vi.mocked(canAccessEntity).mockReset()
  vi.mocked(getPublishTarget).mockReset()
  vi.mocked(getPublishTarget).mockImplementation(async (id) => target(id))
})

describe('assertNewPublishTargetsAllowed', () => {
  it('allows ids that are already stored, even when the viewer cannot access them', async () => {
    vi.mocked(canAccessEntity).mockResolvedValue(false)

    await expect(
      assertNewPublishTargetsAllowed(['hidden', 'other'], ['other', 'hidden'], viewer)
    ).resolves.toBeUndefined()

    expect(canAccessEntity).not.toHaveBeenCalled()
  })

  it('allows removing ids', async () => {
    await expect(assertNewPublishTargetsAllowed(['hidden'], [], viewer)).resolves.toBeUndefined()
    await expect(assertNewPublishTargetsAllowed(['hidden'], undefined, viewer)).resolves.toBeUndefined()
  })

  it('allows a newly added id the viewer can access', async () => {
    vi.mocked(canAccessEntity).mockResolvedValue(true)

    await expect(assertNewPublishTargetsAllowed(['kept'], ['kept', 'added'], viewer)).resolves.toBeUndefined()

    expect(canAccessEntity).toHaveBeenCalledWith('publishTarget', 'added', 'user-1', ['group-1'])
  })

  it('refuses a newly added id the viewer cannot access', async () => {
    vi.mocked(canAccessEntity).mockResolvedValue(false)

    const attempt = assertNewPublishTargetsAllowed(undefined, ['added'], viewer)

    await expect(attempt).rejects.toSatisfy(isClientError)
    await expect(attempt).rejects.toThrow('You do not have access to that publish target')
  })

  it('refuses a newly added id that does not exist', async () => {
    vi.mocked(getPublishTarget).mockResolvedValue(null)

    await expect(assertNewPublishTargetsAllowed(null, ['gone'], viewer)).rejects.toSatisfy(isClientError)
    expect(canAccessEntity).not.toHaveBeenCalled()
  })
})
