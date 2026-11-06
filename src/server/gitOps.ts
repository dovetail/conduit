import { spawn } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'

/**
 * Redact any credentials embedded in a URL's userinfo (e.g.
 * `https://x-access-token:<token>@github.com/...`) before the string is logged,
 * stored as syncError, or broadcast to clients. git echoes the remote URL in
 * several failure modes, which would otherwise leak the PAT / installation token.
 */
export function redactCredentials(s: string): string {
  return s.replace(/(https?:\/\/)[^/@\s]+@/gi, '$1***@')
}

/**
 * Run a git command and return a promise that resolves on success
 * or rejects with stderr on failure.
 */
/**
 * Default wall-clock bound for a git invocation. A git process can hang forever
 * — blocked on a `.git` lock left by a crashed process, or (with no TTY) on a
 * credential prompt — and without a bound that hang propagates: a stuck
 * `git worktree remove` inside the data-dir sweep never resolves, and because
 * the sweep coalesces on one in-flight promise it silently disables ALL cleanup
 * (periodic, post-run, and the manual "Clean up now" button). Every git call
 * therefore runs under a timeout that SIGKILLs the child and rejects. The
 * default is generous enough for a large clone/fetch; callers whose op should be
 * fast (worktree remove/prune) pass a shorter `timeoutMs`.
 */
export const DEFAULT_GIT_TIMEOUT_MS = 10 * 60 * 1000 // 10 min

export function runGit(
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}
): Promise<string> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd: options.cwd,
      // Force git non-interactive: never block on a credential prompt. Without
      // this a git op against a private HTTPS remote with no usable credential
      // can hang waiting for a username (or, with stdin closed, fail with an
      // opaque "could not read Username"); either way it must fail fast and
      // deterministically, not stall. Caller env still wins if it sets these.
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        GCM_INTERACTIVE: 'never',
        ...options.env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    let settled = false

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      // SIGKILL (not SIGTERM): a git process wedged on a lock may ignore TERM.
      child.kill('SIGKILL')
      reject(new Error(redactCredentials(`git ${args[0]} timed out after ${timeoutMs}ms`)))
    }, timeoutMs)
    // Don't let a pending git timeout keep the event loop (or a test) alive.
    if (typeof timer.unref === 'function') timer.unref()

    child.stdout.on('data', (data: Buffer) => { stdout += data.toString() })
    child.stderr.on('data', (data: Buffer) => { stderr += data.toString() })

    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (code === 0) {
        resolve(stdout.trim())
      } else {
        reject(new Error(redactCredentials(`git ${args[0]} failed (exit ${code}): ${stderr.trim()}`)))
      }
    })

    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new Error(`Failed to spawn git: ${err.message}`))
    })
  })
}

/**
 * Inject a PAT into an HTTPS git URL for authentication.
 * Returns the URL unchanged if it's not HTTPS or no PAT is provided.
 */
export function buildAuthUrl(url: string, pat?: string): string {
  if (!pat || !url.startsWith('https://')) return url
  // Transform https://github.com/... → https://x-access-token:<pat>@github.com/...
  return url.replace('https://', `https://x-access-token:${pat}@`)
}

/**
 * Test connectivity to a remote repository via `git ls-remote`.
 * Returns the default branch ref on success, or throws on failure.
 */
export async function testRepoConnection(url: string, pat?: string): Promise<string> {
  const authUrl = buildAuthUrl(url, pat)
  const output = await runGit(['ls-remote', '--heads', authUrl])
  const refCount = output.split('\n').filter((l) => l.trim()).length
  return `Connected — ${refCount} branch${refCount !== 1 ? 'es' : ''} found`
}

/**
 * Clone a repository as a bare clone (no working tree).
 *
 * Clones into a sibling temp path, then atomically renames into place. A clone
 * that fails part-way — classically on bad credentials — otherwise leaves a
 * partial bare repo at the final path, which (a) leaks disk: the sweeper only
 * reclaims clones whose repository no longer exists, never a live repo's; and
 * (b) makes `clonePath` "exist", trapping the sync loop into fetching an invalid
 * repo forever instead of re-cloning. So the final path only ever appears once a
 * clone has fully succeeded, and any partial output is removed on failure.
 */
/**
 * Bare-clone temp paths (`<clonePath>.cloning`) currently being written by an
 * in-flight clone on this process. The data-dir sweeper consults this so it never
 * reclaims a clone temp that's actively being populated: a large clone can run
 * for minutes (longer than the sweep grace) and the temp dir's mtime doesn't
 * reflect deep writes, so time alone can't distinguish "in progress" from
 * "abandoned by a crash".
 */
