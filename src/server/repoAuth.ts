import { decryptSecret } from './crypto'
import { resolveRepoToken, githubTokenEnvEntry } from './githubApp'
import { GITLAB_TOKEN_USERNAME, type GitAuth } from './gitOps'
import type { SshKeyConfig } from './sshKey'
import { getRepositoryCredentials } from '../main/db/queries/repositories'
import type { RepoAuthMethod, Repository } from '../shared/types'

/**
 * Everything git needs to reach a repository's remote, resolved from its auth
 * method: an HTTPS token (with the username its host expects) or an SSH deploy
 * key plus pinned host keys. Empty for `none` and `ssh` (the host's own agent).
 */
export interface ResolvedRepoAuth {
  token?: string
  tokenUsername?: string
  sshKey?: SshKeyConfig
}

type RepoRef = Pick<Repository, 'id' | 'url' | 'authMethod'>

export async function resolveRepoAuth(repo: RepoRef): Promise<ResolvedRepoAuth> {
  switch (repo.authMethod) {
    case 'pat':
    case 'githubapp':
      return { token: await resolveRepoToken(repo) }
    case 'gitlab': {
      const creds = await getRepositoryCredentials(repo.id)
      if (!creds?.gitlabTokenEnc) return {}
      return { token: decryptSecret(creds.gitlabTokenEnc), tokenUsername: GITLAB_TOKEN_USERNAME }
    }
    case 'sshkey': {
      const creds = await getRepositoryCredentials(repo.id)
      if (!creds?.sshPrivateKeyEnc) return {}
      return {
        sshKey: { privateKey: decryptSecret(creds.sshPrivateKeyEnc), knownHosts: creds.sshKnownHosts },
      }
    }
    default:
      return {}
  }
}

/** Whether the method needs a stored credential that resolved to nothing. */
export function missingCredentialMessage(
  repo: Pick<Repository, 'url' | 'authMethod'>,
  auth: ResolvedRepoAuth
): string | undefined {
  if (auth.token || auth.sshKey) return undefined
  // A GitHub method on a non-HTTPS URL has nothing to inject; git uses the host's own SSH setup.
  const https = repo.url.startsWith('https://')
  switch (repo.authMethod) {
    case 'pat':
      if (!https) return undefined
      return (
        'No GitHub credential resolved for this HTTPS repo (auth method: PAT). ' +
        'Configure a global GitHub PAT, or switch the repo to GitHub App authentication.'
      )
    case 'githubapp':
      if (!https) return undefined
      return (
        'No GitHub App token could be minted for this HTTPS repo. ' +
        'Check the App is installed on the repository and its App ID + private key are configured.'
      )
    case 'gitlab':
      return 'No GitLab access token is configured for this repository.'
    case 'sshkey':
      return 'No SSH deploy key is configured for this repository.'
    default:
      return undefined
  }
}

export function toGitAuth(auth: ResolvedRepoAuth, env?: Record<string, string>): GitAuth {
  return { token: auth.token, tokenUsername: auth.tokenUsername, env }
}

/** `https://host` of an HTTPS clone URL, for glab's GITLAB_HOST. */
function httpsOrigin(url: string): string | undefined {
  try {
    const u = new URL(url)
    return u.protocol === 'https:' || u.protocol === 'http:' ? `${u.protocol}//${u.host}` : undefined
  } catch {
    return undefined
  }
}

/**
 * Env entries that hand the repo credential to the host's CLI, so it
 * authenticates as the same identity `git push` uses: `GH_TOKEN` for `gh`
 * (GitHub methods), `GITLAB_TOKEN` + `GITLAB_HOST` for `glab` (GitLab; the host
 * makes self-managed instances work). An explicit per-agent entry always wins.
 */
export function repoCliEnvEntries(
  authMethod: RepoAuthMethod,
  url: string,
  token: string | undefined,
  existingEnvVars?: Record<string, string>
): Record<string, string> {
  if (!token) return {}
  const explicit = existingEnvVars ?? {}
  const out: Record<string, string> = {}
  if (authMethod === 'gitlab') {
    if (!('GITLAB_TOKEN' in explicit)) out.GITLAB_TOKEN = token
    const host = httpsOrigin(url)
    if (host && !('GITLAB_HOST' in explicit)) out.GITLAB_HOST = host
    return out
  }
  if (authMethod === 'pat' || authMethod === 'githubapp') return githubTokenEnvEntry(token, existingEnvVars)
  return out
}

/**
 * Host part of a clone URL — `https://host/…`, `ssh://user@host:port/…`, or
 * scp-style `user@host:path`. Lower-cased; undefined when unparseable.
 */
export function gitRemoteHost(url: string): string | undefined {
  const s = url.trim()
  if (!s.includes('://')) {
    const m = s.match(/^(?:[^@\s/]+@)?([^:\s/]+):/)
    return m ? m[1].toLowerCase() : undefined
  }
  try {
    return new URL(s).hostname.toLowerCase() || undefined
  } catch {
    return undefined
  }
}

/**
 * Resolve a repository's git credential WITHOUT throwing. A run should still
 * start when a credential can't be resolved — the agent can do useful
 * read-only work — but the failure is returned so the caller can put it in
 * the run log rather than leave `git push` to fail opaquely later.
 */
export async function resolveRepoAuthSafe(repo: RepoRef): Promise<{ auth: ResolvedRepoAuth; error?: Error }> {
  try {
    return { auth: await resolveRepoAuth(repo) }
  } catch (err) {
    return { auth: {}, error: err instanceof Error ? err : new Error(String(err)) }
  }
}
