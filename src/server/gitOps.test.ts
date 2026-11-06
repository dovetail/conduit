import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'events'

// Record every git invocation so we can assert cleanup was attempted. The fake
// child fails `git worktree add` with an out-of-disk stderr dump and succeeds
// any other subcommand (e.g. the `worktree remove` cleanup).
const spawnCalls: string[][] = []
/** What `git config --get remote.origin.url` reports; undefined ⇒ key unset. */
let storedOriginUrl: string | undefined
/** When true, `git remote set-url` fails (e.g. a full data volume). */
let setUrlFails = false
vi.mock('child_process', () => ({
  spawn: vi.fn((_cmd: string, args: string[]) => {
    spawnCalls.push(args)
    const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter }
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    queueMicrotask(() => {
      if (args[0] === 'worktree' && args[1] === 'add') {
        child.stderr.emit(
          'data',
          Buffer.from('Updating files:  67% (19493/29094)\nerror: unable to create file x: No space left on device\n')
        )
        child.emit('close', 128)
      } else if (args[0] === 'config' && args[1] === '--get') {
        if (storedOriginUrl === undefined) return child.emit('close', 1)
        child.stdout.emit('data', Buffer.from(`${storedOriginUrl}\n`))
        child.emit('close', 0)
      } else if (setUrlFails && args[0] === 'remote' && args[1] === 'set-url') {
        child.stderr.emit(
          'data',
          Buffer.from('error: failed to write new configuration file /clone/config.lock\n')
        )
        child.emit('close', 128)
      } else {
        child.emit('close', 0)
      }
    })
    return child
  }),
}))

import { redactCredentials, buildAuthUrl, isDiskFullError, createWorktree, fetchRepo } from './gitOps'

beforeEach(() => {
  spawnCalls.length = 0
  storedOriginUrl = undefined
  setUrlFails = false
})

describe('redactCredentials', () => {
  it('redacts an embedded token in an https URL', () => {
    const url = buildAuthUrl('https://github.com/acme/widgets.git', 'ghs_secrettoken')
    expect(url).toContain('ghs_secrettoken')
    const redacted = redactCredentials(`git clone failed: ${url}`)
    expect(redacted).not.toContain('ghs_secrettoken')
    expect(redacted).toContain('https://***@github.com/acme/widgets.git')
  })

  it('leaves credential-free strings unchanged', () => {
    const msg = 'git fetch failed (exit 128): fatal: repository not found'
    expect(redactCredentials(msg)).toBe(msg)
  })
})

describe('isDiskFullError', () => {
  it('detects ENOSPC / no-space git failures', () => {
    expect(isDiskFullError('error: ... No space left on device')).toBe(true)
    expect(isDiskFullError('spawn git ENOSPC')).toBe(true)
    expect(isDiskFullError('Not enough disk space to start this run. Free space on the Conduit server or increase its data volume, then retry.')).toBe(true)
  })
  // git's config writer drops the errno, so this out-of-space failure arrives
  // with no "No space left on device" to match on.
  it('detects a config write that ran out of space', () => {
    expect(
      isDiskFullError(
        'git remote failed (exit 128): error: failed to write new configuration file ' +
          "/data/repos/9f7404af-a623-4d35-9a59-267aeb88389f/config.lock\n" +
          "fatal: could not set 'remote.origin.url' to 'https://***@github.com/acme/widgets.git'"
      )
    ).toBe(true)
  })
  it('is false for unrelated failures', () => {
    expect(isDiskFullError("fatal: 'master' is already checked out")).toBe(false)
    expect(isDiskFullError('fatal: repository not found')).toBe(false)
    // A lock that could not be *taken* is contention or permissions, not space.
    expect(isDiskFullError('error: could not lock config file config: File exists')).toBe(false)
  })
})

describe('fetchRepo', () => {
  it('fetches an explicit refspec so the bare clone\'s branch actually advances', async () => {
    await fetchRepo('/clone', 'https://github.com/acme/widgets.git', 'main', 'ghs_token')

    const fetch = spawnCalls.find((a) => a[0] === 'fetch')!
    expect(fetch).toContain('+refs/heads/main:refs/heads/main')
  })

  it('fetches the credentialed URL directly rather than relying on the stored remote', async () => {
    storedOriginUrl = 'https://x-access-token:ghs_expired@github.com/acme/widgets.git'
    await fetchRepo('/clone', 'https://github.com/acme/widgets.git', 'main', 'ghs_token')

    const fetch = spawnCalls.find((a) => a[0] === 'fetch')!
    expect(fetch[1]).toBe('https://x-access-token:ghs_token@github.com/acme/widgets.git')
  })

  it('rewrites the stored origin only when the credential changed', async () => {
    storedOriginUrl = 'https://x-access-token:ghs_token@github.com/acme/widgets.git'
    await fetchRepo('/clone', 'https://github.com/acme/widgets.git', 'main', 'ghs_token')

    expect(spawnCalls.some((a) => a[0] === 'remote' && a[1] === 'set-url')).toBe(false)

    spawnCalls.length = 0
    await fetchRepo('/clone', 'https://github.com/acme/widgets.git', 'main', 'ghs_rotated')
    expect(spawnCalls.some((a) => a[0] === 'remote' && a[1] === 'set-url')).toBe(true)
  })

  it('still fetches when the stored origin cannot be rewritten', async () => {
    setUrlFails = true
    await expect(
      fetchRepo('/clone', 'https://github.com/acme/widgets.git', 'main', 'ghs_token')
    ).resolves.toBeUndefined()
    expect(spawnCalls.some((a) => a[0] === 'fetch')).toBe(true)
  })
})

describe('createWorktree', () => {
  it('tears down the partial worktree and reports out-of-space when the checkout runs out of disk', async () => {
    await expect(createWorktree('/clone', '/clone/worktrees-run/r1', 'master')).rejects.toThrow(/disk space/i)

    const subcommands = spawnCalls.map((a) => `${a[0]} ${a[1]}`)
    // It attempted the add, then attempted to remove the partial worktree it left behind.
    expect(subcommands).toContain('worktree add')
    expect(subcommands.some((s) => s === 'worktree remove' || s === 'worktree prune')).toBe(true)
  })
})