const clonesInProgress = new Set<string>()

/** Clone temp paths currently in flight on this process (see {@link cloneRepo}). */
export function getClonesInProgress(): ReadonlySet<string> {
  return clonesInProgress
}

export async function cloneRepo(
  url: string,
  clonePath: string,
  branch: string,
  pat?: string
): Promise<void> {
  const authUrl = buildAuthUrl(url, pat)
  const tmpPath = `${clonePath}.cloning`
  clonesInProgress.add(tmpPath)
  try {
    // Clear any leftover from a previously-interrupted clone before starting.
    fs.rmSync(tmpPath, { recursive: true, force: true })
    try {
      await runGit(['clone', '--bare', '--single-branch', '--branch', branch, authUrl, tmpPath])
    } catch (err) {
      fs.rmSync(tmpPath, { recursive: true, force: true })
      throw err
    }
    // Publish the completed clone into its final location.
    fs.rmSync(clonePath, { recursive: true, force: true })
    fs.renameSync(tmpPath, clonePath)
  } finally {
    clonesInProgress.delete(tmpPath)
  }
}

/**
 * The refspec a bare-clone sync has to fetch with, for one branch.
 *
 * `git clone --bare` copies the remote's heads straight to local heads and, as
 * its own documentation states, creates "neither remote-tracking branches nor
 * the related configuration variables" — there is no `remote.origin.fetch`. A
 * plain `git fetch origin` in such a clone therefore has no refspec to apply: it
 * downloads objects, writes FETCH_HEAD, and leaves `refs/heads/<branch>` exactly
 * where the original clone left it. Sync reported success on every cycle while
 * the clone never moved, so every run worktreed the repository as it stood when
 * it was first added. Naming the destination explicitly is what actually
 * advances the branch; `+` keeps an upstream force-push from failing the sync.
 * Run worktrees are detached (see {@link createWorktree}), so this branch is
 * never checked out anywhere and updating it is always allowed.
 */
export function branchFetchRefspec(branch: string): string {
  return `+refs/heads/${branch}:refs/heads/${branch}`
}

/**
 * Point the stored `remote.origin.url` at the current credential — best-effort,
 * and only when it actually differs.
 *
 * The sync no longer depends on this (see {@link fetchRepo}), but other paths
 * read the stored remote: `git lfs fetch` inside a run's worktree resolves
 * `origin` from this same config, so a private LFS repo needs a usable token
 * there. It must never fail the sync, though, because rewriting `config` is the
 * step that breaks first when the data volume fills: git rewrites the whole file
 * through `config.lock`, so a failed write aborted the sync before git had even
 * tried to fetch — and an already-up-to-date repo needs no space at all.
 */
async function refreshStoredOriginUrl(clonePath: string, authUrl: string): Promise<void> {
  // `git config --get` exits non-zero when the key is unset; that's "differs".
  const stored = await runGit(['config', '--get', 'remote.origin.url'], { cwd: clonePath }).catch(
    () => undefined
  )
  if (stored === authUrl) return
  try {
    await runGit(['remote', 'set-url', 'origin', authUrl], { cwd: clonePath })
  } catch (err) {
    console.warn(
      `[gitOps] could not update the stored origin URL for ${clonePath}: ` +
        `${err instanceof Error ? err.message : String(err)}`
    )
  }
}

/**
 * Fetch latest changes for `branch` into a bare clone.
 *
 * The credential goes straight to the fetch as a URL instead of being written to
 * the clone's config first. Persisting it was the only reason a routine sync
 * wrote to `<clone>/config`, and that write also contends with the per-run
 * {@link configureWorktreeGit} calls, which land in the very same shared config
 * file; naming the URL per-invocation makes the fetch independent of both. (A
 * `-c remote.origin.url=…` override does *not* substitute here: `url` is a
 * multi-valued remote key, so a command-line value is appended to the stored
 * list rather than replacing it, and git still dials the stored URL first.)
 */
export async function fetchRepo(
  clonePath: string,
  url: string,
  branch: string,
  pat?: string
): Promise<void> {
  const authUrl = buildAuthUrl(url, pat)
  await refreshStoredOriginUrl(clonePath, authUrl)
  // No `--prune`: with an explicit refspec it would delete the clone's only
  // branch the moment the branch disappears upstream, leaving a clone nothing
  // can be worktreed from. Without it that case fails loudly ("couldn't find
  // remote ref") and the last good ref survives. A single-branch bare clone has
  // no other refs to prune anyway.
  await runGit(['fetch', authUrl, branchFetchRefspec(branch)], { cwd: clonePath })
}

