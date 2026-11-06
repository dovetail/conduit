import { describe, it, expect, vi, beforeEach } from 'vitest'

const tokens = new Map<string, any>() // key `${url}::${owner}`
vi.mock('../db/queries/oauthTokens', () => ({
  getToken: vi.fn(async (url: string, owner: string) => tokens.get(`${url}::${owner}`) ?? null),
  saveToken: vi.fn(async (t: any, owner: string) => tokens.set(`${t.serverUrl}::${owner}`, t)),
}))
vi.mock('../db/queries/mcpOAuthClients', () => ({
  getClient: vi.fn(async (url: string) => ({ serverUrl: url, clientId: 'c', tokenEndpoint: 'https://as/token', authorizationEndpoint: 'https://as/a', resource: url })),
}))

let refreshImpl: (a: any) => Promise<any> = async (a) => ({
  serverUrl: a.serverUrl,
  accessToken: 'FRESH',
  refreshToken: a.refreshToken,
  tokenType: 'Bearer',
  expiresAt: Date.now() + 3600_000,
})
const refreshAccessToken = vi.fn(async (a: any) => refreshImpl(a))

vi.mock('../../server/mcpOAuth/flow', () => ({
  refreshAccessToken: (a: any) => refreshAccessToken(a),
  normalizeTokenScheme: (t: string) => (t.toLowerCase() === 'bearer' ? 'Bearer' : t),
}))
vi.mock('../db/queries/globalMcps', () => ({ listEnabledGlobalMcps: vi.fn(async () => []) }))
vi.mock('../../server/mcpOAuth/audit', () => ({ auditMcpOAuth: vi.fn() }))

import { injectOAuthTokens, resolveGlobalMcpToken, resolveMcpTokenForUrl } from './mcp'

