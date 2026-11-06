import type { Group, ResolvedShare, Share, User } from '../shared/types'
import { getUser } from '../main/db/queries/users'
import { getGroup, upsertGroup } from '../main/db/queries/groups'
import { isAuthEnabled } from './auth/config'
import { resolveOktaUserName, resolveOktaGroupName } from './auth/okta'
import { needsDirectoryLookup } from './auth/oktaDisplay'

interface ResolvedTarget {
  name: string
  email: string | null
}

async function resolveNamedTarget(
  id: string,
  loadLocal: () => Promise<ResolvedTarget | null>,
  loadRemote: () => Promise<{ name: string; email?: string | null } | null>
): Promise<ResolvedTarget | null> {
  const local = await loadLocal()
  if (local && !needsDirectoryLookup(local.name, id)) return local
  if (isAuthEnabled()) {
    const remote = await loadRemote()
    if (remote && !needsDirectoryLookup(remote.name, id)) {
      return {
        name: remote.name,
        email: remote.email ?? local?.email ?? null,
      }
    }
  }
  return local
}

/**
 * Enrich shares with friendly target names. A local human label wins; a local
 * row whose name is still an opaque Okta directory id (or is missing) is
 * looked up via the Management API when auth is enabled. Okta misses fall
 * back to the local row so share dialogs never go blank for a known target.
 */
export async function resolveShareNames(shares: Share[]): Promise<ResolvedShare[]> {
  const userIds = new Set<string>()
  const groupIds = new Set<string>()
  for (const share of shares) {
    if (!share.targetId) continue
    if (share.targetType === 'user') userIds.add(share.targetId)
    if (share.targetType === 'group') groupIds.add(share.targetId)
  }

  const resolved = new Map<string, ResolvedTarget>()

  await Promise.all([
    ...[...userIds].map(async (id) => {
      const target = await resolveNamedTarget(
        id,
        async () => {
          const user = await getUser(id)
          return user ? { name: user.name, email: user.email } : null
        },
        () => resolveOktaUserName(id)
      )
      if (target) resolved.set(id, target)
    }),
    ...[...groupIds].map(async (id) => {
      const target = await resolveNamedTarget(
        id,
        async () => {
          const group = await getGroup(id)
          return group ? { name: group.name, email: null } : null
        },
        () => resolveOktaGroupName(id)
      )
      if (target) resolved.set(id, target)
    }),
  ])

  return shares.map((share) => {
    if (share.targetType === 'everyone') {
      return { ...share, targetName: 'Everyone', targetEmail: null }
    }
    const target = share.targetId ? resolved.get(share.targetId) : undefined
    return {
      ...share,
      targetName: target?.name ?? null,
      targetEmail: target?.email ?? null,
    }
  })
}

export async function enrichUsers(users: User[]): Promise<User[]> {
  if (!isAuthEnabled()) return users

  return Promise.all(
    users.map(async (user) => {
      if (!needsDirectoryLookup(user.name, user.id)) return user
      const remote = await resolveOktaUserName(user.id)
      if (!remote || needsDirectoryLookup(remote.name, user.id)) return user
      return {
        ...user,
        name: remote.name,
        ...(remote.email !== undefined ? { email: remote.email } : {}),
      }
    })
  )
}

export async function enrichGroups(groups: Group[]): Promise<Group[]> {
  if (!isAuthEnabled()) return groups

  return Promise.all(
    groups.map(async (group) => {
      if (!needsDirectoryLookup(group.name, group.id)) return group
      const remote = await resolveOktaGroupName(group.id)
      if (!remote || needsDirectoryLookup(remote.name, group.id)) return group
      await upsertGroup({ id: group.id, name: remote.name })
      return { ...group, name: remote.name }
    })
  )
}
