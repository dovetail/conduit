import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { REPOS_DIR, DATA_DIR } from '../main/utils/paths'
import { removeWorktree, getClonesInProgress, listWorktrees, getGcStats, gcBareClone } from './gitOps'
import { deleteWorkspace } from '../main/execution/workspace'
import { getActiveWorkspacePaths, getActiveRunIds } from './runner'
import { getAllRepositoryIds } from '../main/db/queries/repositories'
import { reporter } from './observability'
import { deliveryCursorPath } from './runDeliveryLog'
import type { SweepResult, StorageUsage } from '../shared/types'
import {
  classifyDiskUsage,
  classifyDiskPressure,
  formatDiskPressureMessage,
  measureDiskPressure,
  resolveDiskMinFreeBytes,
  DISK_WARNING_FRACTION,
  DISK_CRITICAL_FRACTION,
  type DiskPressure,
  type DiskPressureLevel,
} from './diskPressure'

export {
  classifyDiskUsage,
  classifyDiskPressure,
  measureDiskPressure,
  DISK_WARNING_FRACTION,
  DISK_CRITICAL_FRACTION,
}
export type { DiskPressure, DiskPressureLevel }

/**
 * Periodic + on-demand cleaner for the data directory.
 *
 * Each agent run leaves behind run artifacts — a git worktree (a full checkout,
 * gigabytes for a large monorepo), and for repo-less runs an ephemeral temp
 * workspace plus a per-run MCP config file. Normally `cleanupRun` removes them a
 * few seconds after a run ends, but leaks happen (failed cleanup, a crashed/
 * evicted pod, or a run that dies between creating its worktree and registering
 * as active). Left unchecked these accumulate and exhaust the pod's disk.
 *
 * This sweeper reclaims that space. Its one hard invariant: **never delete an
 * artifact belonging to a run currently executing on this pod.** Two independent
 * guards enforce it — the live active-set from the runner, and a grace period
 * that spares very-recent artifacts (covering the brief window between a
 * worktree being created and its run registering as active).
 */

const DEFAULT_INTERVAL_MS = 10 * 60 * 1000 // 10 min
const DEFAULT_GRACE_MS = 5 * 60 * 1000 // 5 min
const DEFAULT_LOG_RETENTION_MS = 14 * 24 * 60 * 60 * 1000 // 14 days

