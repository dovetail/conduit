import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { GH_TOKEN_FILE_ENV_VAR, installRepoCredentials, type RepoCredentials } from './repoCredentials'
import { buildAuthUrl } from '../gitOps'

const URL = 'https://github.com/acme/widgets.git'
const RUN_ID = '00000000-0000-4000-8000-000000000001'

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

describe('installRepoCredentials', () => {
  let root: string
  let workspace: string
  let fakeBin: string
  let creds: RepoCredentials | undefined

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-creds-test-'))
    workspace = path.join(root, 'ws')
    fs.mkdirSync(workspace)
    git(workspace, 'init', '-q')
    git(workspace, 'remote', 'add', 'origin', buildAuthUrl(URL, 'ghs_old'))
    fakeBin = path.join(root, 'bin')
    fs.mkdirSync(fakeBin)
    fs.writeFileSync(path.join(fakeBin, 'gh'), '#!/bin/sh\necho "$GH_TOKEN"\n', { mode: 0o755 })
  })

  afterEach(() => {
    creds?.dispose()
    creds = undefined
    fs.rmSync(root, { recursive: true, force: true })
  })

  function install(env: NodeJS.ProcessEnv): RepoCredentials {
    creds = installRepoCredentials({ runId: RUN_ID, workspacePath: workspace, repo: { url: URL, token: 'ghs_old' }, env })
    expect(creds).toBeDefined()
    return creds!
  }

  function runGh(overlayPath: string): string {
    return execFileSync('gh', [], { encoding: 'utf8', env: { PATH: overlayPath, GH_TOKEN: 'ghs_old' } }).trim()
  }

  it('returns undefined without a token or for a non-https remote', () => {
    expect(installRepoCredentials({ runId: RUN_ID, workspacePath: workspace, repo: { url: URL }, env: {} })).toBeUndefined()
    expect(
      installRepoCredentials({ runId: RUN_ID, workspacePath: workspace, repo: { url: 'git@github.com:a/b.git', token: 't' }, env: {} })
    ).toBeUndefined()
  })

  it('re-points a tokenized origin at the refreshed token', async () => {
    const c = install({ PATH: process.env.PATH })
    await c.update('ghs_new')
    expect(git(workspace, 'remote', 'get-url', 'origin')).toBe(buildAuthUrl(URL, 'ghs_new'))
    await c.update('ghs_newer')
    expect(git(workspace, 'remote', 'get-url', 'origin')).toBe(buildAuthUrl(URL, 'ghs_newer'))
  })

  it('leaves an origin the agent re-pointed alone', async () => {
    const c = install({ PATH: process.env.PATH })
    git(workspace, 'remote', 'set-url', 'origin', 'https://github.com/someone/fork.git')
    await c.update('ghs_new')
    expect(git(workspace, 'remote', 'get-url', 'origin')).toBe('https://github.com/someone/fork.git')
  })

  it('fronts gh with a wrapper that always reads the current token', async () => {
    const c = install({ PATH: fakeBin, GH_TOKEN: 'ghs_old' })
    expect(c.env.PATH?.endsWith(`${path.delimiter}${fakeBin}`)).toBe(true)
    expect(runGh(c.env.PATH!)).toBe('ghs_old')
    await c.update('ghs_new')
    expect(runGh(c.env.PATH!)).toBe('ghs_new')
  })

  it('lets the image gh shim read the refreshed token after a login shell resets PATH', async () => {
    const c = install({ PATH: fakeBin, GH_TOKEN: 'ghs_old' })
    const tokenFile = c.env[GH_TOKEN_FILE_ENV_VAR]
    expect(tokenFile).toBeDefined()
    await c.update('ghs_new')

    const shimDir = path.join(root, 'usr-local-bin')
    fs.mkdirSync(shimDir)
    const shim = fs
      .readFileSync(path.join(__dirname, '../../../scripts/gh-token-shim.sh'), 'utf8')
      .replace('exec /usr/bin/gh', `exec ${path.join(fakeBin, 'gh')}`)
    fs.writeFileSync(path.join(shimDir, 'gh'), shim, { mode: 0o755 })

    // The per-run wrapper dir is gone from PATH; only the env var survives.
    const out = execFileSync('gh', [], {
      encoding: 'utf8',
      env: { PATH: shimDir, GH_TOKEN: 'ghs_old', [GH_TOKEN_FILE_ENV_VAR]: tokenFile },
    }).trim()
    expect(out).toBe('ghs_new')
  })

  it('does not front gh when the agent supplies its own GH_TOKEN', () => {
    const c = install({ PATH: fakeBin, GH_TOKEN: 'ghp_agent_owned' })
    expect(c.env).toEqual({})
  })

  it('does not front gh when gh is not installed', () => {
    const c = install({ PATH: path.join(root, 'empty'), GH_TOKEN: 'ghs_old' })
    expect(c.env).toEqual({})
  })

  it('removes its credential directory on dispose', () => {
    const c = install({ PATH: fakeBin, GH_TOKEN: 'ghs_old' })
    const binDir = path.dirname(c.env.PATH!.split(path.delimiter)[0])
    expect(fs.existsSync(binDir)).toBe(true)
    c.dispose()
    creds = undefined
    expect(fs.existsSync(binDir)).toBe(false)
  })
})
