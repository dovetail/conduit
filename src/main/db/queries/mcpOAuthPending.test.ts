import { describe, it, expect, beforeEach, vi } from 'vitest'

// In-memory fake for the Postgres-backed pending store.
const rows = new Map<string, { state: string; dataEnc: string; createdAt: number }>()

vi.mock('../index', () => ({
  getDb: () => ({
    insert: () => ({
      values: (v: any) => ({
        onConflictDoUpdate: () => {
          rows.set(v.state, v)
          return Promise.resolve()
        },
      }),
    }),
    delete: () => ({
      where: (cond: any) => ({
        returning: () => {
          if (cond.__eq !== undefined) {
            const row = rows.get(cond.__eq)
            if (!row) return Promise.resolve([])
            rows.delete(cond.__eq)
            return Promise.resolve([row])
          }
          // lt(createdAt, cutoff) — expiry sweep
          const expired = [...rows.values()].filter((r) => r.createdAt < cond.__lt)
          expired.forEach((r) => rows.delete(r.state))
          return Promise.resolve(expired.map((r) => ({ state: r.state })))
        },
      }),
    }),
  }),
}))
vi.mock('../schema', () => ({ mcpOAuthPending: { state: 'state', createdAt: 'created_at' } }))
vi.mock('drizzle-orm', () => ({
  eq: (_col: unknown, val: unknown) => ({ __eq: val }),
  lt: (_col: unknown, val: unknown) => ({ __lt: val }),
}))
vi.mock('../../../server/crypto', () => ({
  encryptSecret: (s: string) => `enc:${s}`,
  decryptSecret: (s: string) => s.replace(/^enc:/, ''),
}))

import {
  putPendingAuth,
  takePendingAuth,
  deleteExpiredPendingAuth,
  PENDING_TTL_MS,
} from './mcpOAuthPending'

const base = {
  codeVerifier: 'v',
  serverUrl: 'https://mcp.example.com',
  tokenOwner: 'u1',
  connectedByUserId: 'u1',
  clientId: 'c',
  redirectUri: 'https://conduit.example.com/mcp/oauth/callback',
  tokenEndpoint: 'https://as/token',
}

describe('mcpOAuthPending', () => {
  beforeEach(() => rows.clear())

  it('encrypts the payload at rest and round-trips it on take', async () => {
    await putPendingAuth('s1', { ...base, createdAt: Date.now() })
    expect(rows.get('s1')!.dataEnc.startsWith('enc:')).toBe(true) // stored encrypted
    const taken = await takePendingAuth('s1')
    expect(taken?.serverUrl).toBe('https://mcp.example.com')
    expect(taken?.codeVerifier).toBe('v')
  })

  it('consumes the state exactly once (no replay)', async () => {
    await putPendingAuth('s2', { ...base, createdAt: Date.now() })
    expect(await takePendingAuth('s2')).not.toBeNull()
    expect(await takePendingAuth('s2')).toBeNull()
  })

  it('rejects expired entries', async () => {
    await putPendingAuth('s3', { ...base, createdAt: Date.now() - PENDING_TTL_MS - 1 })
    expect(await takePendingAuth('s3')).toBeNull()
  })

  it('returns null for unknown state', async () => {
    expect(await takePendingAuth('nope')).toBeNull()
  })

  it('sweeps expired rows but keeps fresh ones', async () => {
    await putPendingAuth('old', { ...base, createdAt: Date.now() - PENDING_TTL_MS - 1 })
    await putPendingAuth('fresh', { ...base, createdAt: Date.now() })
    const removed = await deleteExpiredPendingAuth()
    expect(removed).toBe(1)
    expect(await takePendingAuth('fresh')).not.toBeNull()
  })
})
