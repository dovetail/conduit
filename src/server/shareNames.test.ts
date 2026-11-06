import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  getUser,
  getGroup,
  upsertGroup,
  isAuthEnabled,
  resolveOktaUserName,
  resolveOktaGroupName,
} = vi.hoisted(() => ({
  getUser: vi.fn(),
  getGroup: vi.fn(),
  upsertGroup: vi.fn(),
  isAuthEnabled: vi.fn(),
  resolveOktaUserName: vi.fn(),
  resolveOktaGroupName: vi.fn(),
}))

vi.mock('../main/db/queries/users', () => ({
  getUser,
}))
vi.mock('../main/db/queries/groups', () => ({
  getGroup,
  upsertGroup,
}))
vi.mock('./auth/config', () => ({
  isAuthEnabled,
}))
vi.mock('./auth/okta', () => ({
  resolveOktaUserName,
  resolveOktaGroupName,
}))

import { enrichGroups, enrichUsers, resolveShareNames } from './shareNames'
import type { Group, Share, User } from '../shared/types'

const OPAQUE_USER_ID = '00u1a2b3c4d5e6f7g8h9'
const OPAQUE_GROUP_ID = '00g1a2b3c4d5e6f7g8h9'

function userShare(targetId: string): Share {
  return {
    id: 's1',
    entityType: 'agent',
    entityId: 'a1',
    targetType: 'user',
    targetId,
    createdBy: 'owner',
    createdAt: 1,
  }
}

function groupShare(targetId: string): Share {
  return {
    id: 's2',
    entityType: 'agent',
    entityId: 'a1',
    targetType: 'group',
    targetId,
    createdBy: 'owner',
    createdAt: 1,
  }
}

function localUser(overrides: Partial<User> = {}): User {
  return {
    id: OPAQUE_USER_ID,
    email: 'local@example.com',
    name: 'Ada Lovelace',
    lastLoginAt: 1,
    createdAt: 1,
    ...overrides,
  }
}

function localGroup(overrides: Partial<Group> = {}): Group {
  return {
    id: OPAQUE_GROUP_ID,
    name: 'Engineering',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

describe('resolveShareNames', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    isAuthEnabled.mockReturnValue(true)
    getUser.mockResolvedValue(null)
    getGroup.mockResolvedValue(null)
    upsertGroup.mockResolvedValue(undefined)
    resolveOktaUserName.mockResolvedValue(null)
    resolveOktaGroupName.mockResolvedValue(null)
  })

  it('uses a local friendly user name and does not call Okta', async () => {
    getUser.mockResolvedValue(localUser())

    const [resolved] = await resolveShareNames([userShare(OPAQUE_USER_ID)])

    expect(resolved.targetName).toBe('Ada Lovelace')
    expect(resolved.targetEmail).toBe('local@example.com')
    expect(resolveOktaUserName).not.toHaveBeenCalled()
  })

  it('replaces a local user name that is an opaque Okta id with the Okta display name and email', async () => {
    getUser.mockResolvedValue(localUser({ name: OPAQUE_USER_ID, email: 'stale@example.com' }))
    resolveOktaUserName.mockResolvedValue({
      id: OPAQUE_USER_ID,
      name: 'Ada Lovelace',
      email: 'ada@example.com',
    })

    const [resolved] = await resolveShareNames([userShare(OPAQUE_USER_ID)])

    expect(resolved.targetName).toBe('Ada Lovelace')
    expect(resolved.targetEmail).toBe('ada@example.com')
    expect(resolveOktaUserName).toHaveBeenCalledWith(OPAQUE_USER_ID)
  })

  it('uses Okta name and email when there is no local user', async () => {
    resolveOktaUserName.mockResolvedValue({
      id: OPAQUE_USER_ID,
      name: 'Ada Lovelace',
      email: 'ada@example.com',
    })

    const [resolved] = await resolveShareNames([userShare(OPAQUE_USER_ID)])

    expect(resolved.targetName).toBe('Ada Lovelace')
    expect(resolved.targetEmail).toBe('ada@example.com')
  })

  it('does not call Okta for a local group whose id and name are Engineering', async () => {
    getGroup.mockResolvedValue(localGroup({ id: 'Engineering', name: 'Engineering' }))

    const [resolved] = await resolveShareNames([groupShare('Engineering')])

    expect(resolved.targetName).toBe('Engineering')
    expect(resolved.targetEmail).toBeNull()
    expect(resolveOktaGroupName).not.toHaveBeenCalled()
  })

  it('uses the Okta profile name for a local group whose id and name are an opaque Okta group id', async () => {
    getGroup.mockResolvedValue(localGroup({ id: OPAQUE_GROUP_ID, name: OPAQUE_GROUP_ID }))
    resolveOktaGroupName.mockResolvedValue({ id: OPAQUE_GROUP_ID, name: 'Platform' })

    const [resolved] = await resolveShareNames([groupShare(OPAQUE_GROUP_ID)])

    expect(resolved.targetName).toBe('Platform')
    expect(resolveOktaGroupName).toHaveBeenCalledWith(OPAQUE_GROUP_ID)
  })

  it('keeps a local opaque name when Okta misses and does not upsert', async () => {
    getGroup.mockResolvedValue(localGroup({ id: OPAQUE_GROUP_ID, name: OPAQUE_GROUP_ID }))
    resolveOktaGroupName.mockResolvedValue(null)

    const [resolved] = await resolveShareNames([groupShare(OPAQUE_GROUP_ID)])

    expect(resolved.targetName).toBe(OPAQUE_GROUP_ID)
    expect(resolved.targetEmail).toBeNull()
    expect(upsertGroup).not.toHaveBeenCalled()
  })

  it('keeps local opaque ids and does not call Okta when auth is disabled', async () => {
    isAuthEnabled.mockReturnValue(false)
    getUser.mockResolvedValue(localUser({ name: OPAQUE_USER_ID }))
    getGroup.mockResolvedValue(localGroup({ name: OPAQUE_GROUP_ID }))

    const [userResolved, groupResolved] = await resolveShareNames([
      userShare(OPAQUE_USER_ID),
      groupShare(OPAQUE_GROUP_ID),
    ])

    expect(userResolved.targetName).toBe(OPAQUE_USER_ID)
    expect(userResolved.targetEmail).toBe('local@example.com')
    expect(groupResolved.targetName).toBe(OPAQUE_GROUP_ID)
    expect(resolveOktaUserName).not.toHaveBeenCalled()
    expect(resolveOktaGroupName).not.toHaveBeenCalled()
  })

  it('labels an everyone share as Everyone with a null email', async () => {
    const [resolved] = await resolveShareNames([
      {
        id: 's3',
        entityType: 'agent',
        entityId: 'a1',
        targetType: 'everyone',
        targetId: null,
        createdBy: 'owner',
        createdAt: 1,
      },
    ])

    expect(resolved.targetName).toBe('Everyone')
    expect(resolved.targetEmail).toBeNull()
    expect(getUser).not.toHaveBeenCalled()
    expect(getGroup).not.toHaveBeenCalled()
    expect(resolveOktaUserName).not.toHaveBeenCalled()
    expect(resolveOktaGroupName).not.toHaveBeenCalled()
  })
})

