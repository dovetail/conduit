// src/server/mcpOAuth/discovery.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const clients = new Map<string, any>()
vi.mock('../../main/db/queries/mcpOAuthClients', () => ({
  getClient: vi.fn(async (u: string) => clients.get(u) ?? null),
  saveClient: vi.fn(async (c: any) => { clients.set(c.serverUrl, c) }),
}))

import { discoverOAuthEndpoints, ensureRegisteredClient, wellKnownCandidates } from './discovery'

describe('wellKnownCandidates', () => {
  it('inserts the well-known segment between host and path (RFC 8414) for path-scoped issuers', () => {
    // Regression: Datadog's AS issuer is https://mcp.us3.datadoghq.com/v1/mcp.
    // The naive appended form (…/v1/mcp/.well-known/…) 404s; the path-aware and
    // origin-rooted forms are what it actually serves.
    const c = wellKnownCandidates('https://mcp.us3.datadoghq.com/v1/mcp')
    expect(c).toContain('https://mcp.us3.datadoghq.com/.well-known/oauth-authorization-server/v1/mcp')
    expect(c).toContain('https://mcp.us3.datadoghq.com/.well-known/oauth-authorization-server')
    expect(c).not.toContain('https://mcp.us3.datadoghq.com/v1/mcp/.well-known/oauth-authorization-server')
  })

  it('includes OIDC path-appended and origin-rooted variants', () => {
    const c = wellKnownCandidates('https://host.example.com/v1/mcp')
    expect(c).toContain('https://host.example.com/v1/mcp/.well-known/openid-configuration')
    expect(c).toContain('https://host.example.com/.well-known/openid-configuration')
  })

  it('handles root-path issuers without a doubled slash', () => {
    const c = wellKnownCandidates('https://auth.example.com')
    expect(c).toContain('https://auth.example.com/.well-known/oauth-authorization-server')
    expect(c.every((u) => !u.includes('//.well-known'))).toBe(true)
  })

  it('returns nothing for an unparseable URL', () => {
    expect(wellKnownCandidates('not a url')).toEqual([])
  })
})

const meta = {
  authorization_endpoint: 'https://as.example.com/authorize',
  token_endpoint: 'https://as.example.com/token',
  registration_endpoint: 'https://as.example.com/register',
}

