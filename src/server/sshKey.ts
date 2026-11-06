import * as crypto from 'crypto'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

/**
 * SSH deploy-key support for repositories that authenticate with an uploaded
 * (or Conduit-generated) private key rather than an HTTPS token. Works against
 * any git host that speaks SSH — GitLab/GitHub deploy keys, Bitbucket access
 * keys, a self-hosted Gitea, a bare `git-shell` server.
 *
 * Keys are encrypted at rest like every other repo secret; this module only
 * deals with the plaintext form: validating it, deriving its public half (so
 * the UI can show what to register on the host), generating new ed25519 pairs,
 * and materializing it to a 0600 temp file that `GIT_SSH_COMMAND` points at
 * for the duration of a git operation or run.
 */

const OPENSSH_MAGIC = Buffer.from('openssh-key-v1\0', 'latin1')
const OPENSSH_BEGIN = '-----BEGIN OPENSSH PRIVATE KEY-----'
const OPENSSH_END = '-----END OPENSSH PRIVATE KEY-----'

export interface SshKeyPair {
  privateKey: string
  publicKey: string
}

// ── SSH wire encoding ────────────────────────────────────────────────────────

function sshString(data: Buffer | string): Buffer {
  const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data
  const len = Buffer.alloc(4)
  len.writeUInt32BE(buf.length)
  return Buffer.concat([len, buf])
}

function sshMpint(unsigned: Buffer): Buffer {
  let i = 0
  while (i < unsigned.length - 1 && unsigned[i] === 0) i++
  let body = unsigned.subarray(i)
  if (body[0] & 0x80) body = Buffer.concat([Buffer.from([0]), body])
  return sshString(body)
}

class SshReader {
  private offset = 0
  constructor(private readonly buf: Buffer) {}

  uint32(): number {
    if (this.offset + 4 > this.buf.length) throw new Error('truncated key data')
    const v = this.buf.readUInt32BE(this.offset)
    this.offset += 4
    return v
  }

  bytes(): Buffer {
    const len = this.uint32()
    if (this.offset + len > this.buf.length) throw new Error('truncated key data')
    const out = this.buf.subarray(this.offset, this.offset + len)
    this.offset += len
    return out
  }

  string(): string {
    return this.bytes().toString('utf8')
  }
}

function b64url(s: string): Buffer {
  return Buffer.from(s, 'base64url')
}

const EC_CURVES: Record<string, { name: string; size: number }> = {
  'P-256': { name: 'nistp256', size: 32 },
  'P-384': { name: 'nistp384', size: 48 },
  'P-521': { name: 'nistp521', size: 66 },
}

function leftPad(buf: Buffer, size: number): Buffer {
  return buf.length >= size ? buf : Buffer.concat([Buffer.alloc(size - buf.length), buf])
}

/** SSH public-key blob for a Node key object (RSA, Ed25519, ECDSA). */
function publicBlobFromKeyObject(key: crypto.KeyObject): Buffer {
  const jwk = key.export({ format: 'jwk' })
  if (jwk.kty === 'RSA' && jwk.n && jwk.e) {
    return Buffer.concat([sshString('ssh-rsa'), sshMpint(b64url(jwk.e)), sshMpint(b64url(jwk.n))])
  }
  if (jwk.kty === 'OKP' && jwk.crv === 'Ed25519' && jwk.x) {
    return Buffer.concat([sshString('ssh-ed25519'), sshString(b64url(jwk.x))])
  }
  if (jwk.kty === 'EC' && jwk.crv && jwk.x && jwk.y && EC_CURVES[jwk.crv]) {
    const { name, size } = EC_CURVES[jwk.crv]
    const point = Buffer.concat([Buffer.from([4]), leftPad(b64url(jwk.x), size), leftPad(b64url(jwk.y), size)])
    return Buffer.concat([sshString(`ecdsa-sha2-${name}`), sshString(name), sshString(point)])
  }
  throw new Error(`Unsupported SSH key type (${jwk.kty}${jwk.crv ? ` ${jwk.crv}` : ''}).`)
}

function formatPublicKey(blob: Buffer, comment?: string): string {
  const type = new SshReader(blob).string()
  const line = `${type} ${blob.toString('base64')}`
  return comment ? `${line} ${comment}` : line
}

