import { createAppAuth } from '@octokit/auth-app'
import { getGithubPat } from './store'
import { decryptSecret } from './crypto'
import { getRepositoryCredentials } from '../main/db/queries/repositories'
import type { Repository } from '../shared/types'

const GITHUB_API = 'https://api.github.com'

/**
 * Extract `owner` and `repo` from a GitHub clone URL. Handles HTTPS (with or
 * without embedded credentials / `.git` suffix) and `git@host:owner/repo` SSH form.
 */
export function parseGithubOwnerRepo(url: string): { owner: string; repo: string } {
  let s = url.trim()
  // scp-style SSH (`git@host:owner/repo`) only — guard against HTTPS URLs that
  // carry userinfo and a port (`https://user@host:8443/owner/repo`) matching too.
  const sshMatch = s.includes('://') ? null : s.match(/^[^@]+@[^:]+:(.+)$/)
  if (sshMatch) {
    s = sshMatch[1]
  } else {
    s = s.replace(/^https?:\/\//, '') // strip scheme
    s = s.replace(/^[^@/]+@/, '') // strip embedded credentials
    const slash = s.indexOf('/')
    if (slash !== -1) s = s.slice(slash + 1) // drop host
  }
  s = s.replace(/\.git$/, '').replace(/\/+$/, '')
  const parts = s.split('/').filter(Boolean)
  if (parts.length < 2) {
    throw new Error(`Cannot parse owner/repo from URL: ${url}`)
  }
  return { owner: parts[0], repo: parts[1] }
}

/**
 * Mint a short-lived (~1h) GitHub App installation access token for a repo.
 *
 * 1. Sign an app JWT from the App ID + private key.
 * 2. Auto-discover the installation that covers the repo's owner/repo.
 * 3. Mint an installation access token for that installation.
 */
export async function mintInstallationToken(opts: {
  appId: string
  privateKey: string
  repoUrl: string
}): Promise<string> {
  const { appId, privateKey, repoUrl } = opts
  const { owner, repo } = parseGithubOwnerRepo(repoUrl)
  const auth = createAppAuth({ appId, privateKey })

  // App JWT for installation discovery.
  const appAuth = await auth({ type: 'app' })

  const res = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/installation`, {
    headers: {
      Authorization: `Bearer ${appAuth.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'conduit',
    },
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(
      `GitHub App (id ${appId}) is not installed for ${owner}/${repo} ` +
        `(HTTP ${res.status}). Install the app and grant it repo access. ${body}`.trim()
    )
  }
  const installation = (await res.json()) as { id?: number }
  if (typeof installation?.id !== 'number') {
    throw new Error(
      `Unexpected response discovering the GitHub App installation for ${owner}/${repo}.`
    )
  }

  const installationAuth = await auth({ type: 'installation', installationId: installation.id })
  return installationAuth.token
}

/**
 * Resolve the git credential token for a repository based on its auth method:
 * - `pat`        → the global GitHub PAT from the environment
 * - `githubapp`  → decrypt the stored key and mint an installation token
 * - `ssh`/`none` → no token (handled outside HTTPS token injection)
 */
export async function resolveRepoToken(
  repo: Pick<Repository, 'id' | 'url' | 'authMethod'>
): Promise<string | undefined> {
  switch (repo.authMethod) {
    case 'pat':
      return getGithubPat()
    case 'githubapp': {
      const creds = await getRepositoryCredentials(repo.id)
      if (!creds?.githubAppId || !creds.githubPrivateKeyEnc) {
        throw new Error(
          `Repository ${repo.id} uses GitHub App auth but is missing an App ID or private key.`
        )
      }
      const privateKey = decryptSecret(creds.githubPrivateKeyEnc)
      return mintInstallationToken({ appId: creds.githubAppId, privateKey, repoUrl: repo.url })
    }
    case 'ssh':
    case 'none':
    default:
      return undefined
  }
}
