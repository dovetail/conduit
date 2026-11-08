import { describe, it, expect } from 'vitest'
import {
  emptyRepoForm,
  repoCredentialsPresent,
  repoFormFromRepo,
  repoFormToInput,
  repoFormToTestInput,
  repoUrlProblem,
  type RepoFormState,
} from './repositoryForm'
import type { Repository } from '@shared/types'

const form = (patch: Partial<RepoFormState>): RepoFormState => ({
  ...emptyRepoForm(),
  name: 'p',
  url: 'https://gitlab.com/g/p.git',
  ...patch,
})

describe('repoFormToInput', () => {
  it('sends a new GitLab token only for the gitlab method', () => {
    expect(repoFormToInput(form({ authMethod: 'gitlab', gitlabToken: ' glpat-1 ' })).gitlabToken).toBe('glpat-1')
    expect(repoFormToInput(form({ authMethod: 'gitlab' }))).not.toHaveProperty('gitlabToken')
    expect(repoFormToInput(form({ authMethod: 'none', gitlabToken: 'glpat-1' }))).not.toHaveProperty('gitlabToken')
  })

  it('sends a deploy key and known hosts only for sshkey, leaving a stored key when none is new', () => {
    const ssh = form({ authMethod: 'sshkey', url: 'git@gitlab.com:g/p.git', sshKnownHosts: ' h k ' })
    expect(repoFormToInput({ ...ssh, sshPrivateKey: 'KEY' })).toMatchObject({ sshPrivateKey: 'KEY', sshKnownHosts: 'h k' })
    expect(repoFormToInput(ssh)).not.toHaveProperty('sshPrivateKey')
    expect(repoFormToInput({ ...ssh, authMethod: 'none' })).not.toHaveProperty('sshKnownHosts')
  })
})

describe('repoFormToTestInput', () => {
  it('falls back to stored credentials through repoId when nothing new is entered', () => {
    expect(repoFormToTestInput(form({ authMethod: 'gitlab' }), 'repo-1')).toMatchObject({
      authMethod: 'gitlab',
      gitlabToken: undefined,
      repoId: 'repo-1',
    })
  })
})

describe('repoUrlProblem', () => {
  it('flags a URL that does not fit the method', () => {
    expect(repoUrlProblem({ url: 'https://gitlab.com/g/p.git', authMethod: 'sshkey' })).toMatch(/SSH clone URL/)
    expect(repoUrlProblem({ url: 'git@gitlab.com:g/p.git', authMethod: 'gitlab' })).toMatch(/https:\/\//)
    expect(repoUrlProblem({ url: '', authMethod: 'gitlab' })).toBeUndefined()
  })

  it('flags embedded credentials, but not on an unchanged legacy URL', () => {
    const url = 'https://oauth2:glpat-1@gitlab.com/g/p.git'
    expect(repoUrlProblem({ url, authMethod: 'gitlab' })).toMatch(/embed credentials/)
    expect(repoUrlProblem({ url, authMethod: 'gitlab' }, url)).toBeUndefined()
  })
})

describe('repoCredentialsPresent', () => {
  it('accepts a stored credential or a new one', () => {
    expect(repoCredentialsPresent(form({ authMethod: 'gitlab' }))).toBe(false)
    expect(repoCredentialsPresent(form({ authMethod: 'gitlab', hasGitlabToken: true }))).toBe(true)
    expect(repoCredentialsPresent(form({ authMethod: 'sshkey', sshPrivateKey: 'KEY' }))).toBe(true)
    expect(repoCredentialsPresent(form({ authMethod: 'githubapp', hasGithubKey: true }))).toBe(false)
    expect(repoCredentialsPresent(form({ authMethod: 'none' }))).toBe(true)
  })
})

describe('repoFormFromRepo', () => {
  it('starts with no new secrets and carries the public key and pin', () => {
    const repo = {
      id: 'r',
      name: 'p',
      url: 'git@gitlab.com:g/p.git',
      defaultBranch: 'main',
      authMethod: 'sshkey',
      syncStatus: 'ready',
      hasSshKey: true,
      sshPublicKey: 'ssh-ed25519 AAAA',
      sshKeyFingerprint: 'SHA256:x',
      sshKnownHosts: 'gitlab.com ssh-ed25519 BBBB',
      createdAt: 0,
      updatedAt: 0,
    } as Repository
    expect(repoFormFromRepo(repo)).toMatchObject({
      sshPrivateKey: '',
      hasSshKey: true,
      sshPublicKey: 'ssh-ed25519 AAAA',
      sshKnownHosts: 'gitlab.com ssh-ed25519 BBBB',
    })
  })
})
