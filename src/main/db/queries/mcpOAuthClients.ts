import { eq } from 'drizzle-orm'
import { getDb } from '../index'
import { mcpOAuthClients } from '../schema'
import { encryptSecret, decryptSecret } from '../../../server/crypto'

export interface McpOAuthClient {
  serverUrl: string
  clientId: string
  clientSecret?: string
  authorizationEndpoint: string
  tokenEndpoint: string
  /** Canonical MCP resource URI (RFC 8707) sent as the `resource` indicator. */
  resource?: string
  /** The exact redirect URI this client was registered with (for staleness checks). */
  redirectUri?: string
  registrationData?: string
}

function rowToClient(row: typeof mcpOAuthClients.$inferSelect): McpOAuthClient {
  return {
    serverUrl: row.serverUrl,
    clientId: row.clientId,
    clientSecret: row.clientSecretEnc ? decryptSecret(row.clientSecretEnc) : undefined,
    authorizationEndpoint: row.authorizationEndpoint,
    tokenEndpoint: row.tokenEndpoint,
    resource: row.resource ?? undefined,
    redirectUri: row.redirectUri ?? undefined,
    registrationData: row.registrationData ?? undefined,
  }
}

export async function getClient(serverUrl: string): Promise<McpOAuthClient | null> {
  const rows = await getDb().select().from(mcpOAuthClients).where(eq(mcpOAuthClients.serverUrl, serverUrl))
  if (rows.length === 0) return null
  return rowToClient(rows[0])
}

export async function saveClient(client: McpOAuthClient): Promise<void> {
  const now = Date.now()
  const values = {
    serverUrl: client.serverUrl,
    clientId: client.clientId,
    clientSecretEnc: client.clientSecret ? encryptSecret(client.clientSecret) : null,
    authorizationEndpoint: client.authorizationEndpoint,
    tokenEndpoint: client.tokenEndpoint,
    resource: client.resource ?? null,
    redirectUri: client.redirectUri ?? null,
    registrationData: client.registrationData ?? null,
    createdAt: now,
    updatedAt: now,
  }
  await getDb().insert(mcpOAuthClients).values(values).onConflictDoUpdate({
    target: mcpOAuthClients.serverUrl,
    set: {
      clientId: values.clientId,
      clientSecretEnc: values.clientSecretEnc,
      authorizationEndpoint: values.authorizationEndpoint,
      tokenEndpoint: values.tokenEndpoint,
      resource: values.resource,
      redirectUri: values.redirectUri,
      registrationData: values.registrationData,
      updatedAt: now,
    },
  })
}

export async function deleteClient(serverUrl: string): Promise<void> {
  await getDb().delete(mcpOAuthClients).where(eq(mcpOAuthClients.serverUrl, serverUrl))
}
