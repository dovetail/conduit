import * as fs from 'fs'
import * as path from 'path'
import { listRepositories, getRepository, updateRepository } from '../main/db/queries/repositories'
import { cloneRepo, fetchRepo, removeWorktree } from './gitOps'
import { getGithubPat } from './store'
import type { BroadcastFn } from './runner'
import type { RepoSyncStatus } from '../shared/types'

/**
 * Background service that keeps repository clones up-to-date.
 */
export class RepoSyncService {
  private intervalId: NodeJS.Timeout | null = null
  private syncInProgress = new Set<string>()
  private broadcast: BroadcastFn

  constructor(broadcast: BroadcastFn) {
    this.broadcast = broadcast
  }

  start(intervalMs: number = 5 * 60 * 1000): void {
    this.cleanupStaleWorktrees().catch((err) =>
      console.error('[repoSync] cleanupStaleWorktrees failed:', err)
    )
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
  }

  async syncAll(): Promise<void> {
    const repos = await listRepositories()
    for (const repo of repos) {
      this.syncRepo(repo.id).catch((err) =>
        console.error(`[repoSync] Unexpected error syncing repo ${repo.id}:`, err)
      )
    }
  }

  async triggerSync(repoId: string): Promise<void> {
    await this.syncRepo(repoId)
  }

  async syncRepo(repoId: string): Promise<void> {
    if (this.syncInProgress.has(repoId)) return
    this.syncInProgress.add(repoId)

    try {
      const repo = await getRepository(repoId)
      if (!repo || !repo.clonePath) return

      const pat = repo.authMethod === 'pat' ? getGithubPat() : undefined

      const needsClone = repo.syncStatus === 'pending' || !fs.existsSync(repo.clonePath)

      if (needsClone) {
        await this.updateStatus(repoId, 'cloning')
        try {
          await cloneRepo(repo.url, repo.clonePath, repo.defaultBranch, pat)
          await updateRepository(repoId, {
            syncStatus: 'ready',
            lastSyncedAt: Date.now(),
            syncError: undefined,
          })
          await this.broadcastStatus(repoId)
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          await updateRepository(repoId, { syncStatus: 'error', syncError: message })
          await this.broadcastStatus(repoId)
        }
      } else {
        await this.updateStatus(repoId, 'syncing')
        try {
          await fetchRepo(repo.clonePath, repo.url, pat)
          await updateRepository(repoId, {
            syncStatus: 'ready',
            lastSyncedAt: Date.now(),
            syncError: undefined,
          })
          await this.broadcastStatus(repoId)
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          await updateRepository(repoId, { syncStatus: 'error', syncError: message })
          await this.broadcastStatus(repoId)
        }
      }
    } finally {
      this.syncInProgress.delete(repoId)
    }
  }

  private async updateStatus(repoId: string, syncStatus: RepoSyncStatus): Promise<void> {
    await updateRepository(repoId, { syncStatus })
    await this.broadcastStatus(repoId)
  }

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

  private async cleanupStaleWorktrees(): Promise<void> {
    const repos = await listRepositories()
    for (const repo of repos) {
      if (!repo.clonePath) continue
      const worktreeRunDir = path.join(repo.clonePath, 'worktrees-run')
      if (!fs.existsSync(worktreeRunDir)) continue

      try {
        const entries = fs.readdirSync(worktreeRunDir, { withFileTypes: true })
        for (const entry of entries) {
          if (!entry.isDirectory()) continue
          const worktreePath = path.join(worktreeRunDir, entry.name)
          console.log(`[repoSync] Cleaning up stale worktree: ${worktreePath}`)
          removeWorktree(repo.clonePath, worktreePath).catch((err) =>
            console.error(`[repoSync] Failed to clean up worktree ${worktreePath}:`, err)
          )
        }
      } catch {
        // Ignore errors reading the directory
      }
    }
  }
}