describe('discovery', () => {
  beforeEach(() => clients.clear())
  afterEach(() => vi.unstubAllGlobals())

  it('discovers from /.well-known/oauth-authorization-server', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) =>
      url.includes('oauth-authorization-server')
        ? { ok: true, json: async () => meta }
        : { ok: false }
    ))
    const m = await discoverOAuthEndpoints('https://mcp.example.com/')
    expect(m.token_endpoint).toBe(meta.token_endpoint)
  })

  it('registers a client via DCR and caches it', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: any) => {
      if (url.includes('.well-known')) return { ok: true, json: async () => meta } as any
      if (url === meta.registration_endpoint) {
        expect(JSON.parse(init.body).redirect_uris).toContain('http://localhost:7456/mcp/oauth/callback')
        return { ok: true, json: async () => ({ client_id: 'dcr-123' }) } as any
      }
      return { ok: false } as any
    }))
    const client = await ensureRegisteredClient('https://mcp.example.com', undefined, 'http://localhost:7456/mcp/oauth/callback')
    expect(client.clientId).toBe('dcr-123')
    // Cached — a second call must not hit the network again
    const again = await ensureRegisteredClient('https://mcp.example.com', undefined, 'http://localhost:7456/mcp/oauth/callback')
    expect(again.clientId).toBe('dcr-123')
    expect(vi.mocked(fetch).mock.calls.length).toBe(2)
  })

  it('falls back to a manual clientId when no registration_endpoint', async () => {
    const noReg = { authorization_endpoint: meta.authorization_endpoint, token_endpoint: meta.token_endpoint }
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => noReg }) as any))
    const client = await ensureRegisteredClient(
      'https://mcp2.example.com',
      { clientId: 'manual-1', authorizationUrl: '', tokenUrl: '', scopes: ['read'] },
      'http://localhost:7456/mcp/oauth/callback'
    )
    expect(client.clientId).toBe('manual-1')
  })

  it('captures the resource indicator from AS metadata', async () => {
    const withResource = { ...meta, resource: 'https://mcp.example.com/mcp' }
    vi.stubGlobal('fetch', vi.fn(async (url: string) =>
      url.includes('oauth-authorization-server')
        ? { ok: true, json: async () => withResource }
        : { ok: false }
    ))
    const m = await discoverOAuthEndpoints('https://mcp.example.com')
    expect(m.resource).toBe('https://mcp.example.com/mcp')
  })

  it('stores a resource on the registered client (falls back to the server URL)', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('.well-known')) return { ok: true, json: async () => meta } as any
      if (url === meta.registration_endpoint) return { ok: true, json: async () => ({ client_id: 'dcr-r' }) } as any
      return { ok: false } as any
    }))
    const client = await ensureRegisteredClient('https://mcp.example.com', undefined, 'http://localhost:7456/mcp/oauth/callback')
    expect(client.resource).toBe('https://mcp.example.com')
  })

  it('re-registers when the cached client was registered for a different redirect URI', async () => {
    clients.set('https://mcp.example.com', {
      serverUrl: 'https://mcp.example.com', clientId: 'old',
      authorizationEndpoint: meta.authorization_endpoint, tokenEndpoint: meta.token_endpoint,
      registrationData: JSON.stringify({ client_id: 'old', redirect_uris: ['https://origin-a.test/mcp/oauth/callback'] }),
      resource: 'https://mcp.example.com',
    })
    let registered = 0
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: any) => {
      if (url.includes('.well-known')) return { ok: true, json: async () => meta } as any
      if (url === meta.registration_endpoint) {
        registered++
        const b = JSON.parse(init.body)
        return { ok: true, json: async () => ({ client_id: 'new', redirect_uris: b.redirect_uris }) } as any
      }
      return { ok: false } as any
    }))
    const client = await ensureRegisteredClient('https://mcp.example.com', undefined, 'https://origin-b.test/mcp/oauth/callback')
    expect(registered).toBe(1)
    expect(client.clientId).toBe('new')
  })

  it('reuses the cached client when the current redirect URI is already registered', async () => {
    clients.set('https://mcp.example.com', {
      serverUrl: 'https://mcp.example.com', clientId: 'keep',
      authorizationEndpoint: meta.authorization_endpoint, tokenEndpoint: meta.token_endpoint,
      registrationData: JSON.stringify({ client_id: 'keep', redirect_uris: ['https://origin-a.test/mcp/oauth/callback'] }),
      resource: 'https://mcp.example.com',
    })
    const fetchSpy = vi.fn(async () => ({ ok: false }) as any)
    vi.stubGlobal('fetch', fetchSpy)
    const client = await ensureRegisteredClient('https://mcp.example.com', undefined, 'https://origin-a.test/mcp/oauth/callback')
    expect(client.clientId).toBe('keep')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('backfills a missing resource on a cached client without re-registering', async () => {
    clients.set('https://mcp.example.com', {
      serverUrl: 'https://mcp.example.com', clientId: 'keep',
      authorizationEndpoint: meta.authorization_endpoint, tokenEndpoint: meta.token_endpoint,
      registrationData: JSON.stringify({ client_id: 'keep', redirect_uris: ['https://origin-a.test/mcp/oauth/callback'] }),
      // no resource — simulates a row created before the resource column existed
    })
    let registered = 0
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('.well-known')) return { ok: true, json: async () => ({ ...meta, resource: 'https://mcp.example.com/mcp' }) } as any
      if (url === meta.registration_endpoint) { registered++; return { ok: true, json: async () => ({ client_id: 'x' }) } as any }
      return { ok: false } as any
    }))
    const client = await ensureRegisteredClient('https://mcp.example.com', undefined, 'https://origin-a.test/mcp/oauth/callback')
    expect(client.resource).toBe('https://mcp.example.com/mcp')
    expect(client.clientId).toBe('keep')
    expect(registered).toBe(0)
  })
})
