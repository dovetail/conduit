import * as fs from 'fs'
import { listRepositories, getRepository, updateRepository } from '../main/db/queries/repositories'
import { cloneRepo, fetchRepo, isDiskFullError, diskFullMessage } from './gitOps'
import { missingCredentialMessage, resolveRepoAuth, toGitAuth, type ResolvedRepoAuth } from './repoAuth'
import { gitAuthHint } from './repoCredentials'
import { withSshKey } from './sshKey'
import { DEV_CONTEXT } from './auth/config'
import { reporter } from './observability'
import type { BroadcastFn } from './runner'
import type { RepoSyncStatus, Repository, RepositoryInput } from '../shared/types'

const SYNC_BACKOFF_BASE_MS = 10 * 60 * 1000 // 10 min
const SYNC_BACKOFF_MAX_MS = 4 * 60 * 60 * 1000 // 4 h
const REPO_AUTH_FAILED_MESSAGE =
  'Repository authentication failed. Update the repository credentials, then retry synchronization.'

/** Per-repo consecutive-failure state driving the retry backoff. */
export interface SyncFailureState {
  count: number
  /** Epoch ms before which this repo should not be retried. */
  nextAttemptAt: number
}

/** Exponential backoff delay for the Nth consecutive sync failure (base 10 min,
 *  doubling, capped at 4 h). Prevents a repo that can't clone/fetch — typically
 *  bad credentials — from being retried every 5-min cycle forever. */
export function computeSyncBackoffMs(consecutiveFailures: number): number {
  const n = Math.max(1, consecutiveFailures)
  return Math.min(SYNC_BACKOFF_BASE_MS * 2 ** (n - 1), SYNC_BACKOFF_MAX_MS)
}

/** Advance the failure streak, computing when the repo may next be attempted. */
export function nextSyncBackoff(prev: SyncFailureState | undefined, now: number): SyncFailureState {
  const count = (prev?.count ?? 0) + 1
  return { count, nextAttemptAt: now + computeSyncBackoffMs(count) }
}

/** True while a repo is still inside its backoff window and must be skipped. */
export function isInSyncBackoff(state: SyncFailureState | undefined, now: number): boolean {
  return state !== undefined && now < state.nextAttemptAt
}

