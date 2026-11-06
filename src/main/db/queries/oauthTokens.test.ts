// src/main/db/queries/oauthTokens.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const rows: any[] = []
let lastConflictUpdateSet: Record<string, unknown> | null = null

vi.mock('../index', () => ({
  getDb: () => ({
    select: () => ({ from: () => ({ where: (w: any) =>
      Promise.resolve(rows.filter((r) => r.serverUrl === w.a && r.tokenOwner === w.b)) }) }),
    insert: () => ({ values: (v: any) => ({ onConflictDoUpdate: (opts: { set: Record<string, unknown> }) => {
      lastConflictUpdateSet = opts.set
      const i = rows.findIndex((r) => r.serverUrl === v.serverUrl && r.tokenOwner === v.tokenOwner)
      if (i >= 0) rows[i] = v; else rows.push(v); return Promise.resolve() } }) }),
    delete: () => ({ where: () => Promise.resolve() }),
  }),
}))
vi.mock('../schema', () => ({ oauthTokens: { serverUrl: 'server_url', tokenOwner: 'token_owner' } }))
vi.mock('drizzle-orm', () => ({ eq: () => ({}), and: () => ({ a: '__a', b: '__b' }) }))
vi.mock('../../../server/crypto', () => ({
  encryptSecret: (s: string) => `enc:${s}`,
  decryptSecret: (s: string) => s.replace(/^enc:/, ''),
}))
vi.mock('./users', () => ({ getUser: vi.fn(async (id: string) => ({ id, name: 'Ada', email: 'ada@x' })) }))

// NOTE: the `and()` mock returns fixed keys so the fake matches on serverUrl/tokenOwner.
import { saveToken, getToken } from './oauthTokens'

const baseToken = { serverUrl: 'https://m', accessToken: 'AT', refreshToken: 'RT', tokenType: 'Bearer', expiresAt: 123 }

describe('oauthTokens', () => {
  beforeEach(() => { rows.length = 0; lastConflictUpdateSet = null })

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

  it('includes connectedByUserId in onConflictDoUpdate set when provided', async () => {
    await saveToken(baseToken, 'owner-a', 'user-1')
    expect(lastConflictUpdateSet).not.toBeNull()
    expect(lastConflictUpdateSet).toHaveProperty('connectedByUserId', 'user-1')
  })

  it('omits connectedByUserId from onConflictDoUpdate set when null (token refresh)', async () => {
    await saveToken(baseToken, 'owner-a', null)
    expect(lastConflictUpdateSet).not.toBeNull()
    expect(lastConflictUpdateSet).not.toHaveProperty('connectedByUserId')
  })

  it('omits refreshToken from onConflictDoUpdate set when absent (reconnect must not wipe RT)', async () => {
    // handleCallback → exchangeCode sometimes returns only an access token. Writing
    // refreshToken: null on conflict would destroy a previously stored RT and leave
    // Linear permanently unrefreshable until the next full grant that includes one.
    await saveToken(
      { serverUrl: 'https://m', accessToken: 'AT2', tokenType: 'Bearer', expiresAt: 999 },
      'owner-a',
      'user-1'
    )
    expect(lastConflictUpdateSet).not.toBeNull()
    expect(lastConflictUpdateSet).not.toHaveProperty('refreshToken')
    expect(lastConflictUpdateSet).toHaveProperty('accessToken', 'enc:AT2')
  })

  it('includes refreshToken in onConflictDoUpdate set when a new RT is provided', async () => {
    await saveToken(
      { serverUrl: 'https://m', accessToken: 'AT2', refreshToken: 'RT-NEW', tokenType: 'Bearer', expiresAt: 999 },
      'owner-a',
      null
    )
    expect(lastConflictUpdateSet).toHaveProperty('refreshToken', 'enc:RT-NEW')
  })

  it('normalizes a lowercase "bearer" token_type to "Bearer" on read (fixes tools/list 401)', async () => {
    // Row persisted with a lowercase scheme (as Linear returns) — the fake matcher
    // keys on serverUrl='__a', tokenOwner='__b'.
    rows.push({ serverUrl: '__a', tokenOwner: '__b', accessToken: 'enc:AT', refreshToken: null, expiresAt: 1, tokenType: 'bearer', scope: null, connectedByUserId: null })
    const t = await getToken('https://m', 'owner')
    expect(t?.tokenType).toBe('Bearer')
    expect(t?.accessToken).toBe('AT')
  })
})
