import { authUrlMismatch, cloneUrlProblem } from '@shared/repoUrl'
import type { Repository, RepoAuthMethod, RepositoryInput, RepoTestConnectionInput } from '@shared/types'

export interface RepoFormState {
  name: string
  url: string
  defaultBranch: string
  authMethod: RepoAuthMethod
  githubAppId: string
  /** Newly-uploaded PEM this session — empty means "leave the stored key untouched". */
  githubPrivateKey: string
  /** Whether the repo already has a stored GitHub App key. */
  hasGithubKey: boolean
  /** Newly-entered GitLab token — empty means "leave the stored token untouched". */
  gitlabToken: string
  hasGitlabToken: boolean
  /** Newly-uploaded/generated SSH private key — empty means "leave the stored key untouched". */
  sshPrivateKey: string
  hasSshKey: boolean
  /** Public half of the stored or new key, for registering on the host. */
  sshPublicKey: string
  sshKeyFingerprint: string
  sshKnownHosts: string
  commitAuthorName: string
  commitAuthorEmail: string
}

export function emptyRepoForm(): RepoFormState {
  return {
    name: '',
    url: '',
    defaultBranch: 'main',
    authMethod: 'none',
    githubAppId: '',
    githubPrivateKey: '',
    hasGithubKey: false,
    gitlabToken: '',
    hasGitlabToken: false,
    sshPrivateKey: '',
    hasSshKey: false,
    sshPublicKey: '',
    sshKeyFingerprint: '',
    sshKnownHosts: '',
    commitAuthorName: '',
    commitAuthorEmail: '',
  }
}

export function repoFormFromRepo(repo: Repository): RepoFormState {
  return {
    name: repo.name,
    url: repo.url,
    defaultBranch: repo.defaultBranch,
    authMethod: repo.authMethod,
    githubAppId: repo.githubAppId ?? '',
    githubPrivateKey: '',
    hasGithubKey: !!repo.hasGithubKey,
    gitlabToken: '',
    hasGitlabToken: !!repo.hasGitlabToken,
    sshPrivateKey: '',
    hasSshKey: !!repo.hasSshKey,
    sshPublicKey: repo.sshPublicKey ?? '',
    sshKeyFingerprint: repo.sshKeyFingerprint ?? '',
    sshKnownHosts: repo.sshKnownHosts ?? '',
    commitAuthorName: repo.commitAuthorName ?? '',
    commitAuthorEmail: repo.commitAuthorEmail ?? '',
  }
}

/** Build the create/update payload, including credential fields only for the selected method. */
export function repoFormToInput(form: RepoFormState): RepositoryInput {
  const base: RepositoryInput = {
    name: form.name.trim(),
    url: form.url.trim(),
    defaultBranch: form.defaultBranch.trim(),
    authMethod: form.authMethod,
    commitAuthorName: form.commitAuthorName.trim() || undefined,
    commitAuthorEmail: form.commitAuthorEmail.trim() || undefined,
  }
  if (form.authMethod === 'githubapp') {
    base.githubAppId = form.githubAppId.trim()
    if (form.githubPrivateKey) base.githubPrivateKey = form.githubPrivateKey
  }
  if (form.authMethod === 'gitlab' && form.gitlabToken.trim()) {
    base.gitlabToken = form.gitlabToken.trim()
  }
  if (form.authMethod === 'sshkey') {
    if (form.sshPrivateKey) base.sshPrivateKey = form.sshPrivateKey
    base.sshKnownHosts = form.sshKnownHosts.trim()
  }
  return base
}

/** Test Connection payload: new credentials from the form, else the stored ones via `repoId`. */
export function repoFormToTestInput(form: RepoFormState, repoId?: string): RepoTestConnectionInput {
  return {
    url: form.url.trim(),
    authMethod: form.authMethod,
    githubAppId: form.githubAppId.trim() || undefined,
    githubPrivateKey: form.githubPrivateKey || undefined,
    gitlabToken: form.authMethod === 'gitlab' ? form.gitlabToken.trim() || undefined : undefined,
    sshPrivateKey: form.authMethod === 'sshkey' ? form.sshPrivateKey || undefined : undefined,
    sshKnownHosts: form.authMethod === 'sshkey' ? form.sshKnownHosts.trim() : undefined,
    repoId,
  }
}

/**
 * Inline hint when the URL can't be used — the server enforces the same rules.
 * The URL-shape check applies only once the URL is edited, matching the server,
 * so a legacy URL with embedded credentials doesn't block unrelated edits.
 */
export function repoUrlProblem(form: Pick<RepoFormState, 'url' | 'authMethod'>, savedUrl?: string): string | undefined {
  if (!form.url.trim()) return undefined
  const shapeProblem = form.url.trim() === savedUrl?.trim() ? undefined : cloneUrlProblem(form.url)
  return shapeProblem ?? authUrlMismatch(form.url, form.authMethod)
}

/** Whether the selected method has the credential it needs (new or already stored). */
export function repoCredentialsPresent(form: RepoFormState): boolean {
  switch (form.authMethod) {
    case 'githubapp':
      return !!form.githubAppId.trim() && (form.hasGithubKey || !!form.githubPrivateKey)
    case 'gitlab':
      return form.hasGitlabToken || !!form.gitlabToken.trim()
    case 'sshkey':
      return form.hasSshKey || !!form.sshPrivateKey
    default:
      return true
  }
}
