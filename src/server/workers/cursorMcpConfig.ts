import * as fs from 'fs'
import * as path from 'path'
import { runGit } from '../gitOps'

/**
 * cursor-agent has no --mcp-config flag: it only loads MCP servers from the
 * workspace's `.cursor/mcp.json` (plus the host's `~/.cursor/mcp.json`). So the
 * run's materialized MCP config — which carries injected OAuth bearer tokens —
 * is merged into that file for the duration of the run. Conduit's entries win
 * over same-named repo entries.
 *
 * The file is hidden from git (info/exclude when untracked, skip-worktree when
 * tracked) so a `git add -A` by the agent can never commit the tokens, and the
 * returned restore function puts back the original file (or removes it). A
 * fixedDir workspace is the user's own checkout, so restoring is not optional.
 */
export async function installCursorMcpConfig(
  workspacePath: string,
  content: string
): Promise<() => Promise<void>> {
  const dirPath = path.join(workspacePath, '.cursor')
  const filePath = path.join(dirPath, 'mcp.json')
  const dirExisted = fs.existsSync(dirPath)
  const original = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : undefined

  let skipWorktreePath: string | undefined
  let restored = false
  const restore = async (): Promise<void> => {
    if (restored) return
    restored = true
    if (original !== undefined) {
      fs.writeFileSync(filePath, original, 'utf8')
    } else {
      fs.rmSync(filePath, { force: true })
      if (!dirExisted) {
        try {
          fs.rmdirSync(dirPath)
        } catch {
          // Not empty — the agent put something else there; leave it.
        }
      }
    }
    if (skipWorktreePath) {
      await runGit(['update-index', '--no-skip-worktree', '--', skipWorktreePath], { cwd: workspacePath })
    }
  }

  try {
    const conduit = JSON.parse(content) as { mcpServers?: Record<string, unknown> }
    let existing: { mcpServers?: Record<string, unknown> } = {}
    if (original !== undefined) {
      try {
        existing = JSON.parse(original)
      } catch {
        // Unparseable repo config — Cursor couldn't load it either; replace it.
      }
    }
    const merged = {
      ...existing,
      mcpServers: { ...existing.mcpServers, ...conduit.mcpServers },
    }
    fs.mkdirSync(dirPath, { recursive: true })
    fs.writeFileSync(filePath, JSON.stringify(merged, null, 2), { encoding: 'utf8', mode: 0o600 })

    skipWorktreePath = await hideFromGit(workspacePath)
  } catch (err) {
    await restore()
    throw err
  }

  return restore
}

/** Returns the repo-relative path when skip-worktree was set (so it can be undone). */
async function hideFromGit(workspacePath: string): Promise<string | undefined> {
  let prefix: string
  try {
    prefix = (await runGit(['rev-parse', '--show-prefix'], { cwd: workspacePath })).trim()
  } catch {
    return undefined // Not a git work tree — nothing to commit to.
  }
  const repoRelative = `${prefix}.cursor/mcp.json`

  let tracked = true
  try {
    await runGit(['ls-files', '--error-unmatch', '--', '.cursor/mcp.json'], { cwd: workspacePath })
  } catch {
    tracked = false
  }

  if (tracked) {
    await runGit(['update-index', '--skip-worktree', '--', '.cursor/mcp.json'], { cwd: workspacePath })
    return '.cursor/mcp.json'
  }

  const excludePath = path.resolve(
    workspacePath,
    (await runGit(['rev-parse', '--git-path', 'info/exclude'], { cwd: workspacePath })).trim()
  )
  const pattern = `/${repoRelative}`
  const current = fs.existsSync(excludePath) ? fs.readFileSync(excludePath, 'utf8') : ''
  if (!current.split('\n').includes(pattern)) {
    fs.mkdirSync(path.dirname(excludePath), { recursive: true })
    const sep = current === '' || current.endsWith('\n') ? '' : '\n'
    fs.appendFileSync(excludePath, `${sep}${pattern}\n`)
  }
  return undefined
}
