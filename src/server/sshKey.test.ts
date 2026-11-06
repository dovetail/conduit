import { describe, it, expect } from 'vitest'
import { execFileSync } from 'child_process'
import * as crypto from 'crypto'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  deriveSshPublicKey,
  generateSshKeyPair,
  materializeSshKey,
  sshKeyFingerprint,
  withSshKey,
} from './sshKey'

function hasSshKeygen(): boolean {
  try {
    execFileSync('ssh-keygen', ['-?'], { stdio: 'ignore' })
    return true
  } catch (err) {
    // `ssh-keygen -?` exits non-zero but proves the binary exists.
    return (err as NodeJS.ErrnoException).code !== 'ENOENT'
  }
}

const keygen = hasSshKeygen()

function tmpFile(name: string, content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sshkey-test-'))
  const p = path.join(dir, name)
  fs.writeFileSync(p, content, { mode: 0o600 })
  return p
}

describe('generateSshKeyPair', () => {
  it('produces an OpenSSH ed25519 key whose public half round-trips', () => {
    const pair = generateSshKeyPair('deploy@conduit')
    expect(pair.privateKey).toMatch(/^-----BEGIN OPENSSH PRIVATE KEY-----\n[\s\S]+\n-----END OPENSSH PRIVATE KEY-----\n$/)
    expect(pair.publicKey).toMatch(/^ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI[A-Za-z0-9+/]+=* deploy@conduit$/)
    expect(deriveSshPublicKey(pair.privateKey, 'deploy@conduit')).toBe(pair.publicKey)
  })

  it.skipIf(!keygen)('is readable by ssh-keygen', () => {
    const pair = generateSshKeyPair('x')
    const keyPath = tmpFile('id', pair.privateKey)
    const derived = execFileSync('ssh-keygen', ['-y', '-f', keyPath]).toString().trim()
    expect(derived.split(' ').slice(0, 2)).toEqual(pair.publicKey.split(' ').slice(0, 2))
  })
})

describe('deriveSshPublicKey', () => {
  it('derives RSA, ECDSA and Ed25519 public keys from PEM', () => {
    const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
    const rsaPem = rsa.privateKey.export({ type: 'pkcs1', format: 'pem' }).toString()
    expect(deriveSshPublicKey(rsaPem)).toMatch(/^ssh-rsa AAAAB3NzaC1yc2E/)

    const ec = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' })
    const ecPem = ec.privateKey.export({ type: 'sec1', format: 'pem' }).toString()
    expect(deriveSshPublicKey(ecPem)).toMatch(/^ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTY/)

    const ed = crypto.generateKeyPairSync('ed25519')
    const edPem = ed.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
    expect(deriveSshPublicKey(edPem)).toMatch(/^ssh-ed25519 AAAAC3NzaC1lZDI1NTE5/)
  })

  it.skipIf(!keygen)('matches ssh-keygen for keys it generates', () => {
    for (const type of ['rsa', 'ecdsa', 'ed25519']) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sshkey-test-'))
      const keyPath = path.join(dir, 'id')
      execFileSync('ssh-keygen', ['-q', '-t', type, '-N', '', '-C', 'c', '-f', keyPath])
      const expected = fs.readFileSync(`${keyPath}.pub`, 'utf8').trim()
      expect(deriveSshPublicKey(fs.readFileSync(keyPath, 'utf8'), 'c')).toBe(expected)
      expect(sshKeyFingerprint(expected)).toBe(
        execFileSync('ssh-keygen', ['-lf', `${keyPath}.pub`]).toString().split(' ')[1]
      )
    }
  })

  it.skipIf(!keygen)('rejects passphrase-protected keys with a fix', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sshkey-test-'))
    const keyPath = path.join(dir, 'id')
    execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', 'hunter2', '-f', keyPath])
    expect(() => deriveSshPublicKey(fs.readFileSync(keyPath, 'utf8'))).toThrow(/Passphrase-protected.*ssh-keygen -p/)
  })

  it('rejects encrypted PEM, public keys, and garbage', () => {
    const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
    const encrypted = rsa.privateKey
      .export({ type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase: 'pw' })
      .toString()
    expect(() => deriveSshPublicKey(encrypted)).toThrow(/Passphrase-protected/)
    expect(() => deriveSshPublicKey(generateSshKeyPair().publicKey)).toThrow(/public key/)
    expect(() => deriveSshPublicKey('hello')).toThrow(/Invalid SSH private key/)
  })

  it('tolerates CRLF line endings from uploaded files', () => {
    const pair = generateSshKeyPair('c')
    expect(deriveSshPublicKey(pair.privateKey.replace(/\n/g, '\r\n'), 'c')).toBe(pair.publicKey)
  })
})

