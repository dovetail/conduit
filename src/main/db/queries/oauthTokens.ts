import { eq } from 'drizzle-orm'
import { getDb } from '../index'
import { oauthTokens } from '../schema'
import type { OAuthToken } from '../../../shared/types'

function rowToOAuthToken(row: typeof oauthTokens.$inferSelect): OAuthToken {
  return {
    serverUrl: row.serverUrl,
    accessToken: row.accessToken,
    refreshToken: row.refreshToken ?? undefined,
    expiresAt: row.expiresAt ?? undefined,
    tokenType: row.tokenType,
    scope: row.scope ?? undefined,
  }
}

export async function getToken(serverUrl: string): Promise<OAuthToken | null> {
  const rows = await getDb().select().from(oauthTokens).where(eq(oauthTokens.serverUrl, serverUrl))
  if (rows.length === 0) return null
  return rowToOAuthToken(rows[0])
}

export async function saveToken(token: OAuthToken): Promise<void> {
  await getDb()
    .insert(oauthTokens)
    .values({
      serverUrl: token.serverUrl,
      accessToken: token.accessToken,
      refreshToken: token.refreshToken ?? null,
      expiresAt: token.expiresAt ?? null,
      tokenType: token.tokenType,
      scope: token.scope ?? null,
    })
    .onConflictDoUpdate({
      target: oauthTokens.serverUrl,
      set: {
        accessToken: token.accessToken,
        refreshToken: token.refreshToken ?? null,
        expiresAt: token.expiresAt ?? null,
        tokenType: token.tokenType,
        scope: token.scope ?? null,
      },
    })
}

export async function deleteToken(serverUrl: string): Promise<void> {
  await getDb().delete(oauthTokens).where(eq(oauthTokens.serverUrl, serverUrl))
}
