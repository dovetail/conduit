import * as fs from 'fs'
import { diskFullMessage } from './gitOps'

/**
 * Shared data-volume fill helpers. Kept free of the runner/sweeper graph so
 * workers can refuse to start a run when the volume is already critically full
 * without creating an import cycle.
 */

export type DiskPressureLevel = 'ok' | 'warning' | 'critical'
export const DISK_WARNING_FRACTION = 0.8
export const DISK_CRITICAL_FRACTION = 0.9

/** Conservative default headroom for a repository worktree (1 GiB). */
export const DEFAULT_DISK_MIN_FREE_BYTES = 1024 ** 3
/** Alias for the default absolute reserve (overridable via `CONDUIT_DISK_MIN_FREE_BYTES`). */
export const DISK_MIN_FREE_BYTES = DEFAULT_DISK_MIN_FREE_BYTES

/**
 * Parse `CONDUIT_DISK_MIN_FREE_BYTES`. A valid non-negative integer overrides
 * the 1 GiB default; `0` disables the absolute reserve. Negative, fractional,
 * NaN, and empty values fall back to the default.
 */
export function resolveDiskMinFreeBytes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.CONDUIT_DISK_MIN_FREE_BYTES
  if (raw === undefined) return DEFAULT_DISK_MIN_FREE_BYTES
  const trimmed = raw.trim()
  if (trimmed === '') return DEFAULT_DISK_MIN_FREE_BYTES
  const n = Number(trimmed)
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) return DEFAULT_DISK_MIN_FREE_BYTES
  return n
}

/** Bucket a used-space fraction (0–1) into an alerting level. */
export function classifyDiskUsage(usedFraction: number): DiskPressureLevel {
  if (usedFraction >= DISK_CRITICAL_FRACTION) return 'critical'
  if (usedFraction >= DISK_WARNING_FRACTION) return 'warning'
  return 'ok'
}

export interface DiskPressure {
  totalBytes: number
  freeBytes: number
  usedFraction: number
}

/**
 * Combine percentage fill with an absolute free-byte reserve. Critical when
 * either the used fraction is at/above {@link DISK_CRITICAL_FRACTION} or
 * available space is below a non-zero reserve. A reserve of `0` disables the
 * absolute check so classification falls through to {@link classifyDiskUsage}.
 */
export function classifyDiskPressure(
  pressure: DiskPressure,
  minFreeBytes = resolveDiskMinFreeBytes()
): DiskPressureLevel {
  if (minFreeBytes > 0 && pressure.freeBytes < minFreeBytes) return 'critical'
  return classifyDiskUsage(pressure.usedFraction)
}

/**
 * Operator-facing capture copy. Reserve-only critical samples (used % below
 * the critical fraction, free bytes below the reserve) mention the reserve
 * explicitly; the shared `…% full (… MB free)` prefix keeps grouping stable.
 */
export function formatDiskPressureMessage(pressure: DiskPressure, minFreeBytes: number): string {
  const pct = Math.round(pressure.usedFraction * 100)
  const freeMb = Math.round(pressure.freeBytes / (1024 * 1024))
  const prefix = `Conduit data volume ${pct}% full (${freeMb} MB free)`
  const reserveOnly =
    minFreeBytes > 0 &&
    pressure.freeBytes < minFreeBytes &&
    classifyDiskUsage(pressure.usedFraction) !== 'critical'
  if (reserveOnly) {
    const reserveMb = Math.round(minFreeBytes / (1024 * 1024))
    return `${prefix} — free space is below the ${reserveMb} MB reserve; agent runs will fail with ENOSPC as it fills.`
  }
  return `${prefix} — agent runs will fail with ENOSPC as it fills.`
}

/**
 * Real filesystem usage of the volume backing `dir`, via `statfs`. `freeBytes`
 * uses blocks available to an unprivileged user. Never returns a fraction
 * outside [0, 1].
 */
export async function measureDiskPressure(dir: string): Promise<DiskPressure> {
  const st = await fs.promises.statfs(dir)
  const totalBytes = st.bsize * st.blocks
  const freeBytes = st.bsize * st.bavail
  const usedFraction =
    totalBytes > 0 ? Math.min(1, Math.max(0, (totalBytes - freeBytes) / totalBytes)) : 0
  return { totalBytes, freeBytes, usedFraction }
}

/**
 * Throw an operator-facing disk-full error when `dir`'s volume is critically
 * full by percentage or below the absolute reserve. A measurement failure is
 * ignored — we must not block runs because `statfs` is unavailable.
 */
export async function assertVolumeHasSpace(
  dir: string,
  action: string,
  minFreeBytes = resolveDiskMinFreeBytes()
): Promise<void> {
  let pressure: DiskPressure
  try {
    pressure = await measureDiskPressure(dir)
  } catch {
    return
  }
  if (classifyDiskPressure(pressure, minFreeBytes) === 'critical') {
    throw new Error(diskFullMessage(action))
  }
}
