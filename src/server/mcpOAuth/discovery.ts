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

interface ProtectedResourceMetadata {
  /** The canonical resource identifier (RFC 9728 `resource`) — the token audience. */
  resource?: string
  /** Authorization servers advertised by the resource (RFC 9728). */
  authorizationServers: string[]
}

/**
 * Fetch the RFC 9728 protected-resource metadata for an MCP server. This is the
 * ONLY authoritative source of the canonical `resource` (token audience) — AS
 * metadata (RFC 8414) does not carry it. We locate the PRM document via the
 * `WWW-Authenticate: resource_metadata="…"` challenge, falling back to the
 * well-known PRM locations (path-aware, then origin-rooted). Returns null when no
 * PRM document resolves.
 */
async function fetchProtectedResourceMetadata(
  serverUrl: string
): Promise<ProtectedResourceMetadata | null> {
  let origin: string
  try {
    origin = new URL(serverUrl).origin
  } catch {
    origin = serverUrl.replace(/\/$/, '')
  }

  // Prefer the PRM URL advertised in the resource's WWW-Authenticate challenge.
  let prmUrl: string | null = null
  try {
    const resourceRes = await fetch(serverUrl, {
      method: 'GET',
      headers: { Accept: '*/*' },
      signal: AbortSignal.timeout(5000),
    })
    const wwwAuth =
      resourceRes.headers.get('www-authenticate') ?? resourceRes.headers.get('WWW-Authenticate')
    if (wwwAuth) {
      const match = /resource_metadata="([^"]+)"/.exec(wwwAuth)
      if (match) prmUrl = match[1]
    }
  } catch {
    // network failure for resource fetch — proceed to well-known fallbacks
  }

  const path = (() => {
    try {
      return new URL(serverUrl).pathname.replace(/\/+$/, '')
    } catch {
      return ''
    }
  })()
  const prmCandidates = prmUrl
    ? [prmUrl]
    : [
        ...(path && path !== '/' ? [`${origin}/.well-known/oauth-protected-resource${path}`] : []),
        `${origin}/.well-known/oauth-protected-resource`,
      ]

  for (const candidate of prmCandidates) {
    try {
      const prmRes = await fetch(candidate, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(5000),
      })
      if (!prmRes.ok) continue
      const prmData = (await prmRes.json()) as Record<string, unknown>
      const resource = typeof prmData.resource === 'string' ? prmData.resource : undefined
      const authorizationServers = Array.isArray(prmData.authorization_servers)
        ? (prmData.authorization_servers as unknown[]).filter((s): s is string => typeof s === 'string')
        : []
      return { resource, authorizationServers }
    } catch {
      // try the next candidate
    }
  }
  return null
}

export async function discoverOAuthEndpoints(serverUrl: string): Promise<OAuthServerMetadata> {
  // Step 1: AS well-known (RFC 8414 + OIDC, path-aware) — the fast path for
  // path-scoped servers like Datadog's /v1/mcp.
  for (const url of wellKnownCandidates(serverUrl)) {
    const meta = await fetchAsMetadata(url)
    if (meta) {
      // Always resolve the canonical `resource` from PRM (RFC 9728), even though
      // AS metadata was found here — AS metadata almost never carries `resource`,
      // and minting a token bound to the wrong audience (the bare server URL)
      // makes spec-compliant servers (Linear, Sentry) 401 on every call.
      const prm = await fetchProtectedResourceMetadata(serverUrl)
      return { ...meta, resource: prm?.resource ?? meta.resource }
    }
  }

  // Step 2: PRM-driven discovery — the server only advertises its AS via PRM.
  const prm = await fetchProtectedResourceMetadata(serverUrl)
  if (prm && prm.authorizationServers.length > 0) {
    for (const asUrl of prm.authorizationServers) {
      for (const url of wellKnownCandidates(asUrl)) {
        const meta = await fetchAsMetadata(url)
        if (meta) return { ...meta, resource: prm.resource ?? meta.resource }
      }
    }
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
  if (oauthConfig?.clientId) {
    if (cached.clientId !== oauthConfig.clientId) return false
    // Even for a manually-configured client, don't reuse it against a redirect_uri
    // it wasn't registered with when we have a recorded one to compare — a stale
    // redirect is what triggers "Mismatching redirect URI" at the token step.
    if (cached.redirectUri != null) return cached.redirectUri === redirectUri
    return true
  }
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
    // Self-heal the resource in place (no re-registration, so no DCR rate-limit
    // hit): fill it when missing, AND correct it when it's the bare serverUrl
    // fallback left by rows created before canonical PRM discovery existed — that
    // wrong audience is what made Linear/Sentry 401 on every call. Once healed to
    // the canonical value (e.g. …/mcp), it no longer equals serverUrl, so later
    // reconnects skip re-discovery.
    let resource = cached.resource
    if (!resource || resource === serverUrl) {
      try {
        const discovered = (await discoverOAuthEndpoints(serverUrl)).resource
        resource = discovered ?? resource ?? serverUrl
      } catch {
        resource = resource ?? serverUrl
      }
    }
    const redirectUriToUse = cached.redirectUri ?? redirectUri
    if (resource === cached.resource && redirectUriToUse === cached.redirectUri) {
      return cached
    }
    const updated: McpOAuthClient = { ...cached, resource, redirectUri: redirectUriToUse }
    await saveClient(updated)
    return updated
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
