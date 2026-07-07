import { putPendingAuth, takePendingAuth } from '../../main/db/queries/mcpOAuthPending'

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

/**
 * Pending OAuth state is persisted in Postgres (see mcpOAuthPending), NOT an
 * in-process Map: `startAuth` and the `/mcp/oauth/callback` HTTP request can land
 * on different pods in a multi-replica deployment, so the callback must be able to
 * find the state regardless of which pod created it.
 */
export function putPending(state: string, entry: PendingAuth): Promise<void> {
  return putPendingAuth(state, entry)
}

/** Atomically consume pending state; resolves null if unknown or expired. */
export function takePending(state: string): Promise<PendingAuth | null> {
  return takePendingAuth(state)
}
