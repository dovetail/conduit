import * as crypto from 'crypto'

/** OpenSSH-style `SHA256:<base64>` fingerprint of a public key line (`type base64 [comment]`). */
export function sshKeyFingerprint(publicKey: string): string {
  const b64 = publicKey.trim().split(/\s+/)[1]
  if (!b64) throw new Error('Invalid SSH public key.')
  const digest = crypto.createHash('sha256').update(Buffer.from(b64, 'base64')).digest('base64')
  return `SHA256:${digest.replace(/=+$/, '')}`
}