/**
 * True when a git error indicates the filesystem is out of space.
 *
 * Most such failures carry an errno string ("No space left on device"), but
 * git's config writer does not: a failed write is reported through its
 * `write_error()` helper, which formats with `error()` rather than
 * `error_errno()`, so the errno is dropped and all the operator sees is
 *
 *   error: failed to write new configuration file /data/repos/<id>/config.lock
 *   fatal: could not set 'remote.origin.url' to 'https://***@github.com/…'
 *
 * That message is only reachable *after* git created and opened the lock file,
 * so it is neither a permission problem nor a stale lock — both of those fail
 * earlier with "could not lock config file". The write itself failed, which in
 * practice means the volume is full or over quota.
 */
export function isDiskFullError(message: string): boolean {
  return (
    /no space left on device|\bENOSPC\b/i.test(message) ||
    /not enough disk space/i.test(message) ||
    /failed to write new configuration file/i.test(message)
  )
}

/** Actionable operator-facing replacement for a raw git out-of-space dump. */
export function diskFullMessage(action: string): string {
  return (
    `Not enough disk space to ${action}. ` +
    'Free space on the Conduit server or increase its data volume, then retry.'
  )
}

/** True when a git error is `git gc` refusing to run because another gc holds
 *  the repo's `gc.pid` lock (exit 128, "gc is already running on machine …").
 *  Benign and self-healing: the other gc is already doing the compaction. */
export function isGcAlreadyRunningError(message: string): boolean {
  return /gc is already running/i.test(message)
}

/**
 * Create a git worktree from a bare clone for an isolated run workspace.
 *
 * `--detach` is essential, not cosmetic: git refuses to check out a branch that
 * is already checked out in another worktree, so a name-based
 * `git worktree add <path> master` fails the moment a second run of the same
 * repo overlaps the first — `fatal: 'master' is already checked out at …`. Each
 * run gets its own isolated worktree, but they all start from the same default
 * branch, so without `--detach` concurrent runs collide. Checking out the
 * branch's *commit* in detached HEAD gives every run identical starting content
 * with no shared branch ref to contend over; the agent creates its own branch to
 * commit and push on. (It also avoids leaking a per-run branch ref that
 * `git worktree remove` would not clean up.)
 *
 * If `git worktree add` fails part-way — classically because it ran out of disk
 * while checking out a large working tree — it leaves BOTH a partial checkout
 * and a registered worktree entry behind. Left in place those leak disk and
 * accumulate across failed runs, accelerating exhaustion until every run fails.
 * So on any failure we tear the partial worktree down before rethrowing, and we
 * translate an out-of-space failure into an actionable message (the raw git
 * error is a multi-kilobyte "Updating files:" progress dump).
 */
export async function createWorktree(
  clonePath: string,
  worktreePath: string,
  branch: string
): Promise<void> {
  try {
    await runGit(['worktree', 'add', '--detach', worktreePath, branch], { cwd: clonePath })
  } catch (err) {
    await removeWorktree(clonePath, worktreePath).catch(() => {})
    const message = err instanceof Error ? err.message : String(err)
    if (isDiskFullError(message)) {
      throw new Error(diskFullMessage('create a worktree for this repository'), { cause: err })
    }
    throw err instanceof Error ? err : new Error(message)
  }

  // Materialize git-LFS content. `git worktree add` on a bare single-branch clone
  // leaves LFS *pointer* files: the clone holds no LFS objects, and neither the
  // checkout smudge nor `git lfs pull` reliably fetches them for a bare-clone
  // worktree. The sequence that does (verified against a real LFS repo): fetch
  // the objects into the shared store — `--all` so a `fetch.exclude=*` config
  // can't suppress it — then check them out over the pointers. Without this a
  // repo with committed LFS assets (e.g. a Yarn zero-install `.yarn/cache`)
  // breaks the agent's `yarn install`/build and the run stalls (the failure this
  // fixes). Best-effort: a repo without LFS is a fast no-op and a host without
  // git-lfs just errors — neither should fail an otherwise-good worktree. Objects
  // land in the shared bare clone, so repeated worktrees don't re-download.
  try {
    await runGit(['lfs', 'fetch', '--all'], { cwd: worktreePath })
    await runGit(['lfs', 'checkout'], { cwd: worktreePath })
  } catch (err) {
    console.warn(
      `[gitOps] git-lfs materialization skipped for ${worktreePath}: ${err instanceof Error ? err.message : String(err)}`
    )
  }
}

