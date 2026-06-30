import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { encryptSecret, decryptSecret } from './crypto'

// A valid 32-byte key, hex-encoded (64 chars).
const VALID_KEY = 'a'.repeat(64)

describe('crypto', () => {
  const original = process.env.CONDUIT_SECRET_KEY
  beforeEach(() => {
    process.env.CONDUIT_SECRET_KEY = VALID_KEY
  })
  afterEach(() => {
    if (original === undefined) delete process.env.CONDUIT_SECRET_KEY
    else process.env.CONDUIT_SECRET_KEY = original
  })

  it('round-trips a secret', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----\n'
    const blob = encryptSecret(pem)
    expect(blob).not.toContain(pem)
    expect(decryptSecret(blob)).toBe(pem)
  })

  it('produces a different ciphertext each time (random IV)', () => {
    const a = encryptSecret('same plaintext')
    const b = encryptSecret('same plaintext')
    expect(a).not.toBe(b)
    expect(decryptSecret(a)).toBe('same plaintext')
    expect(decryptSecret(b)).toBe('same plaintext')
  })

  it('rejects a tampered ciphertext (auth tag mismatch)', () => {
    const blob = encryptSecret('secret')
    const parts = blob.split(':')
    // Flip a byte in the ciphertext segment.
    const ct = Buffer.from(parts[2], 'base64')
    ct[0] = ct[0] ^ 0xff
    parts[2] = ct.toString('base64')
    expect(() => decryptSecret(parts.join(':'))).toThrow()
  })

  it('throws a clear error when the key is missing', () => {
    delete process.env.CONDUIT_SECRET_KEY
    expect(() => encryptSecret('x')).toThrow(/CONDUIT_SECRET_KEY/)
  })

  it('throws when the key is the wrong length', () => {
    process.env.CONDUIT_SECRET_KEY = 'abcd'
    expect(() => encryptSecret('x')).toThrow(/32 bytes/)
  })

  it('throws on a 64-char key containing a non-hex character (not silent truncation)', () => {
    // 'z' is invalid hex; Buffer.from would silently truncate, so we must reject up front.
    process.env.CONDUIT_SECRET_KEY = 'z'.repeat(64)
    expect(() => encryptSecret('x')).toThrow(/hex/)
  })
})
