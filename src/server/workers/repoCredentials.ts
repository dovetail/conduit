import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { buildAuthUrl, runGit } from '../gitOps'

/**
 * Keeps a run's GitHub credential current for its whole lifetime.
 *
 * A GitHub App installation token lives about an hour, but agent runs can go
 * much longer, and the token is baked into two places the agent reads: the
 * checkout's `origin` URL (`git push`) and the `GH_TOKEN` env var (`gh`). The
 * process env can't be changed after spawn, so `gh` is fronted by a wrapper on
 * PATH that reads the token from a file on every invocation; `update` rewrites
 * that file and re-points `origin`. Only an `origin` still carrying the
 * previous token is touched, so an agent that re-points its remote keeps it.
 *
 * A login shell can drop the PATH prefix: cursor-agent snapshots its shell
 * with `bash -ilc`, and Debian's /etc/profile resets PATH outright. The token
 * file's path is therefore also exported as CONDUIT_GH_TOKEN_FILE, which
 * survives that reset, for the image's /usr/local/bin/gh shim
 * (scripts/gh-token-shim.sh) to read.
 */
export interface RepoCredentials {
  /** Env entries to overlay on the spawned process (PATH with the gh wrapper). */
  env: Record<string, string>
  update(token: string): Promise<void>
  dispose(): void
}

export const GH_TOKEN_FILE_ENV_VAR = 'CONDUIT_GH_TOKEN_FILE'

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function findOnPath(binary: string, pathValue: string | undefined): string | undefined {
  for (const dir of (pathValue ?? '').split(path.delimiter)) {
    if (!dir) continue
    const candidate = path.join(dir, binary)
    try {
      fs.accessSync(candidate, fs.constants.X_OK)
      return candidate
    } catch {
      // Not here; keep looking.
    }
  }
  return undefined
}

function writeFileAtomic(filePath: string, content: string, mode: number): void {
  const tmp = `${filePath}.${process.pid}.tmp`
  fs.writeFileSync(tmp, content, { mode })
  fs.renameSync(tmp, filePath)
}

export function installRepoCredentials(opts: {
  runId: string
  workspacePath: string
  repo: { url: string; token?: string }
  env: NodeJS.ProcessEnv
}): RepoCredentials | undefined {
  const { runId, workspacePath, repo, env } = opts
  if (!repo.token || !repo.url.startsWith('https://')) return undefined

  // `conduit-cred-` doesn't match the sweeper's `conduit-<uuid>-` workspace
  // shape, so the sweeper never removes it from under a live run.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `conduit-cred-${runId}-`))
  const tokenPath = path.join(dir, 'token')
  writeFileAtomic(tokenPath, repo.token, 0o600)

  const overlay: Record<string, string> = {}
  // Front `gh` only when it would otherwise use the Conduit-injected token;
  // an agent's own GH_TOKEN is left alone.
  const realGh = env.GH_TOKEN === repo.token ? findOnPath('gh', env.PATH) : undefined
  if (realGh) {
    const binDir = path.join(dir, 'bin')
    fs.mkdirSync(binDir, { mode: 0o700 })
    fs.writeFileSync(
      path.join(binDir, 'gh'),
      `#!/bin/sh\nIFS= read -r GH_TOKEN < ${shellQuote(tokenPath)}\nexport GH_TOKEN\nexec ${shellQuote(realGh)} "$@"\n`,
      { mode: 0o700 }
    )
    overlay.PATH = env.PATH ? `${binDir}${path.delimiter}${env.PATH}` : binDir
    overlay[GH_TOKEN_FILE_ENV_VAR] = tokenPath
  }

  let current = repo.token
  return {
    env: overlay,
    async update(token: string): Promise<void> {
      if (token === current) return
      writeFileAtomic(tokenPath, token, 0o600)
      const origin = (await runGit(['remote', 'get-url', 'origin'], { cwd: workspacePath }).catch(() => '')).trim()
      if (origin === buildAuthUrl(repo.url, current)) {
        await runGit(['remote', 'set-url', 'origin', buildAuthUrl(repo.url, token)], { cwd: workspacePath })
      }
      current = token
    },
    dispose(): void {
      fs.rmSync(dir, { recursive: true, force: true })
    },
  }
}
