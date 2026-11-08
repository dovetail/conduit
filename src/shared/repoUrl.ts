import type { RepoAuthMethod } from './types'

/** Methods whose credential is a token injected into an HTTPS clone URL. */
export const TOKEN_AUTH_METHODS: readonly RepoAuthMethod[] = ['pat', 'githubapp', 'gitlab']

/** True for scp-style (`git@host:path`) or `ssh://` clone URLs. */
export function isSshUrl(url: string): boolean {
  const s = url.trim()
  if (/^ssh:\/\//i.test(s)) return true
  return !s.includes('://') && /^[^@\s/]+@[^:\s/]+:.+/.test(s)
}

/**
 * Why `url` can't work with `authMethod`, or undefined when it can. Token
 * methods inject into an HTTPS URL; a deploy key only applies to an SSH URL.
 */
export function authUrlMismatch(url: string, authMethod: RepoAuthMethod): string | undefined {
  const s = url.trim()
  if (TOKEN_AUTH_METHODS.includes(authMethod) && !s.startsWith('https://')) {
    return `Auth method "${authMethod}" needs an https:// clone URL.`
  }
  if (authMethod === 'sshkey' && !isSshUrl(s)) {
    return 'SSH deploy keys need an SSH clone URL, e.g. git@gitlab.com:group/project.git or ssh://git@host/path.git.'
  }
  return undefined
}

/**
 * Why `url` is not an acceptable clone URL, or undefined. Credentials embedded
 * in an http(s) URL are refused: they would be stored and returned in plain
 * text instead of encrypted, and would collide with the injected token.
 */
export function cloneUrlProblem(url: string): string | undefined {
  const s = url.trim()
  let parsed: URL
  try {
    parsed = new URL(s)
  } catch {
    return isSshUrl(s) ? undefined : `"${s}" is not a valid clone URL.`
  }
  if (/^https?:$/.test(parsed.protocol) && (parsed.username || parsed.password)) {
    return 'Do not embed credentials in the URL; choose an auth method and enter its credential instead.'
  }
  return undefined
}
