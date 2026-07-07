// src/server/mcpOAuth/discovery.ts
import type { McpOAuthConfig } from '../../shared/types'
import { getClient, saveClient, type McpOAuthClient } from '../../main/db/queries/mcpOAuthClients'

export interface OAuthServerMetadata {
  authorization_endpoint: string
  token_endpoint: string
  registration_endpoint?: string
  /**
   * Canonical MCP resource URI (RFC 8707). Sourced from the protected-resource
   * metadata `resource` field (RFC 9728) or echoed by the AS metadata. Passed as
   * the `resource` indicator on auth + token requests.
   */
  resource?: string
}

/**
 * Build the well-known metadata URLs to try for an issuer/base URL.
 *
 * When the URL has a path (e.g. https://host/v1/mcp), RFC 8414 puts the
 * authorization-server metadata at `https://host/.well-known/oauth-authorization-server/v1/mcp`
 * (segment inserted between host and path) — and many deployments also expose it
 * origin-rooted. OIDC discovery instead appends `/.well-known/openid-configuration`
 * after the path. We try all of these so path-scoped servers (like Datadog's
 * `/v1/mcp`) are discovered rather than 404ing on a naive `${url}/.well-known/...`.
 */
export function wellKnownCandidates(urlStr: string): string[] {
  let u: URL
  try {
    u = new URL(urlStr)
  } catch {
    return []
  }
  const origin = u.origin
  const path = u.pathname.replace(/\/+$/, '')
  const hasPath = path.length > 0 && path !== '/'
  const candidates: string[] = []
  // RFC 8414: well-known segment inserted between host and path (path-aware), then origin-rooted.
  if (hasPath) candidates.push(`${origin}/.well-known/oauth-authorization-server${path}`)
  candidates.push(`${origin}/.well-known/oauth-authorization-server`)
  // OIDC discovery: appended after the path, plus the path-inserted and origin-rooted variants.
  if (hasPath) {
    candidates.push(`${origin}${path}/.well-known/openid-configuration`)
    candidates.push(`${origin}/.well-known/openid-configuration${path}`)
  }
  candidates.push(`${origin}/.well-known/openid-configuration`)
  return candidates
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
        resource: typeof data.resource === 'string' ? data.resource : undefined,
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

  // Step 1: Try well-known candidates for the server URL (RFC 8414 + OIDC, path-aware).
  for (const url of wellKnownCandidates(serverUrl)) {
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

    // Fall back to well-known PRM locations if no explicit URL was advertised.
    // Try the path-aware location first (RFC 9728), then origin-rooted.
    const path = (() => { try { return new URL(serverUrl).pathname.replace(/\/+$/, '') } catch { return '' } })()
    const prmCandidates = prmUrl
      ? [prmUrl]
      : [
          ...(path && path !== '/' ? [`${origin}/.well-known/oauth-protected-resource${path}`] : []),
          `${origin}/.well-known/oauth-protected-resource`,
        ]

    // 2b. Fetch the first PRM document that resolves.
    for (const candidate of prmCandidates) {
      const prmRes = await fetch(candidate, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(5000) })
      if (!prmRes.ok) continue
      const prmData = (await prmRes.json()) as Record<string, unknown>
      // The PRM `resource` field is the authoritative canonical resource identifier
      // (RFC 9728) — prefer it over anything the AS metadata echoes.
      const prmResource = typeof prmData.resource === 'string' ? prmData.resource : undefined
      const authorizationServers = Array.isArray(prmData.authorization_servers)
        ? (prmData.authorization_servers as unknown[])
        : []
      if (authorizationServers.length > 0 && typeof authorizationServers[0] === 'string') {
        // 2c. Try AS well-known candidates (RFC 8414 + OIDC, path-aware).
        for (const url of wellKnownCandidates(authorizationServers[0] as string)) {
          const meta = await fetchAsMetadata(url)
          if (meta) return { ...meta, resource: prmResource ?? meta.resource }
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

/** Parse the `redirect_uris` a DCR response recorded, or null if unavailable. */
function registeredRedirectUris(client: McpOAuthClient): string[] | null {
  if (!client.registrationData) return null
  try {
    const uris = (JSON.parse(client.registrationData) as Record<string, unknown>).redirect_uris
    return Array.isArray(uris) ? (uris as string[]) : null
  } catch {
    return null
  }
}

/**
 * Whether a cached client can be reused for the current `redirectUri`.
 *
 * OAuth providers validate every auth/token request's `redirect_uri` against
 * exactly what the client registered (Sentry rejects at authorize; Datadog, being
 * OAuth 2.1, at the token step — "Mismatching redirect URI"). So reuse must be
 * deterministic:
 *  - Manually configured clients: we don't manage their redirect registration, so
 *    trust them as long as the configured clientId still matches.
 *  - DCR clients with a recorded `redirectUri` (the authoritative signal): reuse
 *    only on an exact match.
 *  - Legacy DCR rows (no recorded `redirectUri`, from before this column existed):
 *    fall back to the `redirect_uris` echoed in `registrationData`; if those can't
 *    be verified, re-register rather than reuse a possibly-stale client. This is
 *    what fixes a client registered against an earlier origin — reusing it sends a
 *    redirect_uri the provider never registered.
 */
function cachedClientIsUsable(
  cached: McpOAuthClient,
  oauthConfig: McpOAuthConfig | undefined,
  redirectUri: string
): boolean {
  if (oauthConfig?.clientId) return cached.clientId === oauthConfig.clientId
  if (cached.redirectUri != null) return cached.redirectUri === redirectUri
  const uris = registeredRedirectUris(cached)
  if (uris == null) return false
  return uris.includes(redirectUri)
}

/**
 * Return a usable OAuth client for the MCP server, registering (DCR) and caching
 * one if none exists. Falls back to a manually configured clientId.
 *
 * A cached client is reused only when it was registered for exactly the current
 * `redirectUri`; otherwise it's stale (registered against an earlier origin) and
 * the provider would reject the mismatch, so we re-register. A reusable client
 * that predates the `resource`/`redirectUri` columns is backfilled in place (no
 * re-registration, so we don't hit DCR rate limits).
 */
export async function ensureRegisteredClient(
  serverUrl: string,
  oauthConfig: McpOAuthConfig | undefined,
  redirectUri: string
): Promise<McpOAuthClient> {
  const cached = await getClient(serverUrl)
  if (cached && cachedClientIsUsable(cached, oauthConfig, redirectUri)) {
    if (cached.resource && cached.redirectUri) return cached
    // Reusable but predates the resource/redirectUri columns — backfill in place.
    let resource = cached.resource
    if (!resource) {
      try {
        resource = (await discoverOAuthEndpoints(serverUrl)).resource ?? serverUrl
      } catch {
        resource = serverUrl
      }
    }
    const backfilled: McpOAuthClient = { ...cached, resource, redirectUri: cached.redirectUri ?? redirectUri }
    await saveClient(backfilled)
    return backfilled
  }

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
    resource: metadata.resource ?? serverUrl,
    redirectUri,
    registrationData,
  }
  await saveClient(client)
  return client
}
