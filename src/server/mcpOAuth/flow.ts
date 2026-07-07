import * as crypto from 'crypto'
import type { OAuthToken } from '../../shared/types'

export function generatePkce(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(32).toString('base64url')
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

export function buildAuthorizationUrl(a: {
  authorizationEndpoint: string
  clientId: string
  redirectUri: string
  scopes: string[]
  state: string
  challenge: string
  resource?: string
}): string {
  const url = new URL(a.authorizationEndpoint)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', a.clientId)
  url.searchParams.set('redirect_uri', a.redirectUri)
  if (a.scopes.length) url.searchParams.set('scope', a.scopes.join(' '))
  url.searchParams.set('state', a.state)
  url.searchParams.set('code_challenge', a.challenge)
  url.searchParams.set('code_challenge_method', 'S256')
  // RFC 8707 resource indicator — binds the issued token's audience to the MCP
  // server. MCP servers that implement the 2025 auth spec (e.g. Linear) reject
  // tokens whose audience is not the resource, so the handshake succeeds but every
  // subsequent request 401s. Must match the value sent at token exchange.
  if (a.resource) url.searchParams.set('resource', a.resource)
  return url.toString()
}

function tokenResponseToOAuthToken(serverUrl: string, data: Record<string, unknown>): OAuthToken {
  if (typeof data.access_token !== 'string') {
    throw new Error('Token response did not contain access_token')
  }
  return {
    serverUrl,
    accessToken: data.access_token,
    refreshToken: typeof data.refresh_token === 'string' ? data.refresh_token : undefined,
    expiresAt: typeof data.expires_in === 'number' ? Date.now() + data.expires_in * 1000 : undefined,
    tokenType: typeof data.token_type === 'string' ? data.token_type : 'Bearer',
    scope: typeof data.scope === 'string' ? data.scope : undefined,
  }
}

async function postToken(tokenEndpoint: string, params: URLSearchParams): Promise<Record<string, unknown>> {
  const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }
  const res = await fetch(tokenEndpoint, { method: 'POST', headers, body: params.toString(), signal: AbortSignal.timeout(10000) })
  if (!res.ok) throw new Error(`Token request failed (${res.status}): ${await res.text()}`)
  return (await res.json()) as Record<string, unknown>
}

export async function exchangeCode(a: {
  serverUrl: string; tokenEndpoint: string; clientId: string; clientSecret?: string
  code: string; redirectUri: string; verifier: string; resource?: string
}): Promise<OAuthToken> {
  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    code: a.code,
    redirect_uri: a.redirectUri,
    client_id: a.clientId,
    code_verifier: a.verifier,
  })
  if (a.clientSecret) params.set('client_secret', a.clientSecret)
  // RFC 8707 — must match the resource sent in the authorization request.
  if (a.resource) params.set('resource', a.resource)
  return tokenResponseToOAuthToken(a.serverUrl, await postToken(a.tokenEndpoint, params))
}

export async function refreshAccessToken(a: {
  serverUrl: string; tokenEndpoint: string; clientId: string; clientSecret?: string; refreshToken: string; resource?: string
}): Promise<OAuthToken> {
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: a.refreshToken,
    client_id: a.clientId,
  })
  if (a.clientSecret) params.set('client_secret', a.clientSecret)
  // RFC 8707 — keep the refreshed token audience-bound to the same resource.
  if (a.resource) params.set('resource', a.resource)
  const tok = tokenResponseToOAuthToken(a.serverUrl, await postToken(a.tokenEndpoint, params))
  // Some providers omit refresh_token on refresh — preserve the previous one.
  if (!tok.refreshToken) tok.refreshToken = a.refreshToken
  return tok
}