/**
 * Configure a run worktree so the agent can commit and push:
 * - sets the committer identity (author name/email)
 * - points `origin` at a tokenized URL so `git push` authenticates
 *
 * `token` should be a freshly-resolved repo credential; for SSH/none repos pass
 * no token and the existing origin (SSH or plain) is left untouched.
 */
export async function configureWorktreeGit(
  worktreePath: string,
  opts: { url: string; token?: string; authorName: string; authorEmail: string }
): Promise<void> {
  await runGit(['config', 'user.name', opts.authorName], { cwd: worktreePath })
  await runGit(['config', 'user.email', opts.authorEmail], { cwd: worktreePath })
  if (opts.token && opts.url.startsWith('https://')) {
    await runGit(['remote', 'set-url', 'origin', buildAuthUrl(opts.url, opts.token)], { cwd: worktreePath })
  }
}

/**
 * Create a run worktree and configure its committer identity + push remote as a
 * single unit. If configuration fails *after* the worktree is created, the
 * worktree is torn down before rethrowing — otherwise a created-but-unconfigured
 * worktree (a multi-gigabyte checkout) is orphaned and reclaimed only by the slow
 * periodic sweeper, not the per-run cleanup. (`createWorktree` already cleans up
 * its own partial `worktree add` failure.)
 */
export async function createConfiguredWorktree(
  clonePath: string,
  worktreePath: string,
  branch: string,
  config: { url: string; token?: string; authorName: string; authorEmail: string }
): Promise<void> {
  await createWorktree(clonePath, worktreePath, branch)
  try {
    await configureWorktreeGit(worktreePath, config)
  } catch (err) {
    await removeWorktree(clonePath, worktreePath).catch(() => {})
    throw err
  }
}

/** Worktree remove/prune should be quick; bound them well under the default so a
 *  lock-wedged git can't stall a sweep for 10 minutes per leaked worktree. */
const WORKTREE_GIT_TIMEOUT_MS = 2 * 60 * 1000 // 2 min

/**
 * Remove a git worktree and guarantee the space is reclaimed — or throw.
 *
 * A worktree checkout of a large monorepo is gigabytes and ~30k files; leaving
 * one behind leaks disk. The prior version swallowed every failure, so when a
 * removal failed (a lock-wedged `git worktree remove` that hung with no timeout,
 * or an `fs.rmSync` that errored) the worktree silently persisted and the data
 * dir filled until runs crashed. Now: try git's own removal (deregisters the
 * admin entry cleanly), then force-delete the directory regardless, then prune
 * stale refs — all bounded by a timeout so nothing can hang. If the directory
 * still exists afterwards the space was NOT reclaimed; we throw so the caller
 * (the sweeper / per-run cleanup) reports it instead of leaking in silence.
 */