describe('injectOAuthTokens', () => {
  beforeEach(() => {
    tokens.clear()
    refreshAccessToken.mockClear()
    refreshImpl = async (a) => ({
      serverUrl: a.serverUrl,
      accessToken: 'FRESH',
      refreshToken: a.refreshToken,
      tokenType: 'Bearer',
      expiresAt: Date.now() + 3600_000,
    })
  })

  it('uses the __global__ token for global servers and the user token for agent servers', async () => {
    tokens.set('https://g::__global__', { serverUrl: 'https://g', accessToken: 'GTOK', tokenType: 'Bearer', expiresAt: Date.now() + 1e6 })
    tokens.set('https://a::user-1', { serverUrl: 'https://a', accessToken: 'UTOK', tokenType: 'Bearer', expiresAt: Date.now() + 1e6 })
    const config = { mcpServers: {
      gserver: { type: 'url' as const, url: 'https://g' },
      aserver: { type: 'url' as const, url: 'https://a' },
    } }
    const out = await injectOAuthTokens(config, 'user-1', new Set(['https://g']))
    expect(out.mcpServers.gserver.headers?.Authorization).toBe('Bearer GTOK')
    expect(out.mcpServers.aserver.headers?.Authorization).toBe('Bearer UTOK')
  })

  it('auto-refreshes an expired token that has a refresh token', async () => {
    tokens.set('https://a::user-1', { serverUrl: 'https://a', accessToken: 'OLD', refreshToken: 'RT', tokenType: 'Bearer', expiresAt: Date.now() - 1 })
    const config = { mcpServers: { aserver: { type: 'url' as const, url: 'https://a' } } }
    const out = await injectOAuthTokens(config, 'user-1', new Set())
    expect(out.mcpServers.aserver.headers?.Authorization).toBe('Bearer FRESH')
  })

  it('renews at launch a token that would expire partway through a long run', async () => {
    tokens.set('https://a::user-1', { serverUrl: 'https://a', accessToken: 'OLD', refreshToken: 'RT', tokenType: 'Bearer', expiresAt: Date.now() + 30 * 60_000 })
    const config = { mcpServers: { aserver: { type: 'url' as const, url: 'https://a' } } }
    const out = await injectOAuthTokens(config, 'user-1', new Set())
    expect(out.mcpServers.aserver.headers?.Authorization).toBe('Bearer FRESH')
  })

  it('keeps a long-lived token at launch without refreshing', async () => {
    tokens.set('https://a::user-1', { serverUrl: 'https://a', accessToken: 'LONG', refreshToken: 'RT', tokenType: 'Bearer', expiresAt: Date.now() + 12 * 3600_000 })
    const config = { mcpServers: { aserver: { type: 'url' as const, url: 'https://a' } } }
    const out = await injectOAuthTokens(config, 'user-1', new Set())
    expect(out.mcpServers.aserver.headers?.Authorization).toBe('Bearer LONG')
    expect(refreshAccessToken).not.toHaveBeenCalled()
  })

  it('still injects a valid token at launch when the early refresh fails', async () => {
    refreshImpl = async () => { throw new Error('invalid_grant') }
    tokens.set('https://a::user-1', { serverUrl: 'https://a', accessToken: 'STILL_OK', refreshToken: 'RT', tokenType: 'Bearer', expiresAt: Date.now() + 30 * 60_000 })
    const config = { mcpServers: { aserver: { type: 'url' as const, url: 'https://a' } } }
    const out = await injectOAuthTokens(config, 'user-1', new Set())
    expect(out.mcpServers.aserver.headers?.Authorization).toBe('Bearer STILL_OK')
  })

  it('skips an expired token with no refresh token', async () => {
    tokens.set('https://a::user-1', { serverUrl: 'https://a', accessToken: 'OLD', tokenType: 'Bearer', expiresAt: Date.now() - 1 })
    const config = { mcpServers: { aserver: { type: 'url' as const, url: 'https://a' } } }
    const out = await injectOAuthTokens(config, 'user-1', new Set())
    expect(out.mcpServers.aserver.headers?.Authorization).toBeUndefined()
  })

  it('refreshes a token that is still valid but inside the skew window (Linear 24h AT)', async () => {
    // Within 5 minutes of expiry — must refresh proactively so health/runs don't
    // present a just-about-to-die access token that Linear already rejects.
    tokens.set('https://mcp.linear.app/mcp::__global__', {
      serverUrl: 'https://mcp.linear.app/mcp',
      accessToken: 'ALMOST_DEAD',
      refreshToken: 'RT',
      tokenType: 'Bearer',
      expiresAt: Date.now() + 60_000,
    })
    const tok = await resolveGlobalMcpToken('https://mcp.linear.app/mcp')
    expect(tok?.accessToken).toBe('FRESH')
    expect(refreshAccessToken).toHaveBeenCalledTimes(1)
  })

  it('single-flights concurrent refreshes so a rotated refresh token is only used once', async () => {
    // Linear rotates refresh tokens and invalidates the previous one. Two racing
    // health/listTools/run refreshes with the same RT would make the loser get
    // invalid_grant and look "disconnected". Callers must share one in-flight refresh.
    let releases!: () => void
    const gate = new Promise<void>((r) => { releases = r })
    let refreshCalls = 0
    refreshImpl = async (a) => {
      refreshCalls++
      await gate
      return {
        serverUrl: a.serverUrl,
        accessToken: `FRESH-${refreshCalls}`,
        refreshToken: 'RT-NEW',
        tokenType: 'Bearer',
        expiresAt: Date.now() + 3600_000,
      }
    }
    tokens.set('https://mcp.linear.app/mcp::__global__', {
      serverUrl: 'https://mcp.linear.app/mcp',
      accessToken: 'OLD',
      refreshToken: 'RT-OLD',
      tokenType: 'Bearer',
      expiresAt: Date.now() - 1,
    })

    const p1 = resolveGlobalMcpToken('https://mcp.linear.app/mcp')
    const p2 = resolveGlobalMcpToken('https://mcp.linear.app/mcp')
    // Wait until the shared refresh has entered the provider call.
    await vi.waitFor(() => expect(refreshCalls).toBe(1))
    releases()
    const [a, b] = await Promise.all([p1, p2])
    expect(a?.accessToken).toBe('FRESH-1')
    expect(b?.accessToken).toBe('FRESH-1')
    expect(refreshAccessToken).toHaveBeenCalledTimes(1)
    expect(tokens.get('https://mcp.linear.app/mcp::__global__')?.refreshToken).toBe('RT-NEW')
  })

  it('on refresh failure, returns a token another caller already persisted', async () => {
    refreshImpl = async () => {
      // Simulate the loser of a cross-pod race: our RT was already rotated by a
      // winner that saved the new pair. Fall through to a DB re-read.
      tokens.set('https://mcp.linear.app/mcp::__global__', {
        serverUrl: 'https://mcp.linear.app/mcp',
        accessToken: 'WINNER',
        refreshToken: 'RT-NEW',
        tokenType: 'Bearer',
        expiresAt: Date.now() + 3600_000,
      })
      throw new Error('Token request failed (400): {"error":"invalid_grant"}')
    }
    tokens.set('https://mcp.linear.app/mcp::__global__', {
      serverUrl: 'https://mcp.linear.app/mcp',
      accessToken: 'OLD',
      refreshToken: 'RT-OLD',
      tokenType: 'Bearer',
      expiresAt: Date.now() - 1,
    })
    const tok = await resolveGlobalMcpToken('https://mcp.linear.app/mcp')
    expect(tok?.accessToken).toBe('WINNER')
  })

  it('resolveMcpTokenForUrl falls back to the acting user when no global token exists', async () => {
    tokens.set('https://mcp.linear.app/mcp::user-1', {
      serverUrl: 'https://mcp.linear.app/mcp',
      accessToken: 'USERTOK',
      tokenType: 'Bearer',
      expiresAt: Date.now() + 1e6,
    })
    const tok = await resolveMcpTokenForUrl('https://mcp.linear.app/mcp', 'user-1')
    expect(tok?.accessToken).toBe('USERTOK')
  })

  it('resolveMcpTokenForUrl prefers the global token over the user token', async () => {
    tokens.set('https://mcp.linear.app/mcp::__global__', {
      serverUrl: 'https://mcp.linear.app/mcp',
      accessToken: 'GTOK',
      tokenType: 'Bearer',
      expiresAt: Date.now() + 1e6,
    })
    tokens.set('https://mcp.linear.app/mcp::user-1', {
      serverUrl: 'https://mcp.linear.app/mcp',
      accessToken: 'USERTOK',
      tokenType: 'Bearer',
      expiresAt: Date.now() + 1e6,
    })
    const tok = await resolveMcpTokenForUrl('https://mcp.linear.app/mcp', 'user-1')
    expect(tok?.accessToken).toBe('GTOK')
  })
})