/** True when a git/auth error message is a rejected credential, not a transient fault. */
export function isRepoAuthenticationError(message: string): boolean {
  return /authentication failed|invalid username or token|could not read username|repository not found|HTTP Basic: Access denied|permission denied \(publickey|host key verification failed/i.test(
    message
  )
}

/** Auth-relevant repository updates should force an immediate sync retry. */
export function repositoryUpdateNeedsSync(
  input: Partial<RepositoryInput>,
  stored: Pick<Repository, 'url' | 'authMethod' | 'githubAppId' | 'sshKnownHosts'>
): boolean {
  if (input.githubPrivateKey || input.gitlabToken?.trim() || input.sshPrivateKey?.trim()) return true
  return (
    (input.url !== undefined && input.url !== stored.url) ||
    (input.authMethod !== undefined && input.authMethod !== stored.authMethod) ||
    (input.githubAppId !== undefined && input.githubAppId !== stored.githubAppId) ||
    (input.sshKnownHosts !== undefined &&
      (input.sshKnownHosts.trim() || undefined) !== (stored.sshKnownHosts?.trim() || undefined))
  )
}

/** How to describe the failed sync step in an operator-facing message. */
function syncAction(op: string): string {
  return op === 'clone' ? 'clone this repository' : 'sync this repository'
}

/**
 * Background service that keeps repository clones up-to-date.
 */
export class RepoSyncService {
  private intervalId: NodeJS.Timeout | null = null
  private syncInProgress = new Set<string>()
  /** Consecutive-failure backoff, keyed by repoId. Cleared on success or a
   *  manual retry (triggerSync). */
  private failures = new Map<string, SyncFailureState>()
  /** At most one forced retry waiting for the current in-flight sync to finish. */
  private queuedForce = new Map<string, { promise: Promise<void>; resolve: () => void; reject: (err: unknown) => void }>()
  private broadcast: BroadcastFn

  constructor(broadcast: BroadcastFn) {
    this.broadcast = broadcast
  }

  start(intervalMs: number = 5 * 60 * 1000): void {
    // Stale-worktree cleanup is owned by DataDirSweeper (startup + periodic +
    // post-run + manual); RepoSyncService only keeps the bare clones in sync.
    this.syncAll().catch((err) => console.error('[repoSync] Initial sync failed:', err))
    this.intervalId = setInterval(() => {
      this.syncAll().catch((err) => console.error('[repoSync] Periodic sync failed:', err))
    }, intervalMs)
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId)
      this.intervalId = null
    }
    const err = new Error('Repository synchronization stopped')
    for (const queued of this.queuedForce.values()) {
      queued.reject(err)
    }
    this.queuedForce.clear()
  }

  async syncAll(): Promise<void> {
    const repos = await listRepositories(DEV_CONTEXT.userId, DEV_CONTEXT.userGroupIds)
    for (const repo of repos) {
      this.syncRepo(repo.id).catch((err) =>
        console.error(`[repoSync] Unexpected error syncing repo ${repo.id}:`, err)
      )
    }
  }

  async triggerSync(repoId: string): Promise<void> {
    // A manual retry is an explicit "try now" — clear any backoff so a repo the
    // user just fixed (e.g. corrected credentials) syncs immediately.
    this.failures.delete(repoId)
    if (this.syncInProgress.has(repoId)) {
      return this.enqueueForcedRetry(repoId)
    }
    await this.syncRepo(repoId, true)
  }

  private enqueueForcedRetry(repoId: string): Promise<void> {
    const existing = this.queuedForce.get(repoId)
    if (existing) return existing.promise
    let resolve!: () => void
    let reject!: (err: unknown) => void
    const promise = new Promise<void>((res, rej) => {
      resolve = () => res()
      reject = rej
    })
    this.queuedForce.set(repoId, { promise, resolve, reject })
    return promise
  }

  async syncRepo(repoId: string, force = false): Promise<void> {
    if (this.syncInProgress.has(repoId)) return
    this.syncInProgress.add(repoId)

    let attemptError: unknown
    try {
      await this.runSyncAttempt(repoId, force)
    } catch (err) {
      attemptError = err
    } finally {
      this.syncInProgress.delete(repoId)
    }

    await this.drainForcedRetry(repoId)
    if (attemptError !== undefined) throw attemptError
  }

  private async drainForcedRetry(repoId: string): Promise<void> {
    const queued = this.queuedForce.get(repoId)
    if (!queued) return
    this.queuedForce.delete(repoId)
    try {
      await this.syncRepo(repoId, true)
      queued.resolve()
    } catch (err) {
      queued.reject(err)
    }
  }

  private async runSyncAttempt(repoId: string, force: boolean): Promise<void> {
    const repo = await getRepository(repoId)
    if (!repo || !repo.clonePath) return

    // A repo that keeps failing (bad credentials, unreachable remote) must not
    // be retried every 5-min cycle — that hammered GitHub and flooded Sentry
    // with 284 identical clone failures/day. Skip until its backoff elapses.
    // A forced retry (manual or queued after an in-flight attempt) tries now.
    if (!force && isInSyncBackoff(this.failures.get(repoId), Date.now())) return

    // Rejected credentials are terminal until the operator retries or updates
    // auth config. Persist across restarts via the sanitized syncError prefix.
    if (
      !force &&
      repo.syncStatus === 'error' &&
      repo.syncError?.startsWith('Repository authentication failed.')
    ) {
      return
    }

    // Credential resolution can throw (e.g. GitHub App misconfigured, or a
    // stored secret that no longer decrypts). Treat it as a sync failure so it
    // also backs off, rather than escaping to syncAll.
    let auth: ResolvedRepoAuth
    try {
      auth = await resolveRepoAuth(repo)
    } catch (err) {
      await this.recordSyncFailure(repoId, err, 'auth')
      return
    }

    // A repo that declares an auth method but resolves no credential must NOT
    // be cloned unauthenticated: git then fails every attempt with "could not
    // read Username", which (before backoff) hammered GitHub and flooded Sentry
    // with hundreds of identical errors. Fail fast with an actionable reason.
    // This is an expected user misconfiguration, not an app bug — mark it
    // expected so it's recorded against the repo but not reported as an error.
    const missing = missingCredentialMessage(repo, auth)
    if (missing) {
      await this.recordSyncFailure(repoId, new Error(missing), 'auth', { expected: true })
      return
    }

    const needsClone = repo.syncStatus === 'pending' || !fs.existsSync(repo.clonePath)
    const op = needsClone ? 'clone' : 'fetch'
    await this.updateStatus(repoId, needsClone ? 'cloning' : 'syncing')
    try {
      const { learnedKnownHosts } = await withSshKey(auth.sshKey, (env) =>
        needsClone
          ? cloneRepo(repo.url, repo.clonePath!, repo.defaultBranch, toGitAuth(auth, env))
          : fetchRepo(repo.clonePath!, repo.url, repo.defaultBranch, toGitAuth(auth, env))
      )
      // Trust on first use: pin the host key ssh accepted on this first
      // contact, so every later connection (syncs and runs) checks it strictly.
      if (learnedKnownHosts) await updateRepository(repoId, { sshKnownHosts: learnedKnownHosts })
      await this.recordSyncSuccess(repoId)
    } catch (err) {
      await this.recordSyncFailure(repoId, err, op)
    }
  }

  /** Clear the failure streak and mark the repo ready. */
  private async recordSyncSuccess(repoId: string): Promise<void> {
    this.failures.delete(repoId)
    await updateRepository(repoId, {
      syncStatus: 'ready',
      lastSyncedAt: Date.now(),
      syncError: undefined,
    })
    await this.broadcastStatus(repoId)
  }

  /**
   * Advance the backoff streak, persist the error, and report to Sentry ONLY on
   * the first failure of a streak — a persistently-broken repo then produces one
   * event, not one every cycle. The DB `syncError` still reflects each attempt.
   *
   * `expected` failures are user-fixable misconfigurations (e.g. a PAT-auth repo
   * with no global PAT configured): the owner sees them via `syncError`, so they
   * go out as a warning-level message instead of an error-level exception.
   *
   * An out-of-space failure is reported as a message rather than an exception:
   * the raw git text embeds the clone's path, which splinters one operational
   * problem into a separate Sentry issue per repository. The raw text is kept as
   * context.
   */
  private async recordSyncFailure(
    repoId: string,
    err: unknown,
    op: string,
    opts?: { expected?: boolean }
  ): Promise<void> {
    const prev = this.failures.get(repoId)
    this.failures.set(repoId, nextSyncBackoff(prev, Date.now()))
    const raw = err instanceof Error ? err.message : String(err)
    const diskFull = isDiskFullError(raw)
    const authFailed = isRepoAuthenticationError(raw)
    const message = diskFull
      ? diskFullMessage(syncAction(op))
      : authFailed
        ? [REPO_AUTH_FAILED_MESSAGE, gitAuthHint(raw)].filter(Boolean).join(' ')
        : raw
    if (!prev) {
      const tags = { component: 'repoSync', repoId, op }
      if (opts?.expected) {
        reporter.captureMessage(message, 'warning', { tags })
      } else if (diskFull) {
        reporter.captureMessage(message, 'error', { tags, extra: { gitError: raw } })
      } else if (authFailed) {
        reporter.captureMessage(message, 'warning', {
          tags: { ...tags, failureKind: 'authentication' },
        })
      } else {
        reporter.captureException(err, { tags })
      }
    }
    await updateRepository(repoId, { syncStatus: 'error', syncError: message })
    await this.broadcastStatus(repoId)
  }

  /** Update the sync status in DB and broadcast to clients. */
  private async updateStatus(repoId: string, syncStatus: RepoSyncStatus): Promise<void> {
    await updateRepository(repoId, { syncStatus })
    await this.broadcastStatus(repoId)
  }

  /** Broadcast the current status of a repo to all WebSocket clients. */
  private async broadcastStatus(repoId: string): Promise<void> {
    const repo = await getRepository(repoId)
    if (!repo) return
    this.broadcast('repo:syncStatus', {
      repoId,
      syncStatus: repo.syncStatus,
      syncError: repo.syncError,
      lastSyncedAt: repo.lastSyncedAt,
    })
  }
}
