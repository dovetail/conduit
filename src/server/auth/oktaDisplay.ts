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

function escapeOktaFilterValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

/**
 * Okta SCIM filter for a type-ahead user search, or null when there is nothing
 * to search for. Each whitespace-separated word must start a first name, last
 * name, email or login, so "jane smith" finds Jane Smith (a single `sw` against
 * the whole string would match neither field). Values are escaped so a quote
 * in the query can't break the filter.
 */
export function buildOktaUserSearchFilter(query: string): string | null {
  const words = query.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return null
  return words
    .map((word) => {
      const v = escapeOktaFilterValue(word)
      return `(profile.firstName sw "${v}" or profile.lastName sw "${v}" or profile.email sw "${v}" or profile.login sw "${v}")`
    })
    .join(' and ')
}