describe('sshKeyFingerprint', () => {
  it('formats an unpadded SHA256 fingerprint', () => {
    expect(sshKeyFingerprint(generateSshKeyPair().publicKey)).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/)
  })
})

describe('materializeSshKey', () => {
  it('writes a 0600 key and strict host checking when known_hosts are pinned', () => {
    const pair = generateSshKeyPair()
    const m = materializeSshKey({ privateKey: pair.privateKey, knownHosts: 'gitlab.com ssh-ed25519 AAAA' })
    try {
      const cmd = m.env.GIT_SSH_COMMAND
      expect(fs.statSync(m.keyPath).mode & 0o777).toBe(0o600)
      expect(fs.readFileSync(m.keyPath, 'utf8').endsWith('-----\n')).toBe(true)
      expect(cmd).toContain(m.keyPath)
      expect(cmd).toContain('StrictHostKeyChecking=yes')
      expect(cmd).toContain('IdentitiesOnly=yes')
      expect(cmd).toContain('IdentityAgent=none')
      expect(cmd).toContain('BatchMode=yes')
      // ssh_config can't reroute the connection or add identities.
      expect(cmd).toMatch(/^ssh -F \/dev\/null /)
      expect(cmd).toContain('HashKnownHosts=no')
      expect(m.readKnownHosts()).toBe('gitlab.com ssh-ed25519 AAAA')
    } finally {
      m.dispose()
    }
  })

  it('accepts a new host key when nothing is pinned, and dispose removes the key', () => {
    const m = materializeSshKey({ privateKey: generateSshKeyPair().privateKey })
    expect(m.env.GIT_SSH_COMMAND).toContain('StrictHostKeyChecking=accept-new')
    m.dispose()
    expect(fs.existsSync(m.keyPath)).toBe(false)
  })
})

describe('withSshKey', () => {
  it('reports host keys learned on first use and always cleans up', async () => {
    let keyPath = ''
    const { result, learnedKnownHosts } = await withSshKey(
      { privateKey: generateSshKeyPair().privateKey },
      async (env) => {
        keyPath = /-i '([^']+)'/.exec(env.GIT_SSH_COMMAND)![1]
        const kh = /UserKnownHostsFile='([^']+)'/.exec(env.GIT_SSH_COMMAND)![1]
        fs.appendFileSync(kh, 'host.example ssh-ed25519 AAAAlearned\n')
        return 'ok'
      }
    )
    expect(result).toBe('ok')
    expect(learnedKnownHosts).toBe('host.example ssh-ed25519 AAAAlearned')
    expect(fs.existsSync(keyPath)).toBe(false)
  })

  it('does not report pinned hosts as learned, and cleans up on failure', async () => {
    let keyPath = ''
    await expect(
      withSshKey({ privateKey: generateSshKeyPair().privateKey, knownHosts: 'h ssh-ed25519 AAAA' }, async (env) => {
        keyPath = /-i '([^']+)'/.exec(env.GIT_SSH_COMMAND)![1]
        throw new Error('boom')
      })
    ).rejects.toThrow('boom')
    expect(fs.existsSync(keyPath)).toBe(false)
  })

  it('runs with an empty overlay when there is no key', async () => {
    const res = await withSshKey(undefined, async (env) => env)
    expect(res).toEqual({ result: {} })
  })
})
