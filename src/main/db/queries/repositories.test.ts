import { describe, it, expect, beforeEach, vi } from 'vitest'
import { sshKeyFingerprint } from '../../utils/sshFingerprint'

// In-memory store backing the mocked drizzle db. Rows are plain objects keyed by id.
const store = new Map<string, any>()

// Mocked drizzle operators return descriptor objects; `matchRow` interprets them.
function matchRow(row: any, cond: any): boolean {
  if (!cond) return true
  switch (cond.op) {
    case 'eq':
      return row[cond.col] === cond.v
    default:
      return true
  }
}

// Thenable query builder: `.from()` is awaitable (all rows) and chainable via `.where()`.
class Q {
  constructor(public rows: any[]) {}
  where(cond: any): Q {
    return new Q(this.rows.filter((r) => matchRow(r, cond)))
  }
  then(resolve: (rows: any[]) => unknown, reject?: (e: unknown) => unknown) {
    return Promise.resolve(this.rows).then(resolve, reject)
  }
}

vi.mock('../index', () => ({
  getDb: () => ({
    select: () => ({ from: () => new Q([...store.values()]) }),
    insert: () => ({
      values: (v: any) => {
        store.set(v.id, { ...v })
        return Promise.resolve()
      },
    }),
    update: () => ({
      set: (vals: any) => ({
        where: (cond: any) => {
          for (const r of store.values()) if (matchRow(r, cond)) Object.assign(r, vals)
          return Promise.resolve()
        },
      }),
    }),
    delete: () => ({
      where: (cond: any) => {
        for (const [id, r] of store) if (matchRow(r, cond)) store.delete(id)
        return Promise.resolve()
      },
    }),
  }),
}))

// Column tokens map to their own name so mocked operators can carry the column key.
vi.mock('../schema', () => ({
  repositories: {
    id: 'id',
    name: 'name',
    url: 'url',
    defaultBranch: 'defaultBranch',
    authMethod: 'authMethod',
    syncStatus: 'syncStatus',
    syncError: 'syncError',
    lastSyncedAt: 'lastSyncedAt',
    clonePath: 'clonePath',
    ownerId: 'ownerId',
    githubAppId: 'githubAppId',
    githubPrivateKeyEnc: 'githubPrivateKeyEnc',
    gitlabTokenEnc: 'gitlabTokenEnc',
    sshPrivateKeyEnc: 'sshPrivateKeyEnc',
    sshPublicKey: 'sshPublicKey',
    sshKnownHosts: 'sshKnownHosts',
    commitAuthorName: 'commitAuthorName',
    commitAuthorEmail: 'commitAuthorEmail',
    createdAt: 'createdAt',
    updatedAt: 'updatedAt',
  },
  agents: { id: 'id', repositoryId: 'repositoryId' },
}))

vi.mock('drizzle-orm', () => ({
  eq: (col: string, v: unknown) => ({ op: 'eq', col, v }),
}))

vi.mock('./access', () => ({
  getVisibleEntityIds: async () => [...store.values()].map((r) => r.id),
}))
vi.mock('./shares', () => ({
  deleteSharesForEntity: vi.fn(async () => {}),
}))

import {
  getRepository,
  getRepositoryCredentials,
  listRepositories,
  updateRepository,
} from './repositories'

/** Well-formed ed25519 public key used to exercise fingerprinting. */
const SSH_PUB =
  'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl test'
const SSH_FP = sshKeyFingerprint(SSH_PUB)

function seed(partial: Record<string, unknown> & { id: string }): void {
  store.set(partial.id, {
    id: partial.id,
    name: 'Repo',
    url: 'https://github.com/acme/app.git',
    defaultBranch: 'main',
    authMethod: 'none',
    syncStatus: 'ready',
    syncError: null,
    lastSyncedAt: null,
    clonePath: `/tmp/repos/${partial.id}`,
    ownerId: 'u1',
    githubAppId: null,
    githubPrivateKeyEnc: null,
    gitlabTokenEnc: null,
    sshPrivateKeyEnc: null,
    sshPublicKey: null,
    sshKnownHosts: null,
    commitAuthorName: null,
    commitAuthorEmail: null,
    createdAt: 1,
    updatedAt: 1,
    ...partial,
  })
}

beforeEach(() => {
  store.clear()
})

