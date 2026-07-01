// src/server/localSecret.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { ensureLocalSecretKey } from './localSecret'

describe('ensureLocalSecretKey', () => {
  let dir: string
  let keyPath: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conduit-key-'))
    keyPath = path.join(dir, '.conduit.key')
  })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  it('generates a 64-hex key file and sets env when unset (dev)', () => {
    const env: NodeJS.ProcessEnv = {}
    ensureLocalSecretKey({ keyPath, env, nodeEnv: 'development' })
    expect(fs.existsSync(keyPath)).toBe(true)
    expect(env.CONDUIT_SECRET_KEY).toMatch(/^[0-9a-f]{64}$/)
    expect(fs.readFileSync(keyPath, 'utf8').trim()).toBe(env.CONDUIT_SECRET_KEY)
  })

  it('reuses an existing key file', () => {
    fs.writeFileSync(keyPath, 'b'.repeat(64), { mode: 0o600 })
    const env: NodeJS.ProcessEnv = {}
    ensureLocalSecretKey({ keyPath, env, nodeEnv: 'development' })
    expect(env.CONDUIT_SECRET_KEY).toBe('b'.repeat(64))
  })

  it('is a no-op when CONDUIT_SECRET_KEY is already set', () => {
    const env: NodeJS.ProcessEnv = { CONDUIT_SECRET_KEY: 'c'.repeat(64) }
    ensureLocalSecretKey({ keyPath, env, nodeEnv: 'development' })
    expect(fs.existsSync(keyPath)).toBe(false)
    expect(env.CONDUIT_SECRET_KEY).toBe('c'.repeat(64))
  })

  it('does NOT generate in production', () => {
    const env: NodeJS.ProcessEnv = {}
    ensureLocalSecretKey({ keyPath, env, nodeEnv: 'production' })
    expect(fs.existsSync(keyPath)).toBe(false)
    expect(env.CONDUIT_SECRET_KEY).toBeUndefined()
  })
})
