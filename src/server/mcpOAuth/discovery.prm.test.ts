// src/server/mcpOAuth/discovery.prm.test.ts
// Tests for the protected-resource-metadata (RFC 9728 / MCP auth) discovery path.
// Does NOT disturb the existing discovery.test.ts.
import { describe, it, expect, vi, afterEach } from 'vitest'

vi.mock('../../main/db/queries/mcpOAuthClients', () => ({
  getClient: vi.fn(async () => null),
  saveClient: vi.fn(async () => undefined),
}))

import { discoverOAuthEndpoints } from './discovery'

afterEach(() => vi.unstubAllGlobals())

/** Build a minimal mock Response object for fetch. */
function mockResponse(opts: {
  ok: boolean
  status?: number
  json?: () => Promise<unknown>
  wwwAuthenticate?: string | null
}): Response {
  return {
    ok: opts.ok,
    status: opts.status ?? (opts.ok ? 200 : 404),
    json: opts.json ?? (async () => ({})),
    headers: {
      get(name: string) {
        if (name.toLowerCase() === 'www-authenticate') return opts.wwwAuthenticate ?? null
        return null
      },
    },
  } as unknown as Response
}

describe('discoverOAuthEndpoints — protected-resource-metadata path', () => {
  it('resolves via WWW-Authenticate resource_metadata URL', async () => {
    const asMetadata = {
      authorization_endpoint: 'https://as.example.com/authorize',
      token_endpoint: 'https://as.example.com/token',
      registration_endpoint: 'https://as.example.com/register',
    }
    const prmDoc = { authorization_servers: ['https://as.example.com'] }

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        // base well-known paths both fail
        if (url === 'https://rs.example.com/.well-known/oauth-authorization-server')
          return mockResponse({ ok: false })
        if (url === 'https://rs.example.com/.well-known/openid-configuration')
          return mockResponse({ ok: false })
        // resource fetch returns 401 with resource_metadata header
        if (url === 'https://rs.example.com/mcp')
          return mockResponse({
            ok: false,
            status: 401,
            wwwAuthenticate:
              'Bearer resource_metadata="https://rs.example.com/.well-known/oauth-protected-resource"',
          })
        // PRM document
        if (url === 'https://rs.example.com/.well-known/oauth-protected-resource')
          return mockResponse({ ok: true, json: async () => prmDoc })
        // AS metadata
        if (url === 'https://as.example.com/.well-known/oauth-authorization-server')
          return mockResponse({ ok: true, json: async () => asMetadata })
        return mockResponse({ ok: false })
      })
    )

    const meta = await discoverOAuthEndpoints('https://rs.example.com/mcp')
    expect(meta.authorization_endpoint).toBe('https://as.example.com/authorize')
    expect(meta.token_endpoint).toBe('https://as.example.com/token')
    expect(meta.registration_endpoint).toBe('https://as.example.com/register')
  })

  it('falls back to <base>/.well-known/oauth-protected-resource when no resource_metadata header', async () => {
    const asMetadata = {
      authorization_endpoint: 'https://as2.example.com/authorize',
      token_endpoint: 'https://as2.example.com/token',
    }
    const prmDoc = { authorization_servers: ['https://as2.example.com'] }

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        // base well-known paths fail
        if (url === 'https://rs2.example.com/.well-known/oauth-authorization-server')
          return mockResponse({ ok: false })
        if (url === 'https://rs2.example.com/.well-known/openid-configuration')
          return mockResponse({ ok: false })
        // resource fetch returns 401 but NO resource_metadata in header
        if (url === 'https://rs2.example.com/mcp')
          return mockResponse({ ok: false, status: 401, wwwAuthenticate: null })
        // fallback PRM path
        if (url === 'https://rs2.example.com/.well-known/oauth-protected-resource')
          return mockResponse({ ok: true, json: async () => prmDoc })
        // AS metadata
        if (url === 'https://as2.example.com/.well-known/oauth-authorization-server')
          return mockResponse({ ok: true, json: async () => asMetadata })
        return mockResponse({ ok: false })
      })
    )

    const meta = await discoverOAuthEndpoints('https://rs2.example.com/mcp')
    expect(meta.authorization_endpoint).toBe('https://as2.example.com/authorize')
    expect(meta.token_endpoint).toBe('https://as2.example.com/token')
  })

  it('rejects when all paths fail', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => mockResponse({ ok: false, status: 404 })))

    await expect(discoverOAuthEndpoints('https://unknown.example.com/mcp')).rejects.toThrow()
  })

  it('resolves from base /.well-known/oauth-authorization-server WITHOUT touching PRM path', async () => {
    const asMetadata = {
      authorization_endpoint: 'https://direct.example.com/authorize',
      token_endpoint: 'https://direct.example.com/token',
    }

    const fetchMock = vi.fn(async (url: string) => {
      if (url === 'https://direct.example.com/.well-known/oauth-authorization-server')
        return mockResponse({ ok: true, json: async () => asMetadata })
      return mockResponse({ ok: false })
    })
    vi.stubGlobal('fetch', fetchMock)

    const meta = await discoverOAuthEndpoints('https://direct.example.com')
    expect(meta.authorization_endpoint).toBe('https://direct.example.com/authorize')
    // PRM resource fetch must NOT have been called
    const prmCalls = fetchMock.mock.calls.filter(([u]) =>
      u === 'https://direct.example.com' ||
      u.includes('oauth-protected-resource')
    )
    expect(prmCalls).toHaveLength(0)
  })
})