function envMs(raw: string | undefined, fallback: number): number {
  const n = raw !== undefined ? Number(raw) : NaN
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

export const SWEEP_INTERVAL_MS = envMs(process.env.CONDUIT_SWEEP_INTERVAL_MS, DEFAULT_INTERVAL_MS)
export const SWEEP_GRACE_MS = envMs(process.env.CONDUIT_SWEEP_GRACE_MS, DEFAULT_GRACE_MS)
/** Run logs are history, so they survive far longer than other artifacts — but
 *  not forever, or `logs/` grows unbounded (the sweeper never touched it before,
 *  a silent leak). Logs older than this are reclaimable. */
export const LOG_RETENTION_MS = envMs(process.env.CONDUIT_LOG_RETENTION_MS, DEFAULT_LOG_RETENTION_MS)
/** Compact a live bare clone once it has this many pack files (one is added per
 *  fetch). A `git gc` consolidates them; after gc the count drops to ~1 so it
 *  won't run again until packs re-accumulate — making the sweep self-limiting. */
export const GC_PACK_THRESHOLD = envMs(process.env.CONDUIT_GC_PACK_THRESHOLD, 10)

/**
 * Everything on disk that belongs to one run log: the NDJSON itself plus the
 * delivery-cursor sidecar (and its atomic-write temp) a capped remote run may
 * have left next to it. Reclaiming a log must take all of them.
 */
export function runLogArtifactPaths(logPath: string): string[] {
  const cursor = deliveryCursorPath(logPath)
  return [logPath, cursor, `${cursor}.tmp`]
}

/** A candidate artifact considered for removal. */
export interface SweepEntry {
  /** Stable identifier (used for logging + tests). */
  key: string
  /** Last-modified time in epoch ms. */
  mtimeMs: number
  /** True when this artifact belongs to a run currently executing on this pod. */
  protectedByActive: boolean
}

/**
 * Pure decision core: from candidate entries, return exactly those safe to
 * remove — not tied to a live run, and older than the grace period. Kept free of
 * I/O so the safety logic is unit-testable in isolation.
 */
export function selectStale<T extends SweepEntry>(
  entries: T[],
  opts: { now: number; graceMs: number }
): T[] {
  return entries.filter((e) => !e.protectedByActive && opts.now - e.mtimeMs >= opts.graceMs)
}

// A run's ephemeral workspace is `conduit-<uuid>-<mkdtemp suffix>`; its MCP
// config is `conduit-mcp-<uuid>.json`. Match the uuid precisely so we never
// touch unrelated temp entries (and so workspaces aren't confused with configs).
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const WORKSPACE_DIR_RE = new RegExp(`^conduit-(${UUID})-`, 'i')
const MCP_CONFIG_RE = new RegExp(`^conduit-mcp-(${UUID})\\.json$`, 'i')

export type TmpEntryKind = 'workspace' | 'mcpConfig' | 'other'

/**
 * Classify a temp-dir entry name as a Conduit run artifact. Deliberately strict
 * (matches the exact `conduit-<uuid>-…` / `conduit-mcp-<uuid>.json` shapes) so
 * the sweeper never touches unrelated temp files. The MCP-config check is tried
 * first because `conduit-mcp-…` also starts with `conduit-`.
 */
export function classifyTmpEntry(name: string): { kind: TmpEntryKind; runId?: string } {
  const mcp = MCP_CONFIG_RE.exec(name)
  if (mcp) return { kind: 'mcpConfig', runId: mcp[1] }
  const ws = WORKSPACE_DIR_RE.exec(name)
  if (ws) return { kind: 'workspace', runId: ws[1] }
  return { kind: 'other' }
}

/**
 * Total size in bytes of everything under `root`, walked recursively. Async
 * (uses `fs.promises`) so a multi-gigabyte monorepo checkout never blocks the
 * event loop. Symlinks are not followed — this avoids double-counting and
 * symlink loops. Unreadable entries and a missing root are swallowed (counted
 * as 0) so a size estimate can never throw.
 */
export async function dirSizeBytes(root: string): Promise<number> {
  let entries: fs.Dirent[]
  try {
    entries = await fs.promises.readdir(root, { withFileTypes: true })
  } catch {
    return 0 // missing/unreadable dir → contributes nothing
  }
  let total = 0
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue
    const p = path.join(root, entry.name)
    if (entry.isDirectory()) {
      total += await dirSizeBytes(p)
    } else if (entry.isFile()) {
      try {
        total += (await fs.promises.lstat(p)).size
      } catch {
        // unreadable/removed mid-walk → skip
      }
    }
  }
  return total
}

/** Size of a single file in bytes; 0 if it's gone/unreadable. */
async function fileSizeBytes(p: string): Promise<number> {
  try {
    return (await fs.promises.lstat(p)).size
  } catch {
    return 0
  }
}

const execFileAsync = promisify(execFile)

/**
 * Disk usage of a directory tree in bytes. Prefers the native `du -sk`, which
 * runs in a child process (off the Node event loop) and is orders of magnitude
 * faster than a JS walk on a large checkout — a data dir can hold hundreds of
 * thousands of files across many worktrees. Falls back to the in-process
 * {@link dirSizeBytes} walker when `du` is unavailable (e.g. Windows), times out,
 * or errors. Never throws — a size estimate must never crash the sweeper.
 *
 * Note: `du` reports block-allocated disk usage (rounded up per file), which is
 * the honest "space on disk" figure; the JS fallback reports the logical byte
 * sum. Both are fine for a human-facing usage display.
 */
