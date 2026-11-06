import { isOpaqueOktaId } from '../../shared/oktaId'

function isBlank(value: string | null | undefined): boolean {
  return value == null || value.trim() === ''
}

export function needsDirectoryLookup(name: string | null | undefined, id: string): boolean {
  if (isBlank(name)) return true
  if (isOpaqueOktaId(name!)) return true
  return isOpaqueOktaId(id) && name === id
}

export function oktaUserDisplayName(
  profile:
    | {
        displayName?: string
        firstName?: string
        lastName?: string
        email?: string
        login?: string
      }
    | null
    | undefined,
  fallbackId: string
): string {
  const displayName = profile?.displayName?.trim()
  if (displayName) return displayName

  const joined = [profile?.firstName, profile?.lastName]
    .map((part) => part?.trim())
    .filter(Boolean)
    .join(' ')
  if (joined) return joined

  const email = profile?.email?.trim()
  if (email) return email

  const login = profile?.login?.trim()
  if (login) return login

  return fallbackId
}

export function oktaGroupDisplayName(
  profile: { name?: string } | null | undefined,
  fallbackId: string
): string {
  const name = profile?.name?.trim()
  return name || fallbackId
}
