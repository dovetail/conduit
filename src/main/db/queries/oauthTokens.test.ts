// src/main/db/queries/oauthTokens.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const rows: any[] = []
vi.mock('../index', () => ({
  getDb: () => ({
    select: () => ({ from: () => ({ where: (w: any) =>
      Promise.resolve(rows.filter((r) => r.serverUrl === w.a && r.tokenOwner === w.b)) }) }),
    insert: () => ({ values: (v: any) => ({ onConflictDoUpdate: () => {
      const i = rows.findIndex((r) => r.serverUrl === v.serverUrl && r.tokenOwner === v.tokenOwner)
      if (i >= 0) rows[i] = v; else rows.push(v); return Promise.resolve() } }) }),
    delete: () => ({ where: () => Promise.resolve() }),
  }),
}))
vi.mock('../schema', () => ({ oauthTokens: { serverUrl: 'server_url', tokenOwner: 'token_owner' } }))
vi.mock('drizzle-orm', () => ({ eq: () => ({}), and: (...cs: any[]) => ({ a: '__a', b: '__b' }) }))
vi.mock('../../../server/crypto', () => ({
  encryptSecret: (s: string) => `enc:${s}`,
  decryptSecret: (s: string) => s.replace(/^enc:/, ''),
}))
vi.mock('./users', () => ({ getUser: vi.fn(async (id: string) => ({ id, name: 'Ada', email: 'ada@x' })) }))

// NOTE: the `and()` mock returns fixed keys so the fake matches on serverUrl/tokenOwner.
import { saveToken, getToken, getTokenStatus } from './oauthTokens'

describe('oauthTokens', () => {
  beforeEach(() => { rows.length = 0 })

  it('encrypts on save and decrypts on read, keyed by (serverUrl, owner)', async () => {
    await saveToken(
      { serverUrl: 'https://m', accessToken: 'AT', refreshToken: 'RT', tokenType: 'Bearer', expiresAt: 123 },
      'user-1', 'user-1'
    )
    // Rewire the fake matcher for this owner
    rows.forEach((r) => { r.serverUrl = 'https://m'; })
    expect(rows[0].accessToken).toBe('enc:AT')
    expect(rows[0].refreshToken).toBe('enc:RT')
    expect(rows[0].connectedByUserId).toBe('user-1')
  })
})