export async function measureDirBytes(dir: string): Promise<number> {
  try {
    const { stdout } = await execFileAsync('du', ['-sk', dir], {
      timeout: 120_000,
      maxBuffer: 1024 * 1024,
    })
    const kb = parseInt(stdout.trim().split(/\s+/)[0], 10)
    if (Number.isFinite(kb)) return kb * 1024
  } catch {
    // `du` missing/failed/timed out → fall back to the in-process walker.
  }
  return dirSizeBytes(dir)
}

function safeMtimeMs(p: string): number {
  try {
    return fs.statSync(p).mtimeMs
  } catch {
    return 0 // unreadable → treat as old (past grace) so it can be cleaned
  }
}

function listDir(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

/** A discovered candidate paired with the filesystem path it lives at. */
export interface SweepCandidate extends SweepEntry {
  path: string
}

/** A worktree candidate also carries its clone path, needed to remove it. */
export interface WorktreeCandidate extends SweepCandidate {
  clonePath: string
}

/** The artifact categories the sweeper considers, freshly discovered. */
export interface SweepCandidates {
  worktrees: WorktreeCandidate[]
  workspaces: SweepCandidate[]
  mcpConfigs: SweepCandidate[]
  /** Run-log files (logs/<runId>.jsonl), pruned on the long retention window. */
  logs: SweepCandidate[]
  /** Bare clones (repos/<id>) whose repository no longer exists — orphans only. */
  bareClones: SweepCandidate[]
  /** Leftover clone temp dirs (repos/<id>.cloning) from an interrupted clone. */
  cloningTmp: SweepCandidate[]
  /** Bare clones (repos/<id>) whose repository still exists — eligible for gc. */
  liveClonePaths: string[]
}

/** Overrides for the directories/active-sets scanned — injected in tests. */
export interface SweepScanOptions {
  reposDir?: string
  tmpDir?: string
  logsDir?: string
  activePaths?: Set<string>
  activeRunIds?: Set<string>
  /** IDs of repositories that still exist. A bare clone under repos/<id> whose id
   *  is NOT in this set is an orphan a sweep may reclaim. Omitted ⇒ bare clones
   *  are left untouched — the safe default: never delete a clone we can't verify. */
  knownRepoIds?: Set<string>
  /** Absolute paths of clone temp dirs an in-flight clone is writing on this pod;
   *  such a `.cloning` dir is spared. Omitted ⇒ read from the live gitOps set. */
  activeClonePaths?: Set<string>
  /** Enumerate a bare clone's registered worktrees. Omitted ⇒ the live gitOps
   *  `git worktree list`. Injected in tests to avoid spawning git. */
  listWorktrees?: (clonePath: string) => Promise<string[]>
}

/**
 * Discover every removable run artifact under the repos + temp directories,
 * tagging each with its mtime and whether it belongs to a live run. This is the
 * single source of truth for "what the sweeper considers": both `runSweep`
 * (which removes the stale subset) and `estimateStorageUsage` (which sizes it)
 * consume it, so the reclaimable estimate can never disagree with what a sweep
 * actually frees.
 */
export async function collectSweepCandidates(opts: SweepScanOptions = {}): Promise<SweepCandidates> {
  const reposDir = opts.reposDir ?? REPOS_DIR
  const tmpDir = opts.tmpDir ?? os.tmpdir()
  // Derive the logs dir from reposDir's parent so an injected (test) data dir
  // stays isolated and never scans the real ~/.conduit/logs.
  const logsDir = opts.logsDir ?? path.join(path.dirname(reposDir), 'logs')
  const activePaths = opts.activePaths ?? getActiveWorkspacePaths()
  const activeRunIds = opts.activeRunIds ?? getActiveRunIds()
  const knownRepoIds = opts.knownRepoIds
  const activeClonePaths = opts.activeClonePaths ?? getClonesInProgress()
  const listWt = opts.listWorktrees ?? listWorktrees

  // 1. Git worktrees (Conduit's under worktrees-run/ plus any an agent created,
  //    e.g. .claude/worktrees/*), orphaned bare clones (repos/<id> whose repo is
  //    gone), leftover clone temp dirs (repos/<id>.cloning), and the live clones
  //    (repo still exists) that are eligible for gc.
  const worktrees: WorktreeCandidate[] = []
  const bareClones: SweepCandidate[] = []
  const cloningTmp: SweepCandidate[] = []
  const liveClonePaths: string[] = []
  for (const repoEntry of listDir(reposDir)) {
    if (!repoEntry.isDirectory()) continue
    const repoId = repoEntry.name
    // A leftover clone temp (repos/<id>.cloning) from an interrupted clone — not a
    // real bare clone. Reclaimable unless an in-flight clone is writing it.
    if (repoId.endsWith('.cloning')) {
      const p = path.join(reposDir, repoId)
      cloningTmp.push({
        key: p,
        path: p,
        mtimeMs: safeMtimeMs(p),
        protectedByActive: activeClonePaths.has(p),
      })
      continue
    }
    const clonePath = path.join(reposDir, repoId)
    const worktreesDir = path.join(clonePath, 'worktrees-run')
    // A live run occupies this clone when an active worktree sits under it. Used
    // both to spare a whole clone's bare removal and to spare agent-created
    // worktrees, which aren't individually tracked in the active set.
    const cloneHasActiveRun = [...activePaths].some(
      (ap) => ap === clonePath || ap.startsWith(clonePath + path.sep)
    )
    // Union of worktrees found on disk under worktrees-run/ (robust even if git's
    // admin is broken) and every worktree git knows about (catches ones an agent
    // created elsewhere, e.g. .claude/worktrees/*, that the sweeper used to miss).
    const worktreePaths = new Set<string>()
    for (const e of listDir(worktreesDir)) {
      if (e.isDirectory()) worktreePaths.add(path.join(worktreesDir, e.name))
    }
    for (const p of await listWt(clonePath)) worktreePaths.add(p)
    for (const p of worktreePaths) {
      const isRunDir = p === worktreesDir || p.startsWith(worktreesDir + path.sep)
      worktrees.push({
        key: p,
        path: p,
        clonePath,
        mtimeMs: safeMtimeMs(p),
        // Conduit's own run worktrees use the precise active set. Agent-created
        // worktrees aren't tracked individually, so spare them whenever the clone
        // has any live run rather than risk removing one mid-run.
        protectedByActive: activePaths.has(p) || (!isRunDir && cloneHasActiveRun),
      })
    }
    // A bare clone is reclaimable only when we KNOW its repo is gone (id absent
    // from knownRepoIds) and no live run sits under it; when the repo still
    // exists it's a live clone eligible for gc.
    if (knownRepoIds && !knownRepoIds.has(repoId)) {
      bareClones.push({
        key: clonePath,
        path: clonePath,
        mtimeMs: safeMtimeMs(clonePath),
        protectedByActive: cloneHasActiveRun,
      })
    } else if (knownRepoIds) {
      liveClonePaths.push(clonePath)
    }
  }

  // 2 & 3. Temp-dir artifacts: ephemeral workspaces + per-run MCP configs.
  const workspaces: SweepCandidate[] = []
  const mcpConfigs: SweepCandidate[] = []
  for (const entry of listDir(tmpDir)) {
    const cls = classifyTmpEntry(entry.name)
    if (cls.kind === 'other') continue
    const p = path.join(tmpDir, entry.name)
    if (cls.kind === 'mcpConfig' && entry.isFile()) {
      mcpConfigs.push({
        key: p,
        path: p,
        mtimeMs: safeMtimeMs(p),
        protectedByActive: activeRunIds.has(cls.runId!),
      })
    } else if (cls.kind === 'workspace' && entry.isDirectory()) {
      workspaces.push({
        key: p,
        path: p,
        mtimeMs: safeMtimeMs(p),
        protectedByActive: activePaths.has(p),
      })
    }
  }

  // 4. Run logs: logs/<runId>.jsonl. Pruned on the long retention window (not the
  //    short grace) since they are the run history. The delivery-cursor sidecar
  //    is not a candidate of its own — it is reclaimed with its log.
  const logs: SweepCandidate[] = []
  for (const e of listDir(logsDir)) {
    if (!e.isFile() || !e.name.endsWith('.jsonl')) continue
    const runId = e.name.slice(0, -'.jsonl'.length)
    const p = path.join(logsDir, e.name)
    logs.push({
      key: p,
      path: p,
      mtimeMs: safeMtimeMs(p),
      protectedByActive: activeRunIds.has(runId),
    })
  }

  return { worktrees, workspaces, mcpConfigs, logs, bareClones, cloningTmp, liveClonePaths }
}

/**
 * The set of repository IDs that still exist, for bare-clone reclamation. Never
 * throws: if the DB is unavailable the sweep simply skips bare clones this pass
 * (returning `undefined`) rather than risk deleting a clone it can't verify.
 */
async function safeKnownRepoIds(): Promise<Set<string> | undefined> {
  try {
    return new Set(await getAllRepositoryIds())
  } catch (err) {
    reporter.captureException(err, { tags: { component: 'dataDirSweeper', op: 'knownRepoIds' } })
    return undefined
  }
}

let inFlightSweep: Promise<SweepResult> | null = null

/**
 * Run one sweep now, coalescing concurrent callers. Startup, the periodic timer,
 * the per-run-finish hook, and the manual Settings trigger can all fire close
 * together; they share a single in-flight sweep rather than scanning redundantly.
 */
export function sweepOnce(now: number = Date.now()): Promise<SweepResult> {
  if (inFlightSweep) return inFlightSweep
  inFlightSweep = runSweep(now).finally(() => {
    inFlightSweep = null
  })
  return inFlightSweep
}

/**
 * Scan the three artifact categories, remove stale ones, and return/log a
 * summary. Never throws — per-entry failures are swallowed so one bad entry
 * can't abort the sweep.
 */
async function runSweep(now: number): Promise<SweepResult> {
  const knownRepoIds = await safeKnownRepoIds()
  const { worktrees, workspaces, mcpConfigs, logs, bareClones, cloningTmp, liveClonePaths } =
    await collectSweepCandidates({ knownRepoIds })
  const result: SweepResult = {
    worktreesRemoved: 0,
    workspacesRemoved: 0,
    mcpConfigsRemoved: 0,
    logsRemoved: 0,
    bareClonesRemoved: 0,
    cloningTmpRemoved: 0,
    reposCompacted: 0,
  }

  // 1. Git worktrees: reposDir/<repoId>/worktrees-run/<uuid>
  for (const stale of selectStale(worktrees, { now, graceMs: SWEEP_GRACE_MS })) {
    try {
      await removeWorktree(stale.clonePath, stale.path)
      if (!fs.existsSync(stale.path)) result.worktreesRemoved++
    } catch (err) {
      reporter.captureException(err, { tags: { component: 'dataDirSweeper', op: 'worktree' } })
    }
  }

  // 2 & 3. Temp-dir artifacts: ephemeral workspaces + per-run MCP configs.
  for (const stale of selectStale(workspaces, { now, graceMs: SWEEP_GRACE_MS })) {
    deleteWorkspace(stale.path) // swallows its own errors
    if (!fs.existsSync(stale.path)) result.workspacesRemoved++
  }
  for (const stale of selectStale(mcpConfigs, { now, graceMs: SWEEP_GRACE_MS })) {
    try {
      fs.rmSync(stale.path, { force: true })
      result.mcpConfigsRemoved++
    } catch (err) {
      reporter.captureException(err, { tags: { component: 'dataDirSweeper', op: 'mcpConfig' } })
    }
  }

  // 4. Expired run logs (retention window, not the short grace).
  for (const stale of selectStale(logs, { now, graceMs: LOG_RETENTION_MS })) {
    try {
      for (const artifact of runLogArtifactPaths(stale.path)) fs.rmSync(artifact, { force: true })
      result.logsRemoved++
    } catch (err) {
      reporter.captureException(err, { tags: { component: 'dataDirSweeper', op: 'log' } })
    }
  }

  // 5. Orphaned bare clones (repository deleted). Short grace so a clone still
  //    mid-registration is never reaped.
  for (const stale of selectStale(bareClones, { now, graceMs: SWEEP_GRACE_MS })) {
    try {
      fs.rmSync(stale.path, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
      if (!fs.existsSync(stale.path)) result.bareClonesRemoved++
    } catch (err) {
      reporter.captureException(err, { tags: { component: 'dataDirSweeper', op: 'bareClone' } })
    }
  }

  // 6. Leftover clone temp dirs (repos/<id>.cloning) from a clone interrupted by a
  //    crash. An in-flight clone's temp is spared (protectedByActive); the short
  //    grace covers one that just started but hasn't registered as active yet.
  for (const stale of selectStale(cloningTmp, { now, graceMs: SWEEP_GRACE_MS })) {
    try {
      fs.rmSync(stale.path, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
      if (!fs.existsSync(stale.path)) result.cloningTmpRemoved++
    } catch (err) {
      reporter.captureException(err, { tags: { component: 'dataDirSweeper', op: 'cloningTmp' } })
    }
  }

  // 7. Compact live bare clones that have accumulated per-fetch packs or leftover
  //    git garbage (e.g. tmp_pack_* from a crashed fetch). Skip any with a clone
  //    in flight; bounded + self-limiting (after gc, packs drop below threshold).
  const activeClonePaths = getClonesInProgress()
  for (const clonePath of liveClonePaths) {
    if (activeClonePaths.has(`${clonePath}.cloning`)) continue
    try {
      const stats = await getGcStats(clonePath)
      if (stats.hasGarbage || stats.packs >= GC_PACK_THRESHOLD) {
        // False when another gc holds the repo's lock — a benign skip, not a
        // compaction (and nothing to report; the next sweep retries).
        if (await gcBareClone(clonePath)) result.reposCompacted++
      }
    } catch (err) {
      reporter.captureException(err, { tags: { component: 'dataDirSweeper', op: 'gc' } })
    }
  }

  const total =
    result.worktreesRemoved +
    result.workspacesRemoved +
    result.mcpConfigsRemoved +
    result.logsRemoved +
    result.bareClonesRemoved +
    result.cloningTmpRemoved +
    result.reposCompacted
  if (total > 0) {
    console.log(
      `[dataDirSweeper] Removed ${result.worktreesRemoved} worktree(s), ` +
        `${result.workspacesRemoved} workspace(s), ${result.mcpConfigsRemoved} MCP config(s), ` +
        `${result.logsRemoved} log(s), ${result.bareClonesRemoved} bare clone(s), ` +
        `${result.cloningTmpRemoved} clone temp(s); compacted ${result.reposCompacted} clone(s).`
    )
  }
  // A sweep changes on-disk sizes; drop the cached usage so the next read (and
  // the Settings query the client refetches after a manual sweep) is accurate.
  invalidateStorageUsageCache()
  return result
}

/** Overrides for `estimateStorageUsage` — injected in tests. */
export interface StorageScanOptions extends SweepScanOptions {
  now?: number
  dataDir?: string
  /** Directory sizer (default: `du`-backed {@link measureDirBytes}). */
  measureDir?: (p: string) => Promise<number>
  /** File sizer (default: {@link fileSizeBytes}). */
  measureFile?: (p: string) => Promise<number>
}

/**
 * Estimate how much disk Conduit is using, for the Settings storage display.
 *
 * `totalBytes` sizes the whole data directory (db, logs, and repos — including
 * every worktree) plus the Conduit temp artifacts, which live *outside* the data
 * dir in the OS temp dir. `reclaimableBytes` sizes only the artifacts a sweep-now
 * would actually remove — the same `selectStale` subset `runSweep` deletes — so
 * it is always a subset of the total and always matches the "Clean up now"
 * button. Never throws: the sizers swallow per-entry errors.
 *
 * This is the raw computation (a ~15s `du` over a large data dir); callers on
 * the request path should go through the cached {@link getStorageUsage}.
 */
export async function estimateStorageUsage(opts: StorageScanOptions = {}): Promise<StorageUsage> {
  const now = opts.now ?? Date.now()
  const dataDir = opts.dataDir ?? DATA_DIR
  const measureDir = opts.measureDir ?? measureDirBytes
  const measureFile = opts.measureFile ?? fileSizeBytes
  // Resolve known repo IDs (for orphaned-clone sizing) only in production — tests
  // inject an explicit reposDir and stay DB-free.
  const knownRepoIds =
    opts.knownRepoIds ?? (opts.reposDir === undefined ? await safeKnownRepoIds() : undefined)
  const { worktrees, workspaces, mcpConfigs, logs, bareClones, cloningTmp } = await collectSweepCandidates({
    ...opts,
    knownRepoIds,
  })

  // Total: the full data directory + the temp artifacts (which sit outside it).
  // The data dir already contains logs/ and repos/ (clones), so those aren't
  // added again here.
  let totalBytes = await measureDir(dataDir)
  for (const w of workspaces) totalBytes += await measureDir(w.path)
  for (const m of mcpConfigs) totalBytes += await measureFile(m.path)

  // Reclaimable: exactly the stale set a sweep-now would free.
  const graceMs = SWEEP_GRACE_MS
  const reclaimableClones = selectStale(bareClones, { now, graceMs })
  // An orphaned clone is removed wholesale, so its worktrees are already covered
  // by the clone's size — don't count them a second time.
  const orphanClonePaths = new Set(reclaimableClones.map((c) => c.path))
  let reclaimableBytes = 0
  for (const wt of selectStale(worktrees, { now, graceMs })) {
    if (orphanClonePaths.has(wt.clonePath)) continue
    reclaimableBytes += await measureDir(wt.path)
  }
  for (const ws of selectStale(workspaces, { now, graceMs })) reclaimableBytes += await measureDir(ws.path)
  for (const mc of selectStale(mcpConfigs, { now, graceMs })) reclaimableBytes += await measureFile(mc.path)
  for (const lg of selectStale(logs, { now, graceMs: LOG_RETENTION_MS })) reclaimableBytes += await measureFile(lg.path)
  for (const bc of reclaimableClones) reclaimableBytes += await measureDir(bc.path)
  for (const ct of selectStale(cloningTmp, { now, graceMs })) reclaimableBytes += await measureDir(ct.path)

  return { totalBytes, reclaimableBytes }
}

/**
 * Cached, coalesced accessor for {@link estimateStorageUsage}. The underlying
 * walk is a multi-second `du` over the entire data directory, far too slow to
 * run on every Settings open, so the result is cached for {@link STORAGE_CACHE_TTL_MS}
 * and concurrent callers share a single in-flight computation. A sweep calls
 * {@link invalidateStorageUsageCache} so the next read reflects the freed space.
 *
 * `compute` is injectable for tests; production uses the real estimate.
 */
export const STORAGE_CACHE_TTL_MS = 60_000

let usageCache: StorageUsage | null = null
let usageCacheAt = 0
let usageInFlight: Promise<StorageUsage> | null = null

export function getStorageUsage(
  now: number = Date.now(),
  compute: () => Promise<StorageUsage> = () => estimateStorageUsage()
): Promise<StorageUsage> {
  if (usageCache && now - usageCacheAt < STORAGE_CACHE_TTL_MS) return Promise.resolve(usageCache)
  if (usageInFlight) return usageInFlight
  usageInFlight = compute()
    .then((value) => {
      usageCache = value
      usageCacheAt = now
      return value
    })
    .finally(() => {
      usageInFlight = null
    })
  return usageInFlight
}

/** Drop the cached usage so the next {@link getStorageUsage} recomputes. */
export function invalidateStorageUsageCache(): void {
  usageCache = null
  usageCacheAt = 0
}

/** Warm the cache in the background (fire-and-forget) — errors are swallowed. */
export function warmStorageUsage(): void {
  getStorageUsage().catch((err) =>
    reporter.captureException(err, { tags: { component: 'dataDirSweeper', op: 'warmUsage' } })
  )
}

// ── Disk-pressure telemetry ─────────────────────────────────────────────────
//
// Even with the sweeper working, the data volume can fill (a burst of runs, a
// leak the sweeper can't reach, an oversized clone). When it does, `git worktree
// add` dies with ENOSPC and every run crashes — with no prior warning. These
// helpers surface fill level to the error reporter *before* that happens, so the
// operator sees "80% full" instead of only the eventual crash.

const DISK_LEVEL_RANK: Record<DiskPressureLevel, number> = { ok: 0, warning: 1, critical: 2 }

/** Alert only when disk pressure rises to a higher level. Returning to a lower
 *  level re-arms the next escalation so a later climb is reported again. */
export function shouldEscalateDisk(previous: DiskPressureLevel, next: DiskPressureLevel): boolean {
  return DISK_LEVEL_RANK[next] > DISK_LEVEL_RANK[previous]
}

let lastDiskLevel: DiskPressureLevel = 'ok'

/** Test helper: restore the module-level last-seen disk level to `ok`. */
export function resetReportedDiskLevel(): void {
  lastDiskLevel = 'ok'
}

/**
 * Measure the data volume and emit telemetry: always a breadcrumb (so any later
 * event carries the fill level), plus a warning/error `captureMessage` only when
 * pressure escalates past {@link DISK_WARNING_FRACTION}/{@link DISK_CRITICAL_FRACTION}
 * or the absolute reserve. Fire-and-forget; never throws.
 */
export async function reportDiskPressure(
  dir: string = DATA_DIR,
  minFreeBytes = resolveDiskMinFreeBytes()
): Promise<DiskPressure | null> {
  let pressure: DiskPressure
  try {
    pressure = await measureDiskPressure(dir)
  } catch (err) {
    reporter.captureException(err, { tags: { component: 'dataDirSweeper', op: 'diskPressure' } })
    return null
  }
  const level = classifyDiskPressure(pressure, minFreeBytes)
  const pct = Math.round(pressure.usedFraction * 100)
  const freeMb = Math.round(pressure.freeBytes / (1024 * 1024))
  reporter.addBreadcrumb({
    category: 'disk',
    message: `data volume ${pct}% used, ${freeMb} MB free`,
    level: level === 'critical' ? 'error' : level === 'warning' ? 'warning' : 'info',
    data: { ...pressure, level, minFreeBytes },
  })
  if (shouldEscalateDisk(lastDiskLevel, level)) {
    reporter.captureMessage(formatDiskPressureMessage(pressure, minFreeBytes), level === 'critical' ? 'error' : 'warning', {
      tags: { component: 'dataDirSweeper', op: 'diskPressure', level },
      extra: { ...pressure, minFreeBytes },
    })
  }
  lastDiskLevel = level
  return pressure
}

/**
 * Background service: one immediate sweep on start (reclaiming anything left by a
 * previous process), then a sweep every `intervalMs`.
 */
export class DataDirSweeper {
  private intervalId: NodeJS.Timeout | null = null

  start(intervalMs: number = SWEEP_INTERVAL_MS): void {
    // Run the initial sweep, then warm the storage-usage cache once it has
    // finished (the sweep invalidates the cache at its end, so warming after it
    // avoids a race and makes the first Settings view instant).
    sweepOnce()
      .catch((err) =>
        reporter.captureException(err, { tags: { component: 'dataDirSweeper', op: 'startup' } })
      )
      .finally(() => {
        warmStorageUsage()
        void reportDiskPressure()
      })
    this.intervalId = setInterval(() => {
      sweepOnce().catch((err) =>
        reporter.captureException(err, { tags: { component: 'dataDirSweeper', op: 'periodic' } })
      )
      void reportDiskPressure()
    }, intervalMs)
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId)
      this.intervalId = null
    }
  }
}
