// src/server/mcpOAuth/service.probe.test.ts
import { describe, it, expect, vi, afterEach } from 'vitest'

vi.mock('./discovery', () => ({
  discoverOAuthEndpoints: vi.fn(),
}))

import { probeOAuthSupport } from './service'
import { discoverOAuthEndpoints } from './discovery'

afterEach(() => vi.clearAllMocks())

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
})