export async function removeWorktree(clonePath: string, worktreePath: string): Promise<void> {
  // 1. Prefer git's own removal — it also deregisters the worktree admin entry,
  //    so a later `git worktree add <branch>` won't hit "already checked out".
  await runGit(['worktree', 'remove', '--force', worktreePath], {
    cwd: clonePath,
    timeoutMs: WORKTREE_GIT_TIMEOUT_MS,
  }).catch(() => {
    /* fall through to a direct filesystem removal */
  })

  // 2. Whatever git did, make sure the directory is actually gone.
  if (fs.existsSync(worktreePath)) {
    try {
      fs.rmSync(worktreePath, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
    } catch {
      // Reported via the survival check below.
    }
  }

  // 3. Drop any stale admin ref a direct removal would leave behind (best-effort).
  await runGit(['worktree', 'prune'], { cwd: clonePath, timeoutMs: WORKTREE_GIT_TIMEOUT_MS }).catch(
    () => {}
  )

  // 4. Still present ⇒ space not reclaimed. Surface it — silent failure here is
  //    exactly how the volume filled.
  if (fs.existsSync(worktreePath)) {
    throw new Error(
      `Failed to remove worktree ${worktreePath}: directory still present after git and filesystem removal`
    )
  }
}

/**
 * List every git worktree registered against a bare clone, excluding the bare
 * repo itself. Uses `git worktree list --porcelain`, so it finds worktrees
 * wherever they live — including ones an agent created under `.claude/worktrees/`,
 * which a filesystem scan of `worktrees-run/` alone would miss. Returns [] if git
 * can't read the repo.
 */
export async function listWorktrees(clonePath: string): Promise<string[]> {
  let out: string
  try {
    out = await runGit(['worktree', 'list', '--porcelain'], {
      cwd: clonePath,
      timeoutMs: WORKTREE_GIT_TIMEOUT_MS,
    })
  } catch {
    return []
  }
  const paths: string[] = []
  for (const line of out.split('\n')) {
    if (!line.startsWith('worktree ')) continue
    const p = line.slice('worktree '.length).trim()
    // The bare repo lists itself; skip it — only the checkouts are reclaimable.
    if (p && p !== clonePath) paths.push(p)
  }
  return paths
}

export interface GcStats {
  /** Number of pack files — they accumulate one-per-fetch until a gc consolidates them. */
  packs: number
  /** Leftover git garbage (e.g. `tmp_pack_*` from an interrupted fetch). */
  hasGarbage: boolean
}

/**
 * Cheap probe of a bare clone's object store via `git count-objects -v`, used to
 * decide whether a `git gc` is worthwhile. Returns a benign zero result if git
 * can't read the repo (so gc is simply skipped).
 */
export async function getGcStats(clonePath: string): Promise<GcStats> {
  let out: string
  try {
    out = await runGit(['count-objects', '-v'], { cwd: clonePath, timeoutMs: WORKTREE_GIT_TIMEOUT_MS })
  } catch {
    return { packs: 0, hasGarbage: false }
  }
  let packs = 0
  let garbage = 0
  for (const line of out.split('\n')) {
    const idx = line.indexOf(':')
    if (idx === -1) continue
    const key = line.slice(0, idx).trim()
    const value = Number(line.slice(idx + 1).trim())
    if (key === 'packs') packs = Number.isFinite(value) ? value : 0
    else if (key === 'garbage') garbage = Number.isFinite(value) ? value : 0
  }
  return { packs, hasGarbage: garbage > 0 }
}

/** Bound for `git gc` — repacking a large monorepo clone takes a while, but a
 *  wedged gc must still never hang the sweep forever. */
const GC_TIMEOUT_MS = 10 * 60 * 1000 // 10 min
/** Only remove `objects/pack/tmp_*` files older than this — anything younger
 *  could be a live fetch's in-progress temp pack. */
const GC_TMP_MAX_AGE_MS = 60 * 60 * 1000 // 1 h

/**
 * Repack + prune a bare clone's object store, reclaiming two kinds of bloat:
 *  - accumulated per-fetch packs → `git gc` consolidates them (uses git's
 *    default prune window so a concurrent fetch's fresh objects are never pruned);
 *  - leftover git "garbage" temp packs (`objects/pack/tmp_*` from a crashed or
 *    timed-out fetch) → git gc does NOT remove these, so we delete the old ones
 *    ourselves (sparing any young enough to belong to a live operation).
 * Bounded by a timeout; throws on gc failure so the caller can report it —
 * with one exception. A gc that can't start because another gc holds the
 * repo's `gc.pid` lock ("gc is already running", e.g. a previous sweep's gc
 * still running or git's own auto-gc) is benign and self-healing: the other gc
 * is already doing the compaction. That case is skipped quietly — never
 * `--force`, which can corrupt the repo if gc genuinely is running — and the
 * boolean return tells the caller gc didn't happen this cycle (it retries on
 * the next sweep). Returns true when gc actually ran.
 */
export async function gcBareClone(clonePath: string): Promise<boolean> {
  // Cheap pre-check: `git gc` refuses to run while a `gc.pid` lock exists
  // (even a stale one), so don't spawn a doomed git. The catch below covers
  // the race — the lock appearing between this check and git's own attempt.
  if (fs.existsSync(path.join(clonePath, 'gc.pid'))) {
    console.log(`[gitOps] gc skipped for ${clonePath}: gc.pid lock present (another gc is running)`)
    return false
  }
  try {
    await runGit(['gc'], { cwd: clonePath, timeoutMs: GC_TIMEOUT_MS })
  } catch (err) {
    if (err instanceof Error && isGcAlreadyRunningError(err.message)) {
      console.log(`[gitOps] gc skipped for ${clonePath}: ${err.message}`)
      return false
    }
    throw err
  }
  const packDir = path.join(clonePath, 'objects', 'pack')
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(packDir, { withFileTypes: true })
  } catch {
    return true // gc ran; no pack dir / unreadable — nothing to prune
  }
  const cutoff = Date.now() - GC_TMP_MAX_AGE_MS
  for (const e of entries) {
    if (!e.name.startsWith('tmp_')) continue
    const p = path.join(packDir, e.name)
    try {
      if (fs.statSync(p).mtimeMs < cutoff) fs.rmSync(p, { recursive: true, force: true })
    } catch {
      /* best-effort: a file that vanished or is unreadable isn't our problem */
    }
  }
  return true
}