function normalizeKeyText(privateKey: string): string {
  return privateKey.replace(/\r\n?/g, '\n').trim()
}

function parseOpenSshPrivateKey(text: string): { publicBlob: Buffer; encrypted: boolean } {
  const begin = text.indexOf(OPENSSH_BEGIN)
  const end = text.indexOf(OPENSSH_END)
  if (begin === -1 || end === -1 || end < begin) throw new Error('malformed OpenSSH key armor')
  const body = Buffer.from(text.slice(begin + OPENSSH_BEGIN.length, end).replace(/\s+/g, ''), 'base64')
  if (body.length < OPENSSH_MAGIC.length || !body.subarray(0, OPENSSH_MAGIC.length).equals(OPENSSH_MAGIC)) {
    throw new Error('not an openssh-key-v1 key')
  }
  const r = new SshReader(body.subarray(OPENSSH_MAGIC.length))
  const cipher = r.string()
  r.string() // kdfname
  r.bytes() // kdfoptions
  const count = r.uint32()
  if (count !== 1) throw new Error(`expected exactly one key, found ${count}`)
  return { publicBlob: r.bytes(), encrypted: cipher !== 'none' }
}

/**
 * Derive the OpenSSH public key line (`ssh-ed25519 AAAA…`) from a private key.
 * Accepts the OpenSSH format `ssh-keygen` writes by default, and PEM
 * (PKCS#1 RSA, SEC1 EC, PKCS#8). Throws an actionable error for keys git
 * can't use non-interactively — notably passphrase-protected ones.
 */
export function deriveSshPublicKey(privateKey: string, comment?: string): string {
  const text = normalizeKeyText(privateKey)
  if (text.includes(OPENSSH_BEGIN)) {
    let parsed: { publicBlob: Buffer; encrypted: boolean }
    try {
      parsed = parseOpenSshPrivateKey(text)
    } catch (err) {
      throw new Error(`Invalid SSH private key: ${(err as Error).message}.`, { cause: err })
    }
    if (parsed.encrypted) throw passphraseError()
    return formatPublicKey(parsed.publicBlob, comment)
  }
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text)) {
    if (/ENCRYPTED/.test(text)) throw passphraseError()
    let key: crypto.KeyObject
    try {
      key = crypto.createPrivateKey({ key: text, format: 'pem' })
    } catch (err) {
      throw new Error(`Invalid SSH private key: ${(err as Error).message}.`, { cause: err })
    }
    return formatPublicKey(publicBlobFromKeyObject(crypto.createPublicKey(key)), comment)
  }
  if (/^(ssh-|ecdsa-)/.test(text)) {
    throw new Error('That is a public key. Upload the private key (the file without the .pub extension).')
  }
  throw new Error('Invalid SSH private key: expected an OpenSSH or PEM private key.')
}

function passphraseError(): Error {
  return new Error(
    'Passphrase-protected SSH keys are not supported — git runs non-interactively. ' +
      'Remove the passphrase (ssh-keygen -p -N "" -f <key>) or generate a dedicated deploy key.'
  )
}

/** `SHA256:…` fingerprint of a public key line, matching `ssh-keygen -lf`. */
export function sshKeyFingerprint(publicKey: string): string {
  const b64 = publicKey.trim().split(/\s+/)[1]
  if (!b64) throw new Error('Invalid SSH public key.')
  const digest = crypto.createHash('sha256').update(Buffer.from(b64, 'base64')).digest('base64')
  return `SHA256:${digest.replace(/=+$/, '')}`
}

