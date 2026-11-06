import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Repository } from '../shared/types'

vi.mock('../main/db/queries/repositories', () => ({
  getRepository: vi.fn(),
  getRepositoryCredentials: vi.fn(),
}))
vi.mock('./crypto', () => ({
  encryptSecret: (s: string) => `enc:${s}`,
  decryptSecret: (s: string) => s.replace(/^enc:/, ''),
}))

import { getRepository, getRepositoryCredentials } from '../main/db/queries/repositories'
import { assertAuthMatchesUrl, gitAuthHint, resolveTestAuth, withEncryptedSecrets } from './repoCredentials'
import { generateSshKeyPair } from './sshKey'

const STORED: Repository = {
  id: 'repo-1',
  name: 'p',
  url: 'https://gitlab.com/g/p.git',
  defaultBranch: 'main',
  authMethod: 'gitlab',
  syncStatus: 'ready',
  createdAt: 0,
  updatedAt: 0,
}

beforeEach(() => {
  vi.mocked(getRepository).mockReset()
  vi.mocked(getRepositoryCredentials).mockReset()
})

describe('withEncryptedSecrets', () => {
  it('encrypts write-only secrets and drops the plaintext', () => {
    const pair = generateSshKeyPair('k')
    const out = withEncryptedSecrets({ name: 'p', gitlabToken: ' glpat-1 ', sshPrivateKey: pair.privateKey })
    expect(out).toMatchObject({
      name: 'p',
      gitlabTokenEnc: 'enc:glpat-1',
      sshPrivateKeyEnc: `enc:${pair.privateKey.trim()}`,
      sshPublicKey: pair.publicKey.split(' ').slice(0, 2).join(' '),
    })
    expect(out).not.toHaveProperty('gitlabToken')
    expect(out).not.toHaveProperty('sshPrivateKey')
  })

  it('leaves stored secrets alone when none are supplied', () => {
    expect(withEncryptedSecrets({ name: 'p', gitlabToken: '', sshPrivateKey: '  ' })).toEqual({ name: 'p' })
  })

  it('rejects an unusable SSH key as a client error before storing anything', () => {
    expect(() => withEncryptedSecrets({ sshPrivateKey: generateSshKeyPair().publicKey })).toThrow(
      expect.objectContaining({ isClientError: true, message: expect.stringMatching(/public key/) })
    )
  })
})

describe('assertAuthMatchesUrl', () => {
  it('requires https for token methods and an SSH URL for deploy keys', () => {
    expect(() => assertAuthMatchesUrl({ url: 'git@gitlab.com:g/p.git', authMethod: 'gitlab' })).toThrow(/https:\/\//)
    expect(() => assertAuthMatchesUrl({ url: 'https://gitlab.com/g/p.git', authMethod: 'sshkey' })).toThrow(/SSH clone URL/)
    expect(() => assertAuthMatchesUrl({ url: 'https://gitlab.com/g/p.git', authMethod: 'gitlab' })).not.toThrow()
    expect(() => assertAuthMatchesUrl({ url: 'ssh://git@h:2222/p.git', authMethod: 'sshkey' })).not.toThrow()
    expect(() => assertAuthMatchesUrl({ url: 'git@h:p.git', authMethod: 'none' })).not.toThrow()
  })
})

describe('resolveTestAuth', () => {
  it('prefers a token typed into the form', async () => {
    expect(await resolveTestAuth({ url: STORED.url, authMethod: 'gitlab', gitlabToken: 'glpat-new' })).toEqual({
      token: 'glpat-new',
      tokenUsername: 'oauth2',
    })
    expect(getRepositoryCredentials).not.toHaveBeenCalled()
  })

  it('falls back to the stored token for the same host', async () => {
    vi.mocked(getRepository).mockResolvedValue(STORED)
    vi.mocked(getRepositoryCredentials).mockResolvedValue({ gitlabTokenEnc: 'enc:glpat-stored' })
    expect(
      await resolveTestAuth({ url: 'https://gitlab.com/g/renamed.git', authMethod: 'gitlab', repoId: STORED.id })
    ).toEqual({ token: 'glpat-stored', tokenUsername: 'oauth2' })
  })

  it('refuses to send a stored credential to a different host', async () => {
    vi.mocked(getRepository).mockResolvedValue(STORED)
    vi.mocked(getRepositoryCredentials).mockResolvedValue({ gitlabTokenEnc: 'enc:glpat-stored' })
    await expect(
      resolveTestAuth({ url: 'https://evil.example/g/p.git', authMethod: 'gitlab', repoId: STORED.id })
    ).rejects.toThrow(/different host/)
  })

  it('uses the stored deploy key and pinned hosts unless the form overrides them', async () => {
    const pair = generateSshKeyPair()
    vi.mocked(getRepository).mockResolvedValue({ ...STORED, url: 'git@gitlab.com:g/p.git', authMethod: 'sshkey' })
    vi.mocked(getRepositoryCredentials).mockResolvedValue({
      sshPrivateKeyEnc: `enc:${pair.privateKey}`,
      sshKnownHosts: 'gitlab.com ssh-ed25519 AAAA',
    })
    expect(await resolveTestAuth({ url: 'git@gitlab.com:g/p.git', authMethod: 'sshkey', repoId: STORED.id })).toEqual({
      sshKey: { privateKey: pair.privateKey, knownHosts: 'gitlab.com ssh-ed25519 AAAA' },
    })
    expect(
      await resolveTestAuth({ url: 'git@gitlab.com:g/p.git', authMethod: 'sshkey', repoId: STORED.id, sshKnownHosts: '' })
    ).toEqual({ sshKey: { privateKey: pair.privateKey, knownHosts: undefined } })
  })

  it('explains what is missing', async () => {
    await expect(resolveTestAuth({ url: STORED.url, authMethod: 'gitlab' })).rejects.toThrow(/Enter a GitLab access token/)
    await expect(resolveTestAuth({ url: 'git@h:p', authMethod: 'sshkey' })).rejects.toThrow(/Upload or generate/)
  })
})

describe('gitAuthHint', () => {
  it('maps git/ssh failures to an actionable fix', () => {
    expect(gitAuthHint('git@gitlab.com: Permission denied (publickey).')).toMatch(/deploy key/)
    expect(gitAuthHint('Host key verification failed.')).toMatch(/Known Hosts/)
    expect(gitAuthHint('remote: HTTP Basic: Access denied.')).toMatch(/expired or been revoked/)
    expect(gitAuthHint('fatal: could not lock config file')).toBeUndefined()
  })
})
