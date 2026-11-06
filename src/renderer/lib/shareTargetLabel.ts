import { isOpaqueOktaId } from '@shared/oktaId'

function trimmed(value?: string | null): string | undefined {
  const next = value?.trim()
  return next ? next : undefined
}

export function shareTargetTitle(input: {
  targetType: 'user' | 'group' | 'everyone'
  targetName?: string | null
  targetId?: string | null
  knownName?: string | null
}): string {
  if (input.targetType === 'everyone') return 'Everyone'

  const candidates = [trimmed(input.targetName), trimmed(input.knownName)].filter(
    (value): value is string => Boolean(value)
  )
  const friendly = candidates.find((value) => !isOpaqueOktaId(value))
  if (friendly) return friendly
  if (candidates[0]) return candidates[0]
  return input.targetType === 'user' ? 'Unknown user' : 'Unknown group'
}

export function shareTargetSubtitle(input: {
  targetType: 'user' | 'group' | 'everyone'
  targetEmail?: string | null
}): string {
  if (input.targetType === 'everyone') return 'Everyone'
  if (input.targetType === 'group') return 'Group'
  return trimmed(input.targetEmail) ?? 'User'
}
