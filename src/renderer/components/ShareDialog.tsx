import React, { useState, useMemo } from 'react'
import { X, Users, Search, Trash2, Globe } from 'lucide-react'
import { Dialog } from '@renderer/components/ui/dialog'
import { Input } from '@renderer/components/ui/input'
import {
  useShares,
  useCreateShare,
  useDeleteShare,
  useSearchUsers,
  useGroups,
  useUsers,
} from '@renderer/hooks/useShares'
import type { ShareableEntityType, Share } from '@shared/types'

interface ShareDialogProps {
  entityType: ShareableEntityType
  entityId: string
  isOpen: boolean
  onClose: () => void
}

export function ShareDialog({ entityType, entityId, isOpen, onClose }: ShareDialogProps) {
  const [searchQuery, setSearchQuery] = useState('')

  const { data: shares = [], isLoading: sharesLoading } = useShares(entityType, entityId)
  const { data: searchResults = [] } = useSearchUsers(searchQuery)
  const { data: groups = [] } = useGroups()
  const { data: allUsers = [] } = useUsers()

  const createShare = useCreateShare()
  const deleteShare = useDeleteShare()

  const everyoneShare = shares.find((s) => s.targetType === 'everyone')
  const isSharedWithEveryone = Boolean(everyoneShare)

  // Build a lookup map for displaying share target names
  const userMap = useMemo(() => {
    const map = new Map<string, string>()
    for (const u of allUsers) {
      map.set(u.id, u.name)
    }
    return map
  }, [allUsers])

  const groupMap = useMemo(() => {
    const map = new Map<string, string>()
    for (const g of groups) {
      map.set(g.id, g.name)
    }
    return map
  }, [groups])

  // IDs already shared with (to hide from search results)
  const sharedTargetIds = useMemo(() => {
    const ids = new Set<string>()
    for (const s of shares) {
      if (s.targetId) ids.add(s.targetId)
    }
    return ids
  }, [shares])

  const filteredSearchResults = searchResults.filter((u) => !sharedTargetIds.has(u.id))
  // Filter groups by the same search box (type-ahead) so large group lists stay usable.
  const groupQuery = searchQuery.trim().toLowerCase()
  const filteredGroups = groups.filter(
    (g) => !sharedTargetIds.has(g.id) && (groupQuery === '' || g.name.toLowerCase().includes(groupQuery))
  )

  function getShareTargetName(share: Share): string {
    if (share.targetType === 'everyone') return 'Everyone'
    if (share.targetType === 'user' && share.targetId) {
      return userMap.get(share.targetId) ?? 'Unknown user'
    }
    if (share.targetType === 'group' && share.targetId) {
      return groupMap.get(share.targetId) ?? 'Unknown group'
    }
    return 'Unknown'
  }

  function getShareTargetLabel(share: Share): string {
    if (share.targetType === 'everyone') return 'Everyone'
    if (share.targetType === 'user') return 'User'
    if (share.targetType === 'group') return 'Group'
    return ''
  }

  function handleToggleEveryone() {
    if (isSharedWithEveryone && everyoneShare) {
      deleteShare.mutate(everyoneShare.id)
    } else {
      createShare.mutate({
        entityType,
        entityId,
        targetType: 'everyone',
      })
    }
  }

  function handleShareWithUser(userId: string) {
    createShare.mutate({
      entityType,
      entityId,
      targetType: 'user',
      targetId: userId,
    })
    setSearchQuery('')
  }

  function handleShareWithGroup(groupId: string) {
    createShare.mutate({
      entityType,
      entityId,
      targetType: 'group',
      targetId: groupId,
    })
  }

  function handleRemoveShare(shareId: string) {
    deleteShare.mutate(shareId)
  }

  // Non-everyone shares for the list
  const entityShares = shares.filter((s) => s.targetType !== 'everyone')

  return (
    <Dialog open={isOpen} onClose={onClose} title="Share">
      <div className="space-y-4">
        {/* Share with everyone toggle */}
        <div
          className="flex items-center justify-between rounded-lg border border-[var(--border)] px-3 py-2.5"
          style={{ background: 'var(--bg-primary)' }}
        >
          <div className="flex items-center gap-2">
            <Globe className="h-4 w-4 text-[var(--text-secondary)]" />
            <span className="text-sm text-[var(--text-primary)]">Share with everyone</span>
          </div>
          <button
            onClick={handleToggleEveryone}
            className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
              isSharedWithEveryone ? 'bg-[var(--accent)]' : 'bg-[var(--border)]'
            }`}
            role="switch"
            aria-checked={isSharedWithEveryone}
          >
            <span
              className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${
                isSharedWithEveryone ? 'translate-x-[18px]' : 'translate-x-[3px]'
              }`}
            />
          </button>
        </div>

        {/* Search users */}
        <div className="space-y-2">
          <label className="block text-xs font-medium text-[var(--text-secondary)]">
            Add people or groups
          </label>
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--text-secondary)]" />
            <Input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search users by name or email..."
              className="pl-8"
            />
          </div>

          {/* Search results dropdown */}
          {searchQuery.length >= 2 && filteredSearchResults.length > 0 && (
            <div
              className="rounded-lg border border-[var(--border)] overflow-y-auto max-h-56"
              style={{ background: 'var(--bg-primary)' }}
            >
              {filteredSearchResults.map((user) => (
                <button
                  key={user.id}
                  onClick={() => handleShareWithUser(user.id)}
                  className="w-full flex items-center gap-2.5 px-3 py-2 text-left hover:bg-[var(--bg-secondary)] transition-colors"
                >
                  {user.avatarUrl ? (
                    <img
                      src={user.avatarUrl}
                      alt={user.name}
                      className="h-5 w-5 rounded-full"
                    />
                  ) : (
                    <span
                      className="flex items-center justify-center h-5 w-5 rounded-full text-[10px] font-medium"
                      style={{
                        background: 'var(--accent)',
                        color: 'var(--accent-fg)',
                      }}
                    >
                      {user.name.charAt(0).toUpperCase()}
                    </span>
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-medium text-[var(--text-primary)] truncate">
                      {user.name}
                    </p>
                    <p className="text-[10px] text-[var(--text-secondary)] truncate">
                      {user.email}
                    </p>
                  </div>
                </button>
              ))}
            </div>
          )}

          {searchQuery.length >= 2 && filteredSearchResults.length === 0 && (
            <p className="text-xs text-[var(--text-secondary)] px-1">No users found</p>
          )}
        </div>

        {/* Groups */}
        {filteredGroups.length > 0 && (
          <div className="space-y-2">
            <label className="block text-xs font-medium text-[var(--text-secondary)]">
              Groups {searchQuery.trim() && <span className="opacity-60">({filteredGroups.length})</span>}
            </label>
            <div
              className="rounded-lg border border-[var(--border)] overflow-y-auto max-h-56"
              style={{ background: 'var(--bg-primary)' }}
            >
              {filteredGroups.map((group) => (
                <button
                  key={group.id}
                  onClick={() => handleShareWithGroup(group.id)}
                  className="w-full flex items-center gap-2.5 px-3 py-2 text-left hover:bg-[var(--bg-secondary)] transition-colors"
                >
                  <Users className="h-4 w-4 text-[var(--text-secondary)]" />
                  <span className="text-xs font-medium text-[var(--text-primary)]">
                    {group.name}
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Current shares */}
        <div className="space-y-2">
          <label className="block text-xs font-medium text-[var(--text-secondary)]">
            Shared with
          </label>
          {sharesLoading ? (
            <p className="text-xs text-[var(--text-secondary)] px-1">Loading...</p>
          ) : entityShares.length === 0 && !isSharedWithEveryone ? (
            <p className="text-xs text-[var(--text-secondary)] px-1">
              Not shared with anyone yet
            </p>
          ) : (
            <div
              className="rounded-lg border border-[var(--border)] overflow-hidden divide-y divide-[var(--border)]"
              style={{ background: 'var(--bg-primary)' }}
            >
              {entityShares.map((share) => (
                <div
                  key={share.id}
                  className="flex items-center justify-between px-3 py-2"
                >
                  <div className="flex items-center gap-2.5 min-w-0">
                    {share.targetType === 'group' ? (
                      <Users className="h-4 w-4 flex-shrink-0 text-[var(--text-secondary)]" />
                    ) : (
                      <span
                        className="flex items-center justify-center h-5 w-5 flex-shrink-0 rounded-full text-[10px] font-medium"
                        style={{
                          background: 'var(--accent)',
                          color: 'var(--accent-fg)',
                        }}
                      >
                        {getShareTargetName(share).charAt(0).toUpperCase()}
                      </span>
                    )}
                    <div className="min-w-0">
                      <p className="text-xs font-medium text-[var(--text-primary)] truncate">
                        {getShareTargetName(share)}
                      </p>
                      <p className="text-[10px] text-[var(--text-secondary)]">
                        {getShareTargetLabel(share)}
                      </p>
                    </div>
                  </div>
                  <button
                    onClick={() => handleRemoveShare(share.id)}
                    className="rounded-md p-1 text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)] hover:text-red-400 transition-colors"
                    title="Remove"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </Dialog>
  )
}