/** Generate a new ed25519 deploy key pair in OpenSSH format. */
export function generateSshKeyPair(comment = 'conduit-deploy-key'): SshKeyPair {
  const { privateKey } = crypto.generateKeyPairSync('ed25519')
  const jwk = privateKey.export({ format: 'jwk' })
  const seed = b64url(jwk.d!)
  const pub = b64url(jwk.x!)
  const publicBlob = Buffer.concat([sshString('ssh-ed25519'), sshString(pub)])

  const check = crypto.randomBytes(4)
  let priv = Buffer.concat([
    check,
    check,
    sshString('ssh-ed25519'),
    sshString(pub),
    sshString(Buffer.concat([seed, pub])),
    sshString(comment),
  ])
  const pad: number[] = []
  for (let i = 1; (priv.length + pad.length) % 8 !== 0; i++) pad.push(i)
  priv = Buffer.concat([priv, Buffer.from(pad)])

  const body = Buffer.concat([
    OPENSSH_MAGIC,
    sshString('none'),
    sshString('none'),
    sshString(Buffer.alloc(0)),
    Buffer.from([0, 0, 0, 1]),
    sshString(publicBlob),
    sshString(priv),
  ])
  const lines = body.toString('base64').match(/.{1,70}/g) ?? []
  return {
    privateKey: `${OPENSSH_BEGIN}\n${lines.join('\n')}\n${OPENSSH_END}\n`,
    publicKey: formatPublicKey(publicBlob, comment),
  }
}

// ── Materialization for git ──────────────────────────────────────────────────

export interface SshKeyConfig {
  privateKey: string
  /** known_hosts lines to pin the host key. Absent → trust on first use. */
  knownHosts?: string
}

export interface MaterializedSshKey {
  /** `GIT_SSH_COMMAND` pointing ssh at the key and the pinned known_hosts. */
  env: Record<string, string>
  /** known_hosts content after use — includes host keys learned on first use. */
  readKnownHosts(): string
  dispose(): void
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/**
 * Write the key (0600) and known_hosts to a private temp dir and build the
 * `GIT_SSH_COMMAND` that uses only them. With pinned known_hosts the host key
 * is checked strictly; without, ssh accepts and records a new host key
 * (`accept-new`) but still refuses a *changed* one, and the caller can persist
 * what was learned via {@link MaterializedSshKey.readKnownHosts}.
 *
 * The agent/server SSH agent is disabled (`IdentityAgent=none`) so the
 * repo's own key is the only identity offered.
 */
export function materializeSshKey(config: SshKeyConfig, dirPrefix = 'conduit-sshkey-'): MaterializedSshKey {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), dirPrefix))
  const keyPath = path.join(dir, 'id')
  const knownHostsPath = path.join(dir, 'known_hosts')
  // OpenSSH rejects a key file without a trailing newline ("invalid format").
  fs.writeFileSync(keyPath, `${normalizeKeyText(config.privateKey)}\n`, { mode: 0o600 })
  const pinned = config.knownHosts?.trim()
  fs.writeFileSync(knownHostsPath, pinned ? `${pinned}\n` : '', { mode: 0o600 })
  const command = [
    'ssh',
    '-i', shellQuote(keyPath),
    '-o', 'IdentitiesOnly=yes',
    '-o', 'IdentityAgent=none',
    '-o', 'BatchMode=yes',
    '-o', `UserKnownHostsFile=${shellQuote(knownHostsPath)}`,
    '-o', `StrictHostKeyChecking=${pinned ? 'yes' : 'accept-new'}`,
  ].join(' ')
  return {
    env: { GIT_SSH_COMMAND: command },
    readKnownHosts: () => {
      try {
        return fs.readFileSync(knownHostsPath, 'utf8').trim()
      } catch {
        return ''
      }
    },
    dispose: () => fs.rmSync(dir, { recursive: true, force: true }),
  }
}

/**
 * Run `fn` with a materialized key, always removing it afterwards. Without a
 * key, `fn` runs with an empty env overlay. `learnedKnownHosts` is set only
 * when the run started unpinned and ssh recorded a host key.
 */
export async function withSshKey<T>(
  config: SshKeyConfig | undefined,
  fn: (env: Record<string, string>) => Promise<T>
): Promise<{ result: T; learnedKnownHosts?: string }> {
  if (!config) return { result: await fn({}) }
  const key = materializeSshKey(config)
  try {
    const result = await fn(key.env)
    const learned = config.knownHosts?.trim() ? undefined : key.readKnownHosts() || undefined
    return { result, learnedKnownHosts: learned }
  } finally {
    key.dispose()
  }
}

/** True for scp-style (`git@host:path`) or `ssh://` clone URLs. */
export function isSshUrl(url: string): boolean {
  const s = url.trim()
  if (/^ssh:\/\//i.test(s)) return true
  return !s.includes('://') && /^[^@\s/]+@[^:\s/]+:.+/.test(s)
}
