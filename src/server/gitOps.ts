import { spawn } from 'child_process'
import * as fs from 'fs'

/**
 * Redact any credentials embedded in a URL's userinfo (e.g.
 * `https://x-access-token:<token>@github.com/...`) before the string is logged,
 * stored as syncError, or broadcast to clients. git echoes the remote URL in
 * several failure modes, which would otherwise leak the PAT / installation token.
 */
export function redactCredentials(s: string): string {
  return s.replace(/(https?:\/\/)[^/@\s]+@/gi, '$1***@')
}

/**
 * Run a git command and return a promise that resolves on success
 * or rejects with stderr on failure.
 */
function runGit(args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''

    child.stdout.on('data', (data: Buffer) => { stdout += data.toString() })
    child.stderr.on('data', (data: Buffer) => { stderr += data.toString() })

    child.on('close', (code) => {
      if (code === 0) {
        resolve(stdout.trim())
      } else {
        reject(new Error(redactCredentials(`git ${args[0]} failed (exit ${code}): ${stderr.trim()}`)))
      }
    })

    child.on('error', (err) => {
      reject(new Error(`Failed to spawn git: ${err.message}`))
    })
  })
}

/**
 * Inject a PAT into an HTTPS git URL for authentication.
 * Returns the URL unchanged if it's not HTTPS or no PAT is provided.
 */
export function buildAuthUrl(url: string, pat?: string): string {
  if (!pat || !url.startsWith('https://')) return url
  // Transform https://github.com/... → https://x-access-token:<pat>@github.com/...
  return url.replace('https://', `https://x-access-token:${pat}@`)
}

/**
 * Test connectivity to a remote repository via `git ls-remote`.
 * Returns the default branch ref on success, or throws on failure.
 */
export async function testRepoConnection(url: string, pat?: string): Promise<string> {
  const authUrl = buildAuthUrl(url, pat)
  const output = await runGit(['ls-remote', '--heads', authUrl])
  const refCount = output.split('\n').filter((l) => l.trim()).length
  return `Connected — ${refCount} branch${refCount !== 1 ? 'es' : ''} found`
}

/**
 * Clone a repository as a bare clone (no working tree).
 */
export async function cloneRepo(
  url: string,
  clonePath: string,
  branch: string,
  pat?: string
): Promise<void> {
  const authUrl = buildAuthUrl(url, pat)
  await runGit(['clone', '--bare', '--single-branch', '--branch', branch, authUrl, clonePath])
}

/**
 * Fetch latest changes into a bare clone.
 */
export async function fetchRepo(clonePath: string, url: string, pat?: string): Promise<void> {
  const authUrl = buildAuthUrl(url, pat)
  // Set the remote URL in case the PAT changed, then fetch
  await runGit(['remote', 'set-url', 'origin', authUrl], { cwd: clonePath })
  await runGit(['fetch', '--prune', 'origin'], { cwd: clonePath })
}

/**
 * Create a git worktree from a bare clone for an isolated run workspace.
 */
export async function createWorktree(
  clonePath: string,
  worktreePath: string,
  branch: string
): Promise<void> {
  await runGit(['worktree', 'add', worktreePath, branch], { cwd: clonePath })
}

/**
 * Configure a run worktree so the agent can commit and push:
 * - sets the committer identity (author name/email)
 * - points `origin` at a tokenized URL so `git push` authenticates
 *
 * `token` should be a freshly-resolved repo credential; for SSH/none repos pass
 * no token and the existing origin (SSH or plain) is left untouched.
 */
export async function configureWorktreeGit(
  worktreePath: string,
  opts: { url: string; token?: string; authorName: string; authorEmail: string }
): Promise<void> {
  await runGit(['config', 'user.name', opts.authorName], { cwd: worktreePath })
  await runGit(['config', 'user.email', opts.authorEmail], { cwd: worktreePath })
  if (opts.token && opts.url.startsWith('https://')) {
    await runGit(['remote', 'set-url', 'origin', buildAuthUrl(opts.url, opts.token)], { cwd: worktreePath })
  }
}

/**
 * Remove a git worktree. Falls back to fs.rmSync if git command fails.
 */
export async function removeWorktree(clonePath: string, worktreePath: string): Promise<void> {
  try {
    await runGit(['worktree', 'remove', '--force', worktreePath], { cwd: clonePath })
  } catch {
    // Fallback: remove the directory directly
    try {
      fs.rmSync(worktreePath, { recursive: true, force: true })
      // Also prune stale worktree references
      await runGit(['worktree', 'prune'], { cwd: clonePath }).catch(() => {})
    } catch {
      // Ignore — directory may already be gone
    }
  }
}
