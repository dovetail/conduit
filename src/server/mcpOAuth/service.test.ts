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
  ensureRegisteredClient: vi.fn(async (url: string) => ({ serverUrl: url, clientId: 'cid', authorizationEndpoint: 'https://as/a', tokenEndpoint: 'https://as/t' })),
}))
vi.mock('../../main/db/queries/oauthTokens', () => ({
  getTokenStatus: vi.fn(async () => ({ connected: true, scope: 'global', connectedByUserId: 'u1', connectedByName: 'Ada' })),
  saveToken: vi.fn(async () => {}),
  deleteToken: vi.fn(async () => {}),
  getConnectedByUserId: vi.fn(async () => 'u1'),
}))
vi.mock('./flow', async (orig) => ({ ...(await orig() as any), exchangeCode: vi.fn(async () => ({ serverUrl: 'https://mcp.linear.app', accessToken: 'AT', tokenType: 'Bearer' })) }))

import { startAuth, getStatus, resolveServerTarget } from './service'
import { putPending } from './state'

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

  it('getStatus returns redacted status', async () => {
    const s = await getStatus('g1', true, 'u1')
    expect(s.connected).toBe(true)
    expect((s as any).accessToken).toBeUndefined()
  })
})
