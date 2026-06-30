import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock the GitHub App auth library: app JWT + installation token.
vi.mock('@octokit/auth-app', () => ({
  createAppAuth: vi.fn(() => async (opts: { type: string; installationId?: number }) => {
    if (opts.type === 'app') return { token: 'app-jwt' }
    if (opts.type === 'installation') return { token: `ghs_inst_${opts.installationId}` }
    throw new Error(`unexpected auth type ${opts.type}`)
  }),
}))

// Mock the persistence + crypto layers used by resolveRepoToken.
vi.mock('../main/db/queries/repositories', () => ({
  getRepositoryCredentials: vi.fn(),
}))
vi.mock('./crypto', () => ({
  decryptSecret: vi.fn(() => 'DECRYPTED-PEM'),
}))

import { parseGithubOwnerRepo, mintInstallationToken, resolveRepoToken } from './githubApp'
import { getRepositoryCredentials } from '../main/db/queries/repositories'
import { decryptSecret } from './crypto'

describe('parseGithubOwnerRepo', () => {
  it.each([
    ['https://github.com/acme/widgets.git', 'acme', 'widgets'],
    ['https://github.com/acme/widgets', 'acme', 'widgets'],
    ['https://x-access-token:tok@github.com/acme/widgets.git', 'acme', 'widgets'],
    ['git@github.com:acme/widgets.git', 'acme', 'widgets'],
    ['https://github.com/acme/widgets/', 'acme', 'widgets'],
    // HTTPS with userinfo AND a port must not be misread as scp-style SSH.
    ['https://user@github.example.com:8443/acme/widgets.git', 'acme', 'widgets'],
  ])('parses %s', (url, owner, repo) => {
    expect(parseGithubOwnerRepo(url)).toEqual({ owner, repo })
  })

  it('throws on an unparseable URL', () => {
    expect(() => parseGithubOwnerRepo('https://github.com/acme')).toThrow()
  })
})

describe('mintInstallationToken', () => {
  const realFetch = global.fetch
  afterEach(() => {
    global.fetch = realFetch
    vi.restoreAllMocks()
  })

  it('discovers the installation and mints an installation token', async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ id: 4242 }),
    })) as unknown as typeof fetch

    const token = await mintInstallationToken({
      appId: '123',
      privateKey: 'PEM',
      repoUrl: 'https://github.com/acme/widgets.git',
    })

    expect(token).toBe('ghs_inst_4242')
    const call = (global.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(call[0]).toBe('https://api.github.com/repos/acme/widgets/installation')
    expect(call[1].headers.Authorization).toBe('Bearer app-jwt')
  })

  it('throws a helpful error when the app is not installed', async () => {
    global.fetch = vi.fn(async () => ({
      ok: false,
      status: 404,
      text: async () => 'Not Found',
    })) as unknown as typeof fetch

    await expect(
      mintInstallationToken({ appId: '123', privateKey: 'PEM', repoUrl: 'https://github.com/acme/widgets' })
    ).rejects.toThrow(/not installed/i)
  })

  it('throws when the installation response lacks a numeric id', async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ message: 'unexpected' }),
    })) as unknown as typeof fetch

    await expect(
      mintInstallationToken({ appId: '123', privateKey: 'PEM', repoUrl: 'https://github.com/acme/widgets' })
    ).rejects.toThrow(/unexpected response/i)
  })
})

describe('resolveRepoToken', () => {
  const realFetch = global.fetch
  const origPat = process.env.GITHUB_PAT
  beforeEach(() => {
    vi.mocked(getRepositoryCredentials).mockReset()
    vi.mocked(decryptSecret).mockClear()
  })
  afterEach(() => {
    global.fetch = realFetch
    if (origPat === undefined) delete process.env.GITHUB_PAT
    else process.env.GITHUB_PAT = origPat
  })

  it('returns undefined for none/ssh', async () => {
    expect(await resolveRepoToken({ id: 'r1', url: 'https://github.com/a/b', authMethod: 'none' })).toBeUndefined()
    expect(await resolveRepoToken({ id: 'r1', url: 'https://github.com/a/b', authMethod: 'ssh' })).toBeUndefined()
  })

  it('returns the env PAT for pat auth', async () => {
    process.env.GITHUB_PAT = 'ghp_test'
    expect(await resolveRepoToken({ id: 'r1', url: 'https://github.com/a/b', authMethod: 'pat' })).toBe('ghp_test')
  })

  it('decrypts the stored key and mints a token for githubapp auth', async () => {
    vi.mocked(getRepositoryCredentials).mockResolvedValue({
      githubAppId: '123',
      githubPrivateKeyEnc: 'enc-blob',
    })
    global.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ id: 99 }) })) as unknown as typeof fetch

    const token = await resolveRepoToken({ id: 'r1', url: 'https://github.com/acme/widgets', authMethod: 'githubapp' })

    expect(decryptSecret).toHaveBeenCalledWith('enc-blob')
    expect(token).toBe('ghs_inst_99')
  })

  it('throws if githubapp auth is missing credentials', async () => {
    vi.mocked(getRepositoryCredentials).mockResolvedValue({ githubAppId: undefined, githubPrivateKeyEnc: undefined })
    await expect(
      resolveRepoToken({ id: 'r1', url: 'https://github.com/a/b', authMethod: 'githubapp' })
    ).rejects.toThrow(/missing/i)
  })
})
