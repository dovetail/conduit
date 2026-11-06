import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../main/db/queries/repositories', () => ({
  getRepositoryCredentials: vi.fn(),
}))
vi.mock('./crypto', () => ({
  decryptSecret: (s: string) => s.replace(/^enc:/, ''),
}))
vi.mock('./githubApp', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./githubApp')>()),
  resolveRepoToken: vi.fn(async () => 'ghs_installation'),
}))

import { getRepositoryCredentials } from '../main/db/queries/repositories'
import {
  gitRemoteHost,
  missingCredentialMessage,
  repoCliEnvEntries,
  resolveRepoAuth,
  resolveRepoAuthSafe,
} from './repoAuth'

beforeEach(() => {
  vi.mocked(getRepositoryCredentials).mockReset()
})

describe('resolveRepoAuth', () => {
  it('resolves GitHub methods to a token with the default username', async () => {
    expect(await resolveRepoAuth({ id: 'r', url: 'https://github.com/a/b.git', authMethod: 'githubapp' })).toEqual({
      token: 'ghs_installation',
    })
  })

  it('decrypts a GitLab token and pairs it with the oauth2 username', async () => {
    vi.mocked(getRepositoryCredentials).mockResolvedValue({ gitlabTokenEnc: 'enc:glpat-abc' })
    expect(await resolveRepoAuth({ id: 'r', url: 'https://gitlab.com/g/p.git', authMethod: 'gitlab' })).toEqual({
      token: 'glpat-abc',
      tokenUsername: 'oauth2',
    })
  })

  it('decrypts a deploy key together with its pinned host keys', async () => {
    vi.mocked(getRepositoryCredentials).mockResolvedValue({
      sshPrivateKeyEnc: 'enc:PRIVATE',
      sshKnownHosts: 'gitlab.com ssh-ed25519 AAAA',
    })
    expect(await resolveRepoAuth({ id: 'r', url: 'git@gitlab.com:g/p.git', authMethod: 'sshkey' })).toEqual({
      sshKey: { privateKey: 'PRIVATE', knownHosts: 'gitlab.com ssh-ed25519 AAAA' },
    })
  })

  it('resolves nothing for none/ssh or a method with no stored secret', async () => {
    vi.mocked(getRepositoryCredentials).mockResolvedValue({})
    expect(await resolveRepoAuth({ id: 'r', url: 'git@h:p', authMethod: 'ssh' })).toEqual({})
    expect(await resolveRepoAuth({ id: 'r', url: 'https://gitlab.com/g/p', authMethod: 'gitlab' })).toEqual({})
    expect(await resolveRepoAuth({ id: 'r', url: 'git@h:p', authMethod: 'sshkey' })).toEqual({})
  })

  it('resolveRepoAuthSafe returns the failure instead of throwing', async () => {
    vi.mocked(getRepositoryCredentials).mockRejectedValue(new Error('db down'))
    const res = await resolveRepoAuthSafe({ id: 'r', url: 'https://gitlab.com/g/p', authMethod: 'gitlab' })
    expect(res.auth).toEqual({})
    expect(res.error?.message).toBe('db down')
  })
})

describe('missingCredentialMessage', () => {
  it('flags methods whose credential resolved to nothing', () => {
    expect(missingCredentialMessage({ url: 'https://gitlab.com/g/p', authMethod: 'gitlab' }, {})).toMatch(/GitLab access token/)
    expect(missingCredentialMessage({ url: 'git@h:p', authMethod: 'sshkey' }, {})).toMatch(/SSH deploy key/)
    expect(missingCredentialMessage({ url: 'https://github.com/a/b', authMethod: 'pat' }, {})).toMatch(/GitHub PAT/)
    expect(missingCredentialMessage({ url: 'https://gitlab.com/g/p', authMethod: 'gitlab' }, { token: 't' })).toBeUndefined()
    expect(missingCredentialMessage({ url: 'git@h:p', authMethod: 'none' }, {})).toBeUndefined()
  })
})

describe('repoCliEnvEntries', () => {
  it('hands a GitLab token to glab, including the host for self-managed instances', () => {
    expect(repoCliEnvEntries('gitlab', 'https://gitlab.example.com:8443/g/p.git', 'glpat-x')).toEqual({
      GITLAB_TOKEN: 'glpat-x',
      GITLAB_HOST: 'https://gitlab.example.com:8443',
    })
  })

  it('lets explicit agent env vars win', () => {
    expect(
      repoCliEnvEntries('gitlab', 'https://gitlab.com/g/p.git', 'glpat-x', { GITLAB_TOKEN: 'mine', GITLAB_HOST: 'h' })
    ).toEqual({})
    expect(repoCliEnvEntries('githubapp', 'https://github.com/a/b', 'ghs', { GH_TOKEN: 'mine' })).toEqual({})
  })

  it('hands GitHub tokens to gh and nothing to SSH methods', () => {
    expect(repoCliEnvEntries('pat', 'https://github.com/a/b', 'ghp')).toEqual({ GH_TOKEN: 'ghp' })
    expect(repoCliEnvEntries('sshkey', 'git@gitlab.com:g/p', undefined)).toEqual({})
    expect(repoCliEnvEntries('gitlab', 'https://gitlab.com/g/p', undefined)).toEqual({})
  })
})

describe('gitRemoteHost', () => {
  it.each([
    ['https://GitLab.com/g/p.git', 'gitlab.com'],
    ['https://user@gitlab.example.com:8443/g/p', 'gitlab.example.com'],
    ['git@gitlab.com:g/p.git', 'gitlab.com'],
    ['ssh://git@gitlab.example.com:2222/g/p.git', 'gitlab.example.com'],
    ['not a url', undefined],
  ])('%s → %s', (url, host) => {
    expect(gitRemoteHost(url)).toBe(host)
  })
})
