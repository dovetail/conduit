import { describe, it, expect, vi, beforeEach } from 'vitest'

const store = new Map<string, any>()
vi.mock('../index', () => ({
  getDb: () => ({
    select: () => ({ from: () => ({ where: (w: any) => Promise.resolve(
      [...store.values()].filter((r) => r.serverUrl === w._value)
    ) }) }),
    insert: () => ({ values: (v: any) => ({ onConflictDoUpdate: () => { store.set(v.serverUrl, v); return Promise.resolve() } }) }),
    delete: () => ({ where: (w: any) => { store.delete(w._value); return Promise.resolve() } }),
  }),
}))
vi.mock('../schema', () => ({ mcpOAuthClients: { serverUrl: { _value: undefined } } }))
vi.mock('drizzle-orm', () => ({ eq: (_col: any, v: any) => ({ _value: v }) }))
vi.mock('../../../server/crypto', () => ({
  encryptSecret: (s: string) => `enc(${s})`,
  decryptSecret: (s: string) => s.replace(/^enc\(|\)$/g, ''),
}))

import { getClient, saveClient } from './mcpOAuthClients'

describe('mcpOAuthClients', () => {
  beforeEach(() => store.clear())

  it('round-trips a client, encrypting the secret', async () => {
    await saveClient({
      serverUrl: 'https://mcp.example.com',
      clientId: 'abc',
      clientSecret: 'shh',
      authorizationEndpoint: 'https://a/authorize',
      tokenEndpoint: 'https://a/token',
    })
    const stored = store.get('https://mcp.example.com')
    expect(stored.clientSecretEnc).toBe('enc(shh)')
    const got = await getClient('https://mcp.example.com')
    expect(got?.clientId).toBe('abc')
    expect(got?.clientSecret).toBe('shh')
  })

  it('returns null for unknown server', async () => {
    expect(await getClient('https://nope')).toBeNull()
  })
})
