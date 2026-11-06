import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { execFileSync } from 'child_process'
import { installCursorMcpConfig } from './cursorMcpConfig'

const CONDUIT_CONFIG = JSON.stringify({
  mcpServers: {
    datadog: { type: 'http', url: 'https://dd.example/mcp', headers: { Authorization: 'Bearer secret' } },
  },
})

let dir: string

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8' })
}

function readConfig(): { mcpServers: Record<string, { url?: string; command?: string }> } {
  return JSON.parse(fs.readFileSync(path.join(dir, '.cursor', 'mcp.json'), 'utf8'))
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conduit-cursor-mcp-test-'))
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('installCursorMcpConfig', () => {
  it('writes the servers to .cursor/mcp.json and removes them on restore', async () => {
    const restore = await installCursorMcpConfig(dir, CONDUIT_CONFIG)
    expect(readConfig().mcpServers.datadog.url).toBe('https://dd.example/mcp')

    await restore()
    expect(fs.existsSync(path.join(dir, '.cursor'))).toBe(false)
  })

  it('merges with an existing config, Conduit entries winning, and restores the original bytes', async () => {
    fs.mkdirSync(path.join(dir, '.cursor'))
    const original = JSON.stringify({
      mcpServers: { datadog: { url: 'https://stale.example' }, repoLocal: { command: 'repo-mcp' } },
    })
    fs.writeFileSync(path.join(dir, '.cursor', 'mcp.json'), original)

    const restore = await installCursorMcpConfig(dir, CONDUIT_CONFIG)
    const merged = readConfig()
    expect(merged.mcpServers.datadog.url).toBe('https://dd.example/mcp')
    expect(merged.mcpServers.repoLocal.command).toBe('repo-mcp')

    await restore()
    expect(fs.readFileSync(path.join(dir, '.cursor', 'mcp.json'), 'utf8')).toBe(original)
  })

  it('hides an untracked config from git so injected tokens cannot be committed', async () => {
    git('init', '-q')
    await installCursorMcpConfig(dir, CONDUIT_CONFIG)
    expect(git('status', '--porcelain', '--untracked-files=all')).toBe('')
  })

  it('hides changes to a tracked config from git and undoes it on restore', async () => {
    git('init', '-q')
    fs.mkdirSync(path.join(dir, '.cursor'))
    fs.writeFileSync(path.join(dir, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: {} }))
    git('add', '.')
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init')

    const restore = await installCursorMcpConfig(dir, CONDUIT_CONFIG)
    git('add', '-A')
    expect(git('diff', '--cached', '--name-only')).toBe('')

    await restore()
    expect(git('ls-files', '-v', '.cursor/mcp.json').startsWith('H ')).toBe(true)
    expect(git('status', '--porcelain')).toBe('')
  })

  it('is idempotent on restore', async () => {
    const restore = await installCursorMcpConfig(dir, CONDUIT_CONFIG)
    await restore()
    await expect(restore()).resolves.toBeUndefined()
  })
})
