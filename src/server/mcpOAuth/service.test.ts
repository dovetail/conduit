// src/server/mcpOAuth/service.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../../main/db/queries/globalMcps', () => ({
  getGlobalMcp: vi.fn(async (id: string) => id === 'g1'
    ? { id: 'g1', serverKey: 'linear', serverConfig: { type: 'url', url: 'https://mcp.linear.app', oauth: { clientId: '', authorizationUrl: '', tokenUrl: '', scopes: ['read'] } } }
    : null),
}))
vi.mock('../../main/db/queries/agents', () => ({
  getAgent: vi.fn(async () => ({ id: 'a1', ownerId: 'u1', mcpConfig: { mcpServers: { foo: { type: 'url', url: 'https://foo', oauth: { clientId: 'x', authorizationUrl: '', tokenUrl: '', scopes: [] } } } } })),
}))
vi.mock('../../main/db/queries/access', () => ({
  canAccessEntity: vi.fn(async () => true),
  isEntityOwner: vi.fn(async () => true),
}))
vi.mock('./discovery', () => ({
  ensureRegisteredClient: vi.fn(async (url: string) => ({ serverUrl: url, clientId: 'cid', authorizationEndpoint: 'https://as/a', tokenEndpoint: 'https://as/t', resource: 'https://mcp.linear.app/mcp' })),
}))
vi.mock('../../main/db/queries/oauthTokens', () => ({
  getTokenStatus: vi.fn(async () => ({ connected: true, scope: 'global', connectedByUserId: 'u1', connectedByName: 'Ada' })),
  saveToken: vi.fn(async () => {}),
  deleteToken: vi.fn(async () => {}),
  getConnectedByUserId: vi.fn(async () => 'u1'),
}))
vi.mock('./flow', async (orig) => ({ ...(await orig() as any), exchangeCode: vi.fn(async () => ({ serverUrl: 'https://mcp.linear.app', accessToken: 'AT', tokenType: 'Bearer' })) }))
// Pending state is Postgres-backed; stub it so unit tests don't need a DB.
vi.mock('./state', () => ({ putPending: vi.fn(async () => {}), takePending: vi.fn(async () => null) }))

import { startAuth, getStatus, resolveServerTarget, revoke, getRedirectUri } from './service'
import { canAccessEntity, isEntityOwner } from '../../main/db/queries/access'
import { getConnectedByUserId } from '../../main/db/queries/oauthTokens'

describe('service', () => {
  beforeEach(() => { process.env.CONDUIT_BASE_URL = 'http://localhost:7456' })
  afterEach(() => vi.clearAllMocks())

  it('resolves a global target to __global__ owner', async () => {
    const t = await resolveServerTarget('g1', true, 'u1')
    expect(t.serverUrl).toBe('https://mcp.linear.app')
    expect(t.tokenOwner).toBe('__global__')
    expect(t.scope).toBe('global')
  })

  it('resolves an agent target to the acting user', async () => {
    const t = await resolveServerTarget('a1:foo', false, 'u1')
    expect(t.serverUrl).toBe('https://foo')
    expect(t.tokenOwner).toBe('u1')
  })

  it('startAuth returns an authorization URL and stores pending state', async () => {
    const { authUrl } = await startAuth('g1', true, 'u1')
    const u = new URL(authUrl)
    expect(u.searchParams.get('client_id')).toBe('cid')
    expect(u.searchParams.get('code_challenge_method')).toBe('S256')
  })

  it('startAuth includes the resource indicator from the registered client', async () => {
    const { authUrl } = await startAuth('g1', true, 'u1')
    expect(new URL(authUrl).searchParams.get('resource')).toBe('https://mcp.linear.app/mcp')
  })

  it('getRedirectUri prefers CONDUIT_BASE_URL over the browser origin (stable value for DCR)', () => {
    process.env.CONDUIT_BASE_URL = 'https://conduit.example.com'
    expect(getRedirectUri('https://some-other-origin.test')).toBe('https://conduit.example.com/mcp/oauth/callback')
  })

  it('getRedirectUri strips a trailing slash on CONDUIT_BASE_URL', () => {
    process.env.CONDUIT_BASE_URL = 'https://conduit.example.com/'
    expect(getRedirectUri()).toBe('https://conduit.example.com/mcp/oauth/callback')
  })

  it('getRedirectUri falls back to the browser origin when CONDUIT_BASE_URL is unset', () => {
    delete process.env.CONDUIT_BASE_URL
    expect(getRedirectUri('https://console.host')).toBe('https://console.host/mcp/oauth/callback')
  })

  it('getStatus returns redacted status', async () => {
    const s = await getStatus('g1', true, 'u1')
    expect(s.connected).toBe(true)
    expect((s as any).accessToken).toBeUndefined()
  })

  it('startAuth rejects when canAccessEntity returns false', async () => {
    vi.mocked(canAccessEntity).mockResolvedValueOnce(false)
    await expect(startAuth('g1', true, 'u1')).rejects.toThrow('Access denied')
  })

  it('revoke of a global server rejects when user is neither owner nor connector', async () => {
    // canAccessEntity still returns true (access is granted); only the owner/connector check fails
    vi.mocked(isEntityOwner).mockResolvedValueOnce(false)
    vi.mocked(getConnectedByUserId).mockResolvedValueOnce('other-user')
    await expect(revoke('g1', true, 'someone-else')).rejects.toThrow('Only the owner or the connecting user can revoke this token')
  })

  it('revoke of a global server succeeds when user is the owner', async () => {
    vi.mocked(isEntityOwner).mockResolvedValueOnce(true)
    await expect(revoke('g1', true, 'u1')).resolves.toBeUndefined()
  })
})
