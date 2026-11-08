import { describe, it, expect } from 'vitest'
import { authUrlMismatch, cloneUrlProblem, isSshUrl } from './repoUrl'

describe('isSshUrl', () => {
  it.each([
    ['git@gitlab.com:group/project.git', true],
    ['ssh://git@gitlab.example.com:2222/group/project.git', true],
    ['deploy@10.0.0.4:repos/app.git', true],
    ['https://gitlab.com/group/project.git', false],
    ['http://host/repo.git', false],
    ['/srv/git/repo.git', false],
  ])('%s → %s', (url, expected) => {
    expect(isSshUrl(url)).toBe(expected)
  })
})

describe('authUrlMismatch', () => {
  it.each(['pat', 'githubapp', 'gitlab'] as const)('%s needs https', (method) => {
    expect(authUrlMismatch('git@gitlab.com:g/p.git', method)).toMatch(/https:\/\//)
    expect(authUrlMismatch('https://gitlab.com/g/p.git', method)).toBeUndefined()
  })

  it('sshkey needs an SSH URL', () => {
    expect(authUrlMismatch('https://gitlab.com/g/p.git', 'sshkey')).toMatch(/SSH clone URL/)
    expect(authUrlMismatch('git@gitlab.com:g/p.git', 'sshkey')).toBeUndefined()
    expect(authUrlMismatch('ssh://git@host:2222/g/p.git', 'sshkey')).toBeUndefined()
  })

  it('accepts anything for none and server ssh', () => {
    expect(authUrlMismatch('git@host:x.git', 'none')).toBeUndefined()
    expect(authUrlMismatch('https://host/x.git', 'ssh')).toBeUndefined()
  })
})

describe('cloneUrlProblem', () => {
  it.each([
    'https://gitlab.com/g/p.git',
    'git@gitlab.com:g/p.git',
    'ssh://git@gitlab.com:2222/g/p.git',
  ])('accepts %s', (url) => {
    expect(cloneUrlProblem(url)).toBeUndefined()
  })

  it.each(['https://oauth2:glpat-x@gitlab.com/g/p.git', 'https://user@gitlab.com/g/p.git'])(
    'refuses embedded credentials in %s',
    (url) => {
      expect(cloneUrlProblem(url)).toMatch(/Do not embed credentials/)
    }
  )

  it('refuses something that is not a URL', () => {
    expect(cloneUrlProblem('not a url')).toMatch(/not a valid clone URL/)
  })
})
