import { encryptSecret, decryptSecret } from './crypto'
import { mintInstallationToken, resolveRepoToken } from './githubApp'
import { getGithubPat } from './store'
import { GITLAB_TOKEN_USERNAME, testRepoConnection } from './gitOps'
import { gitRemoteHost, toGitAuth, type ResolvedRepoAuth } from './repoAuth'
import { deriveSshPublicKey, withSshKey } from './sshKey'
import { ClientError } from './errors'
import { getRepository, getRepositoryCredentials } from '../main/db/queries/repositories'
import { authUrlMismatch, cloneUrlProblem } from '../shared/repoUrl'
import type { Repository, RepositoryInput, RepoTestConnectionInput } from '../shared/types'

type SecretFields = 'githubPrivateKey' | 'gitlabToken' | 'sshPrivateKey'

export type EncryptedRepoData<T> = Omit<T, SecretFields> & {
  githubPrivateKeyEnc?: string
  gitlabTokenEnc?: string
  sshPrivateKeyEnc?: string
  sshPublicKey?: string
}

/**
 * Convert a client-facing repository payload into the persistence-layer shape:
 * raw write-only secrets (GitHub App PEM, GitLab token, SSH private key) are
 * encrypted into their `*Enc` fields, and an SSH key's public half is derived
 * so the UI can show what to register on the host. An absent/blank secret is
 * dropped so the stored value is left untouched on update.
 *
 * Throws a ClientError for an SSH key git can't use (malformed, a public key,
 * passphrase-protected) — before anything is stored.
 */
export function withEncryptedSecrets<T extends Partial<RepositoryInput>>(data: T): EncryptedRepoData<T> {
  const { githubPrivateKey, gitlabToken, sshPrivateKey, ...rest } = data
  const result = { ...rest } as EncryptedRepoData<T>
  if (typeof githubPrivateKey === 'string' && githubPrivateKey.trim()) {
    result.githubPrivateKeyEnc = encryptSecret(githubPrivateKey.trim())
  }
  if (typeof gitlabToken === 'string' && gitlabToken.trim()) {
    result.gitlabTokenEnc = encryptSecret(gitlabToken.trim())
  }
  if (typeof sshPrivateKey === 'string' && sshPrivateKey.trim()) {
    let publicKey: string
    try {
      publicKey = deriveSshPublicKey(sshPrivateKey)
    } catch (err) {
      throw new ClientError((err as Error).message)
    }
    result.sshPrivateKeyEnc = encryptSecret(sshPrivateKey.trim())
    result.sshPublicKey = publicKey
  }
  return result
}

/** Reject auth/URL combinations the sync and run paths can't use. */
export function assertAuthMatchesUrl(input: Pick<RepositoryInput, 'url' | 'authMethod'>): void {
  const problem = authUrlMismatch(input.url, input.authMethod)
  if (problem) throw new ClientError(problem)
}

/** {@link assertAuthMatchesUrl}, plus refuse malformed URLs and URLs carrying credentials. */
export function assertRepositoryUrl(input: Pick<RepositoryInput, 'url' | 'authMethod'>): void {
  const problem = cloneUrlProblem(input.url)
  if (problem) throw new ClientError(problem)
  assertAuthMatchesUrl(input)
}

/**
 * Whether an update touches what the stored credential is or where it is
 * sent. Only the owner may do that: a shared editor who could swap the host
 * could replay the stored token (or deploy key, after a fresh host-key pin) at
 * a server they control, and switching the auth method discards the stored
 * secrets.
 */
export function changesRepositoryCredentials(
  input: Partial<RepositoryInput>,
  existing: Pick<Repository, 'url' | 'authMethod' | 'githubAppId' | 'sshKnownHosts'>
): boolean {
  const blank = (s: string | undefined) => s?.trim() || undefined
  return (
    (input.authMethod !== undefined && input.authMethod !== existing.authMethod) ||
    (input.url !== undefined && gitRemoteHost(input.url) !== gitRemoteHost(existing.url)) ||
    (input.githubAppId !== undefined && input.githubAppId !== existing.githubAppId) ||
    !!blank(input.githubPrivateKey) ||
    !!blank(input.gitlabToken) ||
    !!blank(input.sshPrivateKey) ||
    (input.sshKnownHosts !== undefined && blank(input.sshKnownHosts) !== blank(existing.sshKnownHosts))
  )
}

