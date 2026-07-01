import { describe, it, expect, vi, beforeEach } from 'vitest'

const tokens = new Map<string, any>() // key `${url}::${owner}`
vi.mock('../db/queries/oauthTokens', () => ({
  getToken: vi.fn(async (url: string, owner: string) => tokens.get(`${url}::${owner}`) ?? null),
  saveToken: vi.fn(async (t: any, owner: string) => tokens.set(`${t.serverUrl}::${owner}`, t)),
}))
vi.mock('../db/queries/mcpOAuthClients', () => ({
  getClient: vi.fn(async (url: string) => ({ serverUrl: url, clientId: 'c', tokenEndpoint: 'https://as/token', authorizationEndpoint: 'https://as/a' })),
}))
vi.mock('../../server/mcpOAuth/flow', () => ({
  refreshAccessToken: vi.fn(async (a: any) => ({ serverUrl: a.serverUrl, accessToken: 'FRESH', refreshToken: a.refreshToken, tokenType: 'Bearer', expiresAt: Date.now() + 3600_000 })),
}))
vi.mock('../db/queries/globalMcps', () => ({ listEnabledGlobalMcps: vi.fn(async () => []) }))

import { injectOAuthTokens } from './mcp'

describe('injectOAuthTokens', () => {
  beforeEach(() => tokens.clear())

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

  it('skips an expired token with no refresh token', async () => {
    tokens.set('https://a::user-1', { serverUrl: 'https://a', accessToken: 'OLD', tokenType: 'Bearer', expiresAt: Date.now() - 1 })
    const config = { mcpServers: { aserver: { type: 'url' as const, url: 'https://a' } } }
    const out = await injectOAuthTokens(config, 'user-1', new Set())
    expect(out.mcpServers.aserver.headers?.Authorization).toBeUndefined()
  })
})
