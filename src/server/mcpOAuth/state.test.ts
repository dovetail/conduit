import { describe, it, expect } from 'vitest'
import { putPending, takePending } from './state'

const base = {
  codeVerifier: 'v', serverUrl: 'https://m', tokenOwner: 'u1', connectedByUserId: 'u1',
  clientId: 'c', redirectUri: 'http://localhost:7456/mcp/oauth/callback', tokenEndpoint: 'https://as/token',
}

describe('state', () => {
  it('stores and takes a pending entry once', () => {
    putPending('s1', { ...base, createdAt: Date.now() })
    expect(takePending('s1')?.serverUrl).toBe('https://m')
    expect(takePending('s1')).toBeNull() // consumed
  })

  it('rejects expired entries', () => {
    putPending('s2', { ...base, createdAt: Date.now() - 10 * 60 * 1000 - 1 })
    expect(takePending('s2')).toBeNull()
  })

  it('returns null for unknown state', () => {
    expect(takePending('nope')).toBeNull()
  })
})
