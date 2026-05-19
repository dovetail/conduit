import { getOktaConfig, isAuthEnabled } from './config'
import type { User } from '../../shared/types'

// openid-client v6 is ESM-only, so we must use dynamic import
type OpenIDClient = typeof import('openid-client')
let clientModule: OpenIDClient | null = null
let oidcConfig: import('openid-client').Configuration | null = null

async function getClient(): Promise<OpenIDClient> {
  if (!clientModule) {
    clientModule = await import('openid-client')
  }
  return clientModule
}

export async function initOidcClient(): Promise<void> {
  if (!isAuthEnabled()) return

  const client = await getClient()
  const { issuer, clientId, clientSecret } = getOktaConfig()

  oidcConfig = await client.discovery(
    new URL(issuer),
    clientId,
    clientSecret
  )

  console.log('[auth] OIDC client initialized for issuer:', issuer)
}

export async function getAuthorizationUrl(): Promise<{
  url: URL
  codeVerifier: string
  state: string
}> {
  if (!oidcConfig) throw new Error('OIDC client not initialized')

  const client = await getClient()
  const { redirectUri } = getOktaConfig()

  const codeVerifier = client.randomPKCECodeVerifier()
  const codeChallenge = await client.calculatePKCECodeChallenge(codeVerifier)
  const state = crypto.randomUUID()

  const url = client.buildAuthorizationUrl(oidcConfig, {
    redirect_uri: redirectUri,
    scope: 'openid profile email groups',
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    state,
  })

  return { url, codeVerifier, state }
}

export async function exchangeCode(
  callbackUrl: URL,
  codeVerifier: string,
  expectedState: string
): Promise<{
  accessToken: string
  refreshToken?: string
  expiresIn?: number
  claims: Record<string, unknown>
}> {
  if (!oidcConfig) throw new Error('OIDC client not initialized')

  const client = await getClient()

  const tokenResponse = await client.authorizationCodeGrant(
    oidcConfig,
    callbackUrl,
    {
      pkceCodeVerifier: codeVerifier,
      expectedState,
    }
  )

  const claims = tokenResponse.claims() ?? {}

  return {
    accessToken: tokenResponse.access_token,
    refreshToken: tokenResponse.refresh_token,
    expiresIn: tokenResponse.expires_in,
    claims: claims as Record<string, unknown>,
  }
}

export async function refreshTokens(refreshToken: string): Promise<{
  accessToken: string
  refreshToken?: string
  expiresIn?: number
}> {
  if (!oidcConfig) throw new Error('OIDC client not initialized')

  const client = await getClient()

  const tokenResponse = await client.refreshTokenGrant(oidcConfig, refreshToken)

  return {
    accessToken: tokenResponse.access_token,
    refreshToken: tokenResponse.refresh_token,
    expiresIn: tokenResponse.expires_in,
  }
}

/**
 * Search Okta users via the Management API.
 * Requires CONDUIT_OKTA_API_TOKEN to be set.
 * Returns users matching the query against first name, last name, or email.
 */
export async function searchOktaUsers(query: string): Promise<User[]> {
  const { issuer, apiToken } = getOktaConfig()
  if (!apiToken) return []

  // Okta Management API base is the org URL (issuer without /oauth2/default)
  const orgUrl = issuer.replace(/\/oauth2\/.*$/, '')

  // Okta search uses SCIM filter syntax
  const filter = `profile.firstName sw "${query}" or profile.lastName sw "${query}" or profile.email sw "${query}"`
  const url = `${orgUrl}/api/v1/users?search=${encodeURIComponent(filter)}&limit=20`

  const res = await fetch(url, {
    headers: {
      Authorization: `SSWS ${apiToken}`,
      Accept: 'application/json',
    },
  })

  if (!res.ok) {
    console.error(`[auth] Okta user search failed: ${res.status} ${res.statusText}`)
    return []
  }

  const data = (await res.json()) as Array<{
    id: string
    profile: { firstName?: string; lastName?: string; email?: string; login?: string }
  }>

  return data.map((u) => ({
    id: u.id,
    email: u.profile.email || u.profile.login || '',
    name: [u.profile.firstName, u.profile.lastName].filter(Boolean).join(' ') || u.profile.email || u.id,
    lastLoginAt: 0,
    createdAt: 0,
  }))
}
