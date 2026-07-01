// src/server/mcpOAuth/discovery.ts
import type { McpOAuthConfig } from '../../shared/types'
import { getClient, saveClient, type McpOAuthClient } from '../../main/db/queries/mcpOAuthClients'

export interface OAuthServerMetadata {
  authorization_endpoint: string
  token_endpoint: string
  registration_endpoint?: string
}

/** Fetch an AS metadata document and return it if it has the required fields, null otherwise. */
async function fetchAsMetadata(metadataUrl: string): Promise<OAuthServerMetadata | null> {
  try {
    const res = await fetch(metadataUrl, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(5000) })
    if (!res.ok) return null
    const data = (await res.json()) as Record<string, unknown>
    if (typeof data.authorization_endpoint === 'string' && typeof data.token_endpoint === 'string') {
      return {
        authorization_endpoint: data.authorization_endpoint,
        token_endpoint: data.token_endpoint,
        registration_endpoint:
          typeof data.registration_endpoint === 'string' ? data.registration_endpoint : undefined,
      }
    }
    return null
  } catch {
    return null
  }
}

export async function discoverOAuthEndpoints(serverUrl: string): Promise<OAuthServerMetadata> {
  const base = serverUrl.replace(/\/$/, '')
  // origin is used for RFC 9728 fallback PRM path (always host-rooted)
  let origin: string
  try {
    origin = new URL(serverUrl).origin
  } catch {
    origin = base
  }

  // Step 1: Try base well-known candidates directly.
  const baseCandidates = [
    `${base}/.well-known/oauth-authorization-server`,
    `${base}/.well-known/openid-configuration`,
  ]
  for (const url of baseCandidates) {
    const meta = await fetchAsMetadata(url)
    if (meta) return meta
  }

  // Step 2: Protected-resource-metadata path (RFC 9728 / MCP auth).
  try {
    // 2a. Fetch the resource URL itself to get the WWW-Authenticate header.
    let prmUrl: string | null = null
    try {
      const resourceRes = await fetch(serverUrl, {
        method: 'GET',
        headers: { Accept: '*/*' },
        signal: AbortSignal.timeout(5000),
      })
      const wwwAuth = resourceRes.headers.get('www-authenticate') ?? resourceRes.headers.get('WWW-Authenticate')
      if (wwwAuth) {
        const match = /resource_metadata="([^"]+)"/.exec(wwwAuth)
        if (match) {
          prmUrl = match[1]
        }
      }
    } catch {
      // network failure for resource fetch — proceed to fallback PRM URL
    }

    // Fall back to <origin>/.well-known/oauth-protected-resource if no explicit URL.
    if (!prmUrl) {
      prmUrl = `${origin}/.well-known/oauth-protected-resource`
    }

    // 2b. Fetch the PRM document.
    const prmRes = await fetch(prmUrl, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(5000) })
    if (prmRes.ok) {
      const prmData = (await prmRes.json()) as Record<string, unknown>
      const authorizationServers = Array.isArray(prmData.authorization_servers)
        ? (prmData.authorization_servers as unknown[])
        : []
      if (authorizationServers.length > 0 && typeof authorizationServers[0] === 'string') {
        const asBase = (authorizationServers[0] as string).replace(/\/$/, '')
        // 2c. Try AS well-known candidates.
        const asCandidates = [
          `${asBase}/.well-known/oauth-authorization-server`,
          `${asBase}/.well-known/openid-configuration`,
        ]
        for (const url of asCandidates) {
          const meta = await fetchAsMetadata(url)
          if (meta) return meta
        }
      }
    }
  } catch {
    // PRM path failed entirely — fall through to error
  }

  throw new Error(
    `Could not discover OAuth endpoints for ${serverUrl}. Tried ` +
      `/.well-known/oauth-authorization-server, /.well-known/openid-configuration, ` +
      `and the protected-resource-metadata path (RFC 9728).`
  )
}

async function registerClient(
  metadata: OAuthServerMetadata,
  oauthConfig: McpOAuthConfig | undefined,
  redirectUri: string
): Promise<{ clientId: string; clientSecret?: string; registrationData?: string }> {
  const body = {
    client_name: 'Conduit',
    redirect_uris: [redirectUri],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    ...(oauthConfig?.scopes?.length ? { scope: oauthConfig.scopes.join(' ') } : {}),
  }
  const res = await fetch(metadata.registration_endpoint as string, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  })
  if (!res.ok) {
    throw new Error(`Dynamic client registration failed (${res.status}): ${await res.text()}`)
  }
  const data = (await res.json()) as Record<string, unknown>
  if (typeof data.client_id !== 'string') {
    throw new Error('Registration response did not contain client_id')
  }
  return {
    clientId: data.client_id,
    clientSecret: typeof data.client_secret === 'string' ? data.client_secret : undefined,
    registrationData: JSON.stringify(data),
  }
}

/**
 * Return a usable OAuth client for the MCP server, registering (DCR) and caching
 * one if none exists. Falls back to a manually configured clientId.
 */
export async function ensureRegisteredClient(
  serverUrl: string,
  oauthConfig: McpOAuthConfig | undefined,
  redirectUri: string
): Promise<McpOAuthClient> {
  const cached = await getClient(serverUrl)
  if (cached) return cached

  const metadata = await discoverOAuthEndpoints(serverUrl)

  let clientId: string
  let clientSecret: string | undefined
  let registrationData: string | undefined

  if (oauthConfig?.clientId) {
    clientId = oauthConfig.clientId
  } else if (metadata.registration_endpoint) {
    const reg = await registerClient(metadata, oauthConfig, redirectUri)
    clientId = reg.clientId
    clientSecret = reg.clientSecret
    registrationData = reg.registrationData
  } else {
    throw new Error(
      `MCP server ${serverUrl} does not support dynamic client registration and no clientId was configured.`
    )
  }

  const client: McpOAuthClient = {
    serverUrl,
    clientId,
    clientSecret,
    authorizationEndpoint: oauthConfig?.authorizationUrl || metadata.authorization_endpoint,
    tokenEndpoint: oauthConfig?.tokenUrl || metadata.token_endpoint,
    registrationData,
  }
  await saveClient(client)
  return client
}
