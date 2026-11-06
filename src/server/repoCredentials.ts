import { encryptSecret } from './crypto'
import { mintInstallationToken, resolveRepoToken } from './githubApp'
import { getGithubPat } from './store'
import type { RepositoryInput, RepoTestConnectionInput } from '../shared/types'

/**
 * Convert a client-facing repository payload into the persistence-layer shape:
 * the raw GitHub App private key (write-only) is encrypted into
 * `githubPrivateKeyEnc`. An absent/blank key is dropped so the stored key is
 * left untouched on update.
 */
export function withEncryptedKey<T extends Partial<RepositoryInput>>(
  data: T
): Omit<T, 'githubPrivateKey'> & { githubPrivateKeyEnc?: string } {
  const { githubPrivateKey, ...rest } = data
  const result = { ...rest } as Omit<T, 'githubPrivateKey'> & { githubPrivateKeyEnc?: string }
  if (typeof githubPrivateKey === 'string' && githubPrivateKey.trim()) {
    result.githubPrivateKeyEnc = encryptSecret(githubPrivateKey.trim())
  }
  return result
}

/**
 * Resolve the credential token for a connection test. For GitHub App auth this
 * mints from the PEM supplied in the form, or — when none is supplied — falls
 * back to the key already stored for an existing repo.
 */
export async function resolveTestToken(input: RepoTestConnectionInput): Promise<string | undefined> {
  switch (input.authMethod) {
    case 'pat':
      return getGithubPat()
    case 'githubapp':
      if (input.githubPrivateKey && input.githubPrivateKey.trim()) {
        if (!input.githubAppId) throw new Error('A GitHub App ID is required.')
        return mintInstallationToken({
          // Trim to match how the key is stored (encryptSecret trims) so a
          // successful test reflects the value that will actually be persisted.
          appId: input.githubAppId,
          privateKey: input.githubPrivateKey.trim(),
          repoUrl: input.url,
        })
      }
      if (input.repoId) {
        return resolveRepoToken({ id: input.repoId, url: input.url, authMethod: 'githubapp' })
      }
      throw new Error('Upload a GitHub App private key to test this connection.')
    default:
      return undefined
  }
}
