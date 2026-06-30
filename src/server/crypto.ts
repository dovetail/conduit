import * as crypto from 'crypto'

/**
 * Symmetric encryption for secrets stored at rest (currently GitHub App private
 * keys on repositories).
 *
 * Format: `iv:authTag:ciphertext`, each segment base64-encoded.
 * Cipher: AES-256-GCM with a random 12-byte IV per encryption.
 *
 * The key comes from the CONDUIT_SECRET_KEY env var, hex-encoded (64 chars →
 * 32 bytes). Generate one with `openssl rand -hex 32`. If the key is missing or
 * the wrong length we throw loudly rather than silently degrading — a repo using
 * GitHub App auth must not fall back to no auth.
 */

const ALGORITHM = 'aes-256-gcm'
const IV_BYTES = 12

function getKey(): Buffer {
  const hex = process.env.CONDUIT_SECRET_KEY
  if (!hex) {
    throw new Error(
      'CONDUIT_SECRET_KEY is not set. It is required to encrypt/decrypt repository ' +
        'GitHub App keys. Generate one with `openssl rand -hex 32`.'
    )
  }
  // Buffer.from(_, 'hex') silently truncates at the first invalid nibble rather
  // than throwing, so validate the format explicitly before decoding.
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(
      'CONDUIT_SECRET_KEY must be 64 hex characters (32 bytes). ' +
        'Generate one with `openssl rand -hex 32`.'
    )
  }
  return Buffer.from(hex, 'hex')
}

/** Encrypt a plaintext secret. Returns an `iv:authTag:ciphertext` base64 blob. */
export function encryptSecret(plaintext: string): string {
  const key = getKey()
  const iv = crypto.randomBytes(IV_BYTES)
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const authTag = cipher.getAuthTag()
  return [iv.toString('base64'), authTag.toString('base64'), ciphertext.toString('base64')].join(':')
}

/** Decrypt an `iv:authTag:ciphertext` blob produced by {@link encryptSecret}. */
export function decryptSecret(blob: string): string {
  const key = getKey()
  const parts = blob.split(':')
  if (parts.length !== 3) {
    throw new Error('Malformed encrypted secret: expected iv:authTag:ciphertext')
  }
  const [ivB64, tagB64, ctB64] = parts
  const iv = Buffer.from(ivB64, 'base64')
  const authTag = Buffer.from(tagB64, 'base64')
  const ciphertext = Buffer.from(ctB64, 'base64')
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv)
  decipher.setAuthTag(authTag)
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()])
  return plaintext.toString('utf8')
}
