// src/server/localSecret.ts
import * as fs from 'fs'
import * as path from 'path'
import * as crypto from 'crypto'

/**
 * For LOCAL (non-production) runs only: ensure CONDUIT_SECRET_KEY is available
 * by reading/generating a gitignored `.conduit.key` dotfile at the repo root.
 *
 * - No-op if CONDUIT_SECRET_KEY is already set (production always sets it).
 * - No-op in production (NODE_ENV === 'production') so a misconfigured deploy
 *   never silently generates an ephemeral key that would make previously
 *   encrypted data undecryptable.
 */
export function ensureLocalSecretKey(opts: {
  keyPath?: string
  env?: NodeJS.ProcessEnv
  nodeEnv?: string
} = {}): void {
  const env = opts.env ?? process.env
  const nodeEnv = opts.nodeEnv ?? process.env.NODE_ENV
  const keyPath = opts.keyPath ?? path.join(process.cwd(), '.conduit.key')

  if (env.CONDUIT_SECRET_KEY) return
  if (nodeEnv === 'production') return

  let key: string
  if (fs.existsSync(keyPath)) {
    key = fs.readFileSync(keyPath, 'utf8').trim()
  } else {
    key = crypto.randomBytes(32).toString('hex')
    fs.writeFileSync(keyPath, key, { mode: 0o600 })
    console.log(`[conduit] Generated local encryption key at ${keyPath}`)
  }
  env.CONDUIT_SECRET_KEY = key
}