describe('updateRepository auth-method switches', () => {
  it('clears gitlab_token_enc when switching gitlab → githubapp', async () => {
    seed({
      id: 'r1',
      authMethod: 'gitlab',
      gitlabTokenEnc: 'enc-gl-token',
    })

    await updateRepository('r1', {
      authMethod: 'githubapp',
      githubAppId: '42',
      githubPrivateKeyEnc: 'enc-gh-pem',
    })

    const row = store.get('r1')
    expect(row.authMethod).toBe('githubapp')
    expect(row.gitlabTokenEnc).toBeNull()
    expect(row.githubAppId).toBe('42')
    expect(row.githubPrivateKeyEnc).toBe('enc-gh-pem')
  })

  it('clears ssh key fields when switching sshkey → gitlab', async () => {
    seed({
      id: 'r1',
      authMethod: 'sshkey',
      url: 'git@github.com:acme/app.git',
      sshPrivateKeyEnc: 'enc-ssh',
      sshPublicKey: SSH_PUB,
      sshKnownHosts: 'github.com ssh-ed25519 AAAA',
    })

    await updateRepository('r1', {
      authMethod: 'gitlab',
      gitlabTokenEnc: 'enc-gl',
    })

    const row = store.get('r1')
    expect(row.authMethod).toBe('gitlab')
    expect(row.sshPrivateKeyEnc).toBeNull()
    expect(row.sshPublicKey).toBeNull()
    expect(row.sshKnownHosts).toBeNull()
    expect(row.gitlabTokenEnc).toBe('enc-gl')
  })

  it('clears github app fields when switching githubapp → none', async () => {
    seed({
      id: 'r1',
      authMethod: 'githubapp',
      githubAppId: '99',
      githubPrivateKeyEnc: 'enc-pem',
    })

    await updateRepository('r1', { authMethod: 'none' })

    const row = store.get('r1')
    expect(row.authMethod).toBe('none')
    expect(row.githubAppId).toBeNull()
    expect(row.githubPrivateKeyEnc).toBeNull()
  })
})

describe('updateRepository secret replacement without authMethod', () => {
  it('replaces gitlabTokenEnc when authMethod is omitted and already gitlab', async () => {
    seed({ id: 'r1', authMethod: 'gitlab', gitlabTokenEnc: 'enc-old' })

    const updated = await updateRepository('r1', { gitlabTokenEnc: 'enc-new' })

    expect(updated.authMethod).toBe('gitlab')
    expect(store.get('r1').gitlabTokenEnc).toBe('enc-new')
  })

  it('replaces sshPrivateKeyEnc when authMethod is omitted and already sshkey', async () => {
    seed({
      id: 'r1',
      authMethod: 'sshkey',
      url: 'git@github.com:acme/app.git',
      sshPrivateKeyEnc: 'enc-old',
      sshPublicKey: SSH_PUB,
    })

    const updated = await updateRepository('r1', {
      sshPrivateKeyEnc: 'enc-new',
      sshPublicKey: SSH_PUB,
    })

    expect(updated.authMethod).toBe('sshkey')
    expect(store.get('r1').sshPrivateKeyEnc).toBe('enc-new')
  })

  it('does not write gitlabTokenEnc when the repo authMethod is pat', async () => {
    seed({ id: 'r1', authMethod: 'pat', gitlabTokenEnc: null })

    // authMethod omitted but stored method is not gitlab — token must not land.
    await updateRepository('r1', { gitlabTokenEnc: 'enc-should-not-land' })

    expect(store.get('r1').authMethod).toBe('pat')
    expect(store.get('r1').gitlabTokenEnc).toBeNull()
  })
})

describe('updateRepository sshKnownHosts pin', () => {
  it('clears the pin when URL changes but the same sshKnownHosts is sent back', async () => {
    const pin = 'github.com ssh-ed25519 AAAA'
    seed({
      id: 'r1',
      authMethod: 'sshkey',
      url: 'git@github.com:acme/old.git',
      sshPrivateKeyEnc: 'enc-ssh',
      sshPublicKey: SSH_PUB,
      sshKnownHosts: pin,
    })

    await updateRepository('r1', {
      url: 'git@github.com:acme/new.git',
      sshKnownHosts: pin,
    })

    expect(store.get('r1').sshKnownHosts).toBeNull()
  })

  it('stores a new pin when URL changes with a different sshKnownHosts', async () => {
    seed({
      id: 'r1',
      authMethod: 'sshkey',
      url: 'git@github.com:acme/old.git',
      sshPrivateKeyEnc: 'enc-ssh',
      sshPublicKey: SSH_PUB,
      sshKnownHosts: 'github.com ssh-ed25519 OLD',
    })

    await updateRepository('r1', {
      url: 'git@gitlab.com:acme/new.git',
      sshKnownHosts: 'gitlab.com ssh-ed25519 NEW',
    })

    expect(store.get('r1').sshKnownHosts).toBe('gitlab.com ssh-ed25519 NEW')
  })

  it('stores empty or whitespace sshKnownHosts as null', async () => {
    seed({
      id: 'r1',
      authMethod: 'sshkey',
      url: 'git@github.com:acme/app.git',
      sshPrivateKeyEnc: 'enc-ssh',
      sshPublicKey: SSH_PUB,
      sshKnownHosts: 'github.com ssh-ed25519 AAAA',
    })

    await updateRepository('r1', { sshKnownHosts: '' })
    expect(store.get('r1').sshKnownHosts).toBeNull()

    store.get('r1').sshKnownHosts = 'github.com ssh-ed25519 AAAA'
    await updateRepository('r1', { sshKnownHosts: '   \t  ' })
    expect(store.get('r1').sshKnownHosts).toBeNull()
  })

  it('keeps sshKnownHosts cleared when switching away from sshkey even if a pin is passed', async () => {
    seed({
      id: 'r1',
      authMethod: 'sshkey',
      url: 'git@github.com:acme/app.git',
      sshPrivateKeyEnc: 'enc-ssh',
      sshPublicKey: SSH_PUB,
      sshKnownHosts: 'github.com ssh-ed25519 AAAA',
    })

    await updateRepository('r1', {
      authMethod: 'none',
      sshKnownHosts: 'github.com ssh-ed25519 SHOULD-NOT-STICK',
    })

    const row = store.get('r1')
    expect(row.authMethod).toBe('none')
    expect(row.sshPrivateKeyEnc).toBeNull()
    expect(row.sshPublicKey).toBeNull()
    expect(row.sshKnownHosts).toBeNull()
  })
})

