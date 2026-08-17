import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { execFileSync } from 'child_process'
import * as os from 'os'
import * as path from 'path'

// Stub fs.rmSync via vi.mock (ESM named exports aren't spyable). Default:
// call through so real-git tests still reclaim. The failure case overrides it —
// chmod-based injection is bypassed when CI runs as root in Docker.
const fsMock = vi.hoisted(() => {
  let realRmSync: typeof import('fs').rmSync
  const rmSync = vi.fn((...args: Parameters<typeof import('fs').rmSync>) =>
    realRmSync(...args)
  )
  return {
    rmSync,
    setRealRmSync(fn: typeof import('fs').rmSync) {
      realRmSync = fn
    },
    callThrough() {
      rmSync.mockImplementation((...args) => realRmSync(...args))
    },
    realRmSync(...args: Parameters<typeof import('fs').rmSync>) {
      return realRmSync(...args)
    },
  }
})

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  fsMock.setRealRmSync(actual.rmSync.bind(actual))
  return { ...actual, rmSync: fsMock.rmSync }
})

import * as fs from 'fs'
import { createWorktree, removeWorktree } from './gitOps'

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, stdio: 'pipe' }).toString()

function makeRepoWithWorktree(): { repo: string; worktree: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'conduit-gitops-test-'))
  const repo = path.join(root, 'repo')
  fs.mkdirSync(repo)
  git(repo, 'init', '-b', 'master')
  git(repo, 'config', 'user.email', 't@t.com')
  git(repo, 'config', 'user.name', 'T')
  fs.writeFileSync(path.join(repo, 'f.txt'), 'hi')
  git(repo, 'add', '.')
  git(repo, 'commit', '-m', 'init')
  const worktreesDir = path.join(repo, 'worktrees-run')
  fs.mkdirSync(worktreesDir)
  const worktree = path.join(worktreesDir, 'w1')
  git(repo, 'worktree', 'add', '--detach', worktree)
  return {
    repo,
    worktree,
    cleanup: () => fsMock.realRmSync(root, { recursive: true, force: true }),
  }
}

describe('removeWorktree', () => {
  const cleanups: Array<() => void> = []
  beforeEach(() => fsMock.callThrough())
  afterEach(() => {
    cleanups.splice(0).forEach((c) => c())
    fsMock.callThrough()
  })

  it('removes the worktree directory and deregisters it from the repo', async () => {
    const { repo, worktree, cleanup } = makeRepoWithWorktree()
    cleanups.push(cleanup)

    await removeWorktree(repo, worktree)

    expect(fs.existsSync(worktree)).toBe(false)
    expect(git(repo, 'worktree', 'list')).not.toContain(worktree)
  })

  it('throws when the worktree cannot be removed (so the leak is never silent)', async () => {
    // No real git repo needed: `git worktree remove` fails and falls through to
    // fs.rmSync. Stub that so the directory survives — models EACCES /
    // undeletable content without relying on chmod (bypassed under root/CI).
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'conduit-gitops-undeletable-'))
    const worktree = path.join(root, 'worktree')
    fs.mkdirSync(worktree)
    cleanups.push(() => fsMock.realRmSync(root, { recursive: true, force: true }))

    fsMock.rmSync.mockImplementation((target) => {
      if (path.resolve(String(target)) === path.resolve(worktree)) {
        throw new Error('EACCES: permission denied, simulated')
      }
      throw new Error(`unexpected fs.rmSync(${String(target)})`)
    })

    await expect(removeWorktree(root, worktree)).rejects.toThrow(/still present/)
    expect(fs.existsSync(worktree)).toBe(true) // still there — that's why it threw
  })
})

function makeCloneWithBranch(): { clone: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'conduit-gitops-conc-'))
  const clone = path.join(root, 'repo')
  fs.mkdirSync(clone)
  git(clone, 'init', '-b', 'master')
  git(clone, 'config', 'user.email', 't@t.com')
  git(clone, 'config', 'user.name', 'T')
  fs.writeFileSync(path.join(clone, 'f.txt'), 'hi')
  git(clone, 'add', '.')
  git(clone, 'commit', '-m', 'init')
  fs.mkdirSync(path.join(clone, 'worktrees-run'))
  return { clone, cleanup: () => fsMock.realRmSync(root, { recursive: true, force: true }) }
}

describe('createWorktree — concurrent runs on the same branch', () => {
  const cleanups: Array<() => void> = []
  beforeEach(() => fsMock.callThrough())
  afterEach(() => {
    cleanups.splice(0).forEach((c) => c())
    fsMock.callThrough()
  })

  // Two runs of the same agent/repo overlap in time: both want a worktree at the
  // tip of `master`. Git refuses to check out a branch that is already checked out
  // in another worktree, so a name-based `worktree add <path> master` fails the
  // second run with `fatal: 'master' is already checked out at …`. Each run must
  // get its own isolated checkout of master's commit regardless of overlap.
  it('lets a second worktree be created while the first is still checked out', async () => {
    const { clone, cleanup } = makeCloneWithBranch()
    cleanups.push(cleanup)

    const wtA = path.join(clone, 'worktrees-run', 'run-a')
    const wtB = path.join(clone, 'worktrees-run', 'run-b')

    await createWorktree(clone, wtA, 'master')
    // The first worktree is intentionally left in place (an active run) when the
    // second is created — this is the concurrency the fix must support.
    await createWorktree(clone, wtB, 'master')

    // Both are real, independent checkouts at master's tip.
    expect(fs.readFileSync(path.join(wtA, 'f.txt'), 'utf8')).toBe('hi')
    expect(fs.readFileSync(path.join(wtB, 'f.txt'), 'utf8')).toBe('hi')
    const head = git(clone, 'rev-parse', 'master').trim()
    expect(git(wtA, 'rev-parse', 'HEAD').trim()).toBe(head)
    expect(git(wtB, 'rev-parse', 'HEAD').trim()).toBe(head)
  })
})
