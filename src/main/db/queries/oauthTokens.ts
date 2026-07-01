import { and, eq } from 'drizzle-orm'
import { getDb } from '../index'
import { oauthTokens } from '../schema'
import { encryptSecret, decryptSecret } from '../../../server/crypto'
import { getUser } from './users'
import type { OAuthToken, McpOAuthStatus } from '../../../shared/types'

function rowToOAuthToken(row: typeof oauthTokens.$inferSelect): OAuthToken {
  return {
    serverUrl: row.serverUrl,
    accessToken: decryptSecret(row.accessToken),
    refreshToken: row.refreshToken ? decryptSecret(row.refreshToken) : undefined,
    expiresAt: row.expiresAt ?? undefined,
    tokenType: row.tokenType,
    scope: row.scope ?? undefined,
  }
}

export async function getToken(serverUrl: string, tokenOwner: string): Promise<OAuthToken | null> {
  const rows = await getDb().select().from(oauthTokens)
    .where(and(eq(oauthTokens.serverUrl, serverUrl), eq(oauthTokens.tokenOwner, tokenOwner)))
  if (rows.length === 0) return null
  return rowToOAuthToken(rows[0])
}

export async function saveToken(
  token: OAuthToken,
  tokenOwner: string,
  connectedByUserId: string | null
): Promise<void> {
  const values = {
    serverUrl: token.serverUrl,
    tokenOwner,
    connectedByUserId,
    accessToken: encryptSecret(token.accessToken),
    refreshToken: token.refreshToken ? encryptSecret(token.refreshToken) : null,
    expiresAt: token.expiresAt ?? null,
    tokenType: token.tokenType,
    scope: token.scope ?? null,
  }
  const updateSet: Partial<typeof oauthTokens.$inferInsert> = {
    accessToken: values.accessToken,
    refreshToken: values.refreshToken,
    expiresAt: values.expiresAt,
    tokenType: values.tokenType,
    scope: values.scope,
  }
  if (connectedByUserId !== null) updateSet.connectedByUserId = connectedByUserId
  await getDb().insert(oauthTokens).values(values).onConflictDoUpdate({
    target: [oauthTokens.serverUrl, oauthTokens.tokenOwner],
    set: updateSet,
  })
}

export async function deleteToken(serverUrl: string, tokenOwner: string): Promise<void> {
  await getDb().delete(oauthTokens)
    .where(and(eq(oauthTokens.serverUrl, serverUrl), eq(oauthTokens.tokenOwner, tokenOwner)))
}

export async function getConnectedByUserId(serverUrl: string, tokenOwner: string): Promise<string | null> {
  const rows = await getDb().select().from(oauthTokens)
    .where(and(eq(oauthTokens.serverUrl, serverUrl), eq(oauthTokens.tokenOwner, tokenOwner)))
  return rows[0]?.connectedByUserId ?? null
}

export async function getTokenStatus(
  serverUrl: string,
  tokenOwner: string,
  scope: 'user' | 'global'
): Promise<McpOAuthStatus> {
  const rows = await getDb().select().from(oauthTokens)
    .where(and(eq(oauthTokens.serverUrl, serverUrl), eq(oauthTokens.tokenOwner, tokenOwner)))
  if (rows.length === 0) return { connected: false, scope }
  const row = rows[0]
  let connectedByName: string | undefined
  if (row.connectedByUserId) {
    const u = await getUser(row.connectedByUserId)
    connectedByName = u?.name ?? u?.email ?? row.connectedByUserId
  }
  return {
    connected: true,
    connectedByUserId: row.connectedByUserId ?? undefined,
    connectedByName,
    scope,
    expiresAt: row.expiresAt ?? undefined,
  }
}