describe('updateRepository name-only', () => {
  it('leaves all secrets and the host-key pin untouched', async () => {
    seed({
      id: 'r1',
      authMethod: 'sshkey',
      url: 'git@github.com:acme/app.git',
      name: 'Old',
      githubAppId: 'should-stay',
      githubPrivateKeyEnc: 'enc-gh',
      gitlabTokenEnc: 'enc-gl',
      sshPrivateKeyEnc: 'enc-ssh',
      sshPublicKey: SSH_PUB,
      sshKnownHosts: 'github.com ssh-ed25519 AAAA',
    })

    await updateRepository('r1', { name: 'New' })

    const row = store.get('r1')
    expect(row.name).toBe('New')
    expect(row.authMethod).toBe('sshkey')
    expect(row.githubAppId).toBe('should-stay')
    expect(row.githubPrivateKeyEnc).toBe('enc-gh')
    expect(row.gitlabTokenEnc).toBe('enc-gl')
    expect(row.sshPrivateKeyEnc).toBe('enc-ssh')
    expect(row.sshPublicKey).toBe(SSH_PUB)
    expect(row.sshKnownHosts).toBe('github.com ssh-ed25519 AAAA')
  })
})

describe('rowToRepository (via getRepository / listRepositories)', () => {
  it('sets hasGitlabToken/hasSshKey from enc columns and never returns *Enc keys', async () => {
    seed({
      id: 'r1',
      authMethod: 'sshkey',
      gitlabTokenEnc: 'enc-gl',
      sshPrivateKeyEnc: 'enc-ssh',
      sshPublicKey: SSH_PUB,
      sshKnownHosts: 'github.com ssh-ed25519 AAAA',
      githubPrivateKeyEnc: 'enc-gh',
    })

    const repo = await getRepository('r1')
    expect(repo).not.toBeNull()
    expect(repo!.hasGitlabToken).toBe(true)
    expect(repo!.hasSshKey).toBe(true)
    expect(repo!.hasGithubKey).toBe(true)
    expect(repo).not.toHaveProperty('gitlabTokenEnc')
    expect(repo).not.toHaveProperty('sshPrivateKeyEnc')
    expect(repo).not.toHaveProperty('githubPrivateKeyEnc')
    expect(repo!.sshKeyFingerprint).toBe(SSH_FP)
    expect(repo!.sshKnownHosts).toBe('github.com ssh-ed25519 AAAA')

    const listed = await listRepositories('u1', [])
    expect(listed).toHaveLength(1)
    expect(listed[0]).not.toHaveProperty('sshPrivateKeyEnc')
    expect(listed[0].hasSshKey).toBe(true)
  })

  it('returns undefined fingerprint for a malformed public key without throwing', async () => {
    seed({
      id: 'r1',
      authMethod: 'sshkey',
      sshPrivateKeyEnc: 'enc-ssh',
      sshPublicKey: 'not-a-valid-key',
    })

    await expect(getRepository('r1')).resolves.toMatchObject({
      sshPublicKey: 'not-a-valid-key',
      sshKeyFingerprint: undefined,
    })
  })

  it('reports hasGitlabToken/hasSshKey false when enc columns are null', async () => {
    seed({ id: 'r1', authMethod: 'none' })
    const repo = await getRepository('r1')
    expect(repo!.hasGitlabToken).toBe(false)
    expect(repo!.hasSshKey).toBe(false)
    expect(repo!.hasGithubKey).toBe(false)
    expect(repo!.sshKeyFingerprint).toBeUndefined()
  })
})

describe('getRepositoryCredentials', () => {
  it('returns the enc fields plus sshKnownHosts', async () => {
    seed({
      id: 'r1',
      authMethod: 'sshkey',
      githubAppId: '7',
      githubPrivateKeyEnc: 'enc-gh',
      gitlabTokenEnc: 'enc-gl',
      sshPrivateKeyEnc: 'enc-ssh',
      sshPublicKey: SSH_PUB,
      sshKnownHosts: 'github.com ssh-ed25519 AAAA',
    })

    await expect(getRepositoryCredentials('r1')).resolves.toEqual({
      githubAppId: '7',
      githubPrivateKeyEnc: 'enc-gh',
      gitlabTokenEnc: 'enc-gl',
      sshPrivateKeyEnc: 'enc-ssh',
      sshKnownHosts: 'github.com ssh-ed25519 AAAA',
    })
  })

  it('returns null when the repository does not exist', async () => {
    await expect(getRepositoryCredentials('missing')).resolves.toBeNull()
  })
})