/**
 * Stored credentials may only be exercised against the host they were saved
 * for — otherwise anyone who can edit the form could point a stored token at a
 * host they control and read it off the wire.
 */
async function assertStoredHostMatches(repoId: string, url: string): Promise<void> {
  const repo = await getRepository(repoId)
  if (repo && gitRemoteHost(repo.url) !== gitRemoteHost(url)) {
    throw new Error(
      'The stored credential belongs to a different host. Re-enter it to test against this URL.'
    )
  }
}

async function storedCredentialsFor(repoId: string, url: string) {
  await assertStoredHostMatches(repoId, url)
  return getRepositoryCredentials(repoId)
}

/**
 * Resolve the credential for a connection test from the form's values, or —
 * when none are supplied — the credential already stored for an existing repo.
 */
export async function resolveTestAuth(input: RepoTestConnectionInput): Promise<ResolvedRepoAuth> {
  switch (input.authMethod) {
    case 'pat':
      return { token: getGithubPat() }
    case 'githubapp':
      if (input.githubPrivateKey && input.githubPrivateKey.trim()) {
        if (!input.githubAppId) throw new Error('A GitHub App ID is required.')
        return {
          token: await mintInstallationToken({
            // Trim to match how the key is stored (encryptSecret trims) so a
            // successful test reflects the value that will actually be persisted.
            appId: input.githubAppId,
            privateKey: input.githubPrivateKey.trim(),
            repoUrl: input.url,
          }),
        }
      }
      if (input.repoId) {
        await assertStoredHostMatches(input.repoId, input.url)
        return { token: await resolveRepoToken({ id: input.repoId, url: input.url, authMethod: 'githubapp' }) }
      }
      throw new Error('Upload a GitHub App private key to test this connection.')
    case 'gitlab': {
      assertAuthMatchesUrl(input)
      let token = input.gitlabToken?.trim()
      if (!token && input.repoId) {
        const enc = (await storedCredentialsFor(input.repoId, input.url))?.gitlabTokenEnc
        token = enc ? decryptSecret(enc) : undefined
      }
      if (!token) throw new Error('Enter a GitLab access token to test this connection.')
      return { token, tokenUsername: GITLAB_TOKEN_USERNAME }
    }
    case 'sshkey': {
      assertAuthMatchesUrl(input)
      let privateKey = input.sshPrivateKey?.trim()
      let knownHosts = input.sshKnownHosts
      if (input.repoId && (!privateKey || knownHosts === undefined)) {
        const creds = await storedCredentialsFor(input.repoId, input.url)
        if (!privateKey && creds?.sshPrivateKeyEnc) privateKey = decryptSecret(creds.sshPrivateKeyEnc)
        if (knownHosts === undefined) knownHosts = creds?.sshKnownHosts
      }
      if (!privateKey) throw new Error('Upload or generate an SSH deploy key to test this connection.')
      deriveSshPublicKey(privateKey)
      return { sshKey: { privateKey, knownHosts: knownHosts?.trim() || undefined } }
    }
    default:
      return {}
  }
}

/** Operator-facing hint for the git/ssh failures a misconfigured credential produces. */
export function gitAuthHint(message: string): string | undefined {
  if (/host key verification failed|remote host identification has changed/i.test(message)) {
    return 'The SSH host key did not match the pinned known_hosts entry. Update or clear Known Hosts if the host key legitimately changed.'
  }
  if (/permission denied \(publickey/i.test(message)) {
    return 'The host rejected the SSH key. Register the public key on the repository (as a deploy key with write access if agents push).'
  }
  if (/HTTP Basic: Access denied|authentication failed/i.test(message)) {
    return 'The host rejected the token. Check it has not expired or been revoked, and that it has read_repository/write_repository scope.'
  }
  return undefined
}

/** `git ls-remote` with the resolved test credential. Throws with a hint on failure. */
export async function runConnectionTest(input: RepoTestConnectionInput): Promise<string> {
  const auth = await resolveTestAuth(input)
  try {
    const { result } = await withSshKey(auth.sshKey, (env) => testRepoConnection(input.url, toGitAuth(auth, env)))
    return result
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const hint = gitAuthHint(message)
    throw new Error(hint ? `${message}\n${hint}` : message, { cause: err })
  }
}
