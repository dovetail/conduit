export interface PendingAuth {
  codeVerifier: string
  serverUrl: string
  tokenOwner: string
  connectedByUserId: string
  clientId: string
  clientSecret?: string
  redirectUri: string
  tokenEndpoint: string
  resource?: string
  createdAt: number
}

export const TTL_MS = 10 * 60 * 1000

const pending = new Map<string, PendingAuth>()

export function putPending(state: string, entry: PendingAuth): void {
  pending.set(state, entry)
}

export function takePending(state: string): PendingAuth | null {
  const entry = pending.get(state)
  if (!entry) return null
  pending.delete(state)
  if (Date.now() - entry.createdAt > TTL_MS) return null
  return entry
}
