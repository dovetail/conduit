import { describe, it, expect, vi, afterEach } from 'vitest'
import * as crypto from 'crypto'
import { generatePkce, buildAuthorizationUrl, exchangeCode, refreshAccessToken } from './flow'

describe('flow', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('generatePkce produces a valid S256 challenge', () => {
    const { verifier, challenge } = generatePkce()
    const expected = crypto.createHash('sha256').update(verifier).digest('base64url')
    expect(challenge).toBe(expected)
  })

  it('buildAuthorizationUrl sets PKCE + state params', () => {
    const url = new URL(buildAuthorizationUrl({
      authorizationEndpoint: 'https://as/authorize', clientId: 'c1',
      redirectUri: 'http://localhost:7456/mcp/oauth/callback', scopes: ['read', 'write'],
      state: 'st', challenge: 'ch',
    }))
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('scope')).toBe('read write')
    expect(url.searchParams.get('state')).toBe('st')
  })

  it('buildAuthorizationUrl includes the RFC 8707 resource indicator when provided', () => {
    const url = new URL(buildAuthorizationUrl({
      authorizationEndpoint: 'https://as/authorize', clientId: 'c1',
      redirectUri: 'http://localhost:7456/mcp/oauth/callback', scopes: ['read'],
      state: 'st', challenge: 'ch', resource: 'https://mcp.linear.app/mcp',
    }))
    expect(url.searchParams.get('resource')).toBe('https://mcp.linear.app/mcp')
  })

  it('buildAuthorizationUrl omits resource when not provided', () => {
    const url = new URL(buildAuthorizationUrl({
      authorizationEndpoint: 'https://as/authorize', clientId: 'c1',
      redirectUri: 'http://localhost:7456/mcp/oauth/callback', scopes: ['read'],
      state: 'st', challenge: 'ch',
    }))
    expect(url.searchParams.has('resource')).toBe(false)
  })

  it('exchangeCode maps a token response to OAuthToken', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ access_token: 'AT', refresh_token: 'RT', expires_in: 3600, token_type: 'Bearer', scope: 'read' }),
    }) as any))
    const tok = await exchangeCode({
      serverUrl: 'https://mcp', tokenEndpoint: 'https://as/token', clientId: 'c1',
      code: 'xyz', redirectUri: 'http://localhost:7456/mcp/oauth/callback', verifier: 'v',
    })
    expect(tok.accessToken).toBe('AT')
    expect(tok.refreshToken).toBe('RT')
    expect(tok.serverUrl).toBe('https://mcp')
    expect(tok.expiresAt).toBeGreaterThan(Date.now())
  })

  it('exchangeCode sends the resource indicator in the token request body', async () => {
    let body = ''
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: any) => {
      body = init.body
      return { ok: true, json: async () => ({ access_token: 'AT', token_type: 'Bearer' }) } as any
    }))
    await exchangeCode({
      serverUrl: 'https://mcp.linear.app/mcp', tokenEndpoint: 'https://as/token', clientId: 'c1',
      code: 'xyz', redirectUri: 'http://localhost:7456/mcp/oauth/callback', verifier: 'v',
      resource: 'https://mcp.linear.app/mcp',
    })
    expect(new URLSearchParams(body).get('resource')).toBe('https://mcp.linear.app/mcp')
  })

  it('refreshAccessToken sends the resource indicator and preserves the refresh token', async () => {
    let body = ''
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: any) => {
      body = init.body
      return { ok: true, json: async () => ({ access_token: 'AT2', token_type: 'Bearer' }) } as any
    }))
    const tok = await refreshAccessToken({
      serverUrl: 'https://mcp.linear.app/mcp', tokenEndpoint: 'https://as/token', clientId: 'c1',
      refreshToken: 'RT', resource: 'https://mcp.linear.app/mcp',
    })
    const p = new URLSearchParams(body)
    expect(p.get('grant_type')).toBe('refresh_token')
    expect(p.get('resource')).toBe('https://mcp.linear.app/mcp')
    expect(tok.refreshToken).toBe('RT')
  })
})