describe('enrichUsers / enrichGroups', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    isAuthEnabled.mockReturnValue(true)
    upsertGroup.mockResolvedValue(undefined)
    resolveOktaUserName.mockResolvedValue(null)
    resolveOktaGroupName.mockResolvedValue(null)
  })

  it('skips Okta for a user whose stored name is already friendly', async () => {
    const user = localUser()
    const [enriched] = await enrichUsers([user])
    expect(enriched).toEqual(user)
    expect(resolveOktaUserName).not.toHaveBeenCalled()
  })

  it('replaces an opaque user name and email from Okta without writing the users table', async () => {
    resolveOktaUserName.mockResolvedValue({
      id: OPAQUE_USER_ID,
      name: 'Ada Lovelace',
      email: 'ada@example.com',
    })

    const [enriched] = await enrichUsers([localUser({ name: OPAQUE_USER_ID, email: 'stale@example.com' })])

    expect(enriched.id).toBe(OPAQUE_USER_ID)
    expect(enriched.name).toBe('Ada Lovelace')
    expect(enriched.email).toBe('ada@example.com')
    expect(resolveOktaUserName).toHaveBeenCalledWith(OPAQUE_USER_ID)
  })

  it('uses the Okta profile name for an opaque group and persists the friendly name', async () => {
    resolveOktaGroupName.mockResolvedValue({ id: OPAQUE_GROUP_ID, name: 'Platform' })

    const [enriched] = await enrichGroups([localGroup({ name: OPAQUE_GROUP_ID })])

    expect(enriched.id).toBe(OPAQUE_GROUP_ID)
    expect(enriched.name).toBe('Platform')
    expect(upsertGroup).toHaveBeenCalledWith({ id: OPAQUE_GROUP_ID, name: 'Platform' })
  })

  it('keeps a local opaque group name when Okta misses and does not upsert', async () => {
    resolveOktaGroupName.mockResolvedValue(null)
    const group = localGroup({ name: OPAQUE_GROUP_ID })

    const [enriched] = await enrichGroups([group])

    expect(enriched).toEqual(group)
    expect(upsertGroup).not.toHaveBeenCalled()
  })

  it('does not persist a group name that still needs a directory lookup', async () => {
    resolveOktaGroupName.mockResolvedValue({ id: OPAQUE_GROUP_ID, name: OPAQUE_GROUP_ID })
    const group = localGroup({ name: OPAQUE_GROUP_ID })

    const [enriched] = await enrichGroups([group])

    expect(enriched.name).toBe(OPAQUE_GROUP_ID)
    expect(upsertGroup).not.toHaveBeenCalled()
  })

  it('does not call Okta when auth is disabled', async () => {
    isAuthEnabled.mockReturnValue(false)
    const user = localUser({ name: OPAQUE_USER_ID })
    const group = localGroup({ name: OPAQUE_GROUP_ID })

    await expect(enrichUsers([user])).resolves.toEqual([user])
    await expect(enrichGroups([group])).resolves.toEqual([group])
    expect(resolveOktaUserName).not.toHaveBeenCalled()
    expect(resolveOktaGroupName).not.toHaveBeenCalled()
    expect(upsertGroup).not.toHaveBeenCalled()
  })
})
