// src/server/mcpOAuth/service.probe.test.ts
import { describe, it, expect, vi, afterEach } from 'vitest'

vi.mock('./discovery', () => ({
  discoverOAuthEndpoints: vi.fn(),
}))

import { probeOAuthSupport } from './service'
import { discoverOAuthEndpoints } from './discovery'

afterEach(() => {
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

describe('probeOAuthSupport', () => {
  it('url-type + discovery returns registration_endpoint -> supportsOAuth:true, supportsDcr:true', async () => {
    vi.mocked(discoverOAuthEndpoints).mockResolvedValueOnce({
      authorization_endpoint: 'https://as/authorize',
      token_endpoint: 'https://as/token',
      registration_endpoint: 'https://as/register',
    })
    const result = await probeOAuthSupport({ type: 'url', url: 'https://mcp.example.com' })
    expect(result).toEqual({ supportsOAuth: true, supportsDcr: true })
    expect(discoverOAuthEndpoints).toHaveBeenCalledWith('https://mcp.example.com')
  })

  it('url-type + discovery returns NO registration_endpoint -> supportsOAuth:true, supportsDcr:false', async () => {
    vi.mocked(discoverOAuthEndpoints).mockResolvedValueOnce({
      authorization_endpoint: 'https://as/authorize',
      token_endpoint: 'https://as/token',
    })
    const result = await probeOAuthSupport({ type: 'url', url: 'https://mcp.example.com' })
    expect(result).toEqual({ supportsOAuth: true, supportsDcr: false })
  })

  it('discovery throws -> supportsOAuth:false, supportsDcr:false', async () => {
    vi.mocked(discoverOAuthEndpoints).mockRejectedValueOnce(new Error('Network error'))
    vi.stubGlobal('fetch', vi.fn(async () => ({ status: 500, ok: false })))
    const result = await probeOAuthSupport({ type: 'url', url: 'https://mcp.example.com' })
    expect(result).toEqual({ supportsOAuth: false, supportsDcr: false })
  })

  it('stdio config (type: stdio) -> supportsOAuth:false, supportsDcr:false (no discovery call)', async () => {
    const result = await probeOAuthSupport({ type: 'stdio', command: 'npx', args: ['some-mcp'] })
    expect(result).toEqual({ supportsOAuth: false, supportsDcr: false })
    expect(discoverOAuthEndpoints).not.toHaveBeenCalled()
  })

  it('no url -> supportsOAuth:false, supportsDcr:false (no discovery call)', async () => {
    const result = await probeOAuthSupport({ command: 'npx' })
    expect(result).toEqual({ supportsOAuth: false, supportsDcr: false })
    expect(discoverOAuthEndpoints).not.toHaveBeenCalled()
  })

  it('discovery throws AND fetch returns 401 -> supportsOAuth:true, supportsDcr:false', async () => {
    vi.mocked(discoverOAuthEndpoints).mockRejectedValueOnce(new Error('Not found'))
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 401,
        headers: { get: () => null },
      }))
    )
    const result = await probeOAuthSupport({ type: 'url', url: 'https://mcp.example.com' })
    expect(result).toEqual({ supportsOAuth: true, supportsDcr: false })
  })

  it('discovery throws AND fetch returns 403 -> supportsOAuth:true, supportsDcr:false', async () => {
    vi.mocked(discoverOAuthEndpoints).mockRejectedValueOnce(new Error('Not found'))
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 403,
        headers: { get: () => null },
      }))
    )
    const result = await probeOAuthSupport({ type: 'url', url: 'https://mcp.example.com' })
    expect(result).toEqual({ supportsOAuth: true, supportsDcr: false })
  })

  it('discovery throws AND fetch returns 200 -> supportsOAuth:false, supportsDcr:false', async () => {
    vi.mocked(discoverOAuthEndpoints).mockRejectedValueOnce(new Error('Not found'))
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        headers: { get: () => null },
      }))
    )
    const result = await probeOAuthSupport({ type: 'url', url: 'https://mcp.example.com' })
    expect(result).toEqual({ supportsOAuth: false, supportsDcr: false })
  })

  it('discovery throws AND fetch throws network error -> supportsOAuth:false, supportsDcr:false', async () => {
    vi.mocked(discoverOAuthEndpoints).mockRejectedValueOnce(new Error('Not found'))
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => { throw new Error('Network error') })
    )
    const result = await probeOAuthSupport({ type: 'url', url: 'https://mcp.example.com' })
    expect(result).toEqual({ supportsOAuth: false, supportsDcr: false })
  })
})
