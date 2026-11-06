import { describe, it, expect, vi, afterEach } from 'vitest'

const { statfs } = vi.hoisted(() => ({ statfs: vi.fn() }))
vi.mock('fs', () => ({
  promises: { statfs },
}))

import {
  classifyDiskUsage,
  measureDiskPressure,
  assertVolumeHasSpace,
  DISK_CRITICAL_FRACTION,
  DEFAULT_DISK_MIN_FREE_BYTES,
  resolveDiskMinFreeBytes,
  classifyDiskPressure,
  formatDiskPressureMessage,
  type DiskPressure,
} from './diskPressure'

afterEach(() => {
  statfs.mockReset()
})

describe('classifyDiskUsage', () => {
  it('is ok well below the warning threshold', () => {
    expect(classifyDiskUsage(0)).toBe('ok')
    expect(classifyDiskUsage(0.5)).toBe('ok')
    expect(classifyDiskUsage(0.79)).toBe('ok')
  })

  it('warns from 80% and goes critical from 90%', () => {
    expect(classifyDiskUsage(0.8)).toBe('warning')
    expect(classifyDiskUsage(0.89)).toBe('warning')
    expect(classifyDiskUsage(DISK_CRITICAL_FRACTION)).toBe('critical')
    expect(classifyDiskUsage(0.99)).toBe('critical')
  })
})

describe('resolveDiskMinFreeBytes', () => {
  it('defaults to 1 GiB when CONDUIT_DISK_MIN_FREE_BYTES is unset', () => {
    expect(resolveDiskMinFreeBytes({})).toBe(1_073_741_824)
    expect(resolveDiskMinFreeBytes({})).toBe(DEFAULT_DISK_MIN_FREE_BYTES)
  })

  it('overrides the default with a valid non-negative integer', () => {
    expect(resolveDiskMinFreeBytes({ CONDUIT_DISK_MIN_FREE_BYTES: '2097152' })).toBe(2_097_152)
  })

  it('treats 0 as a disabled absolute reserve', () => {
    expect(resolveDiskMinFreeBytes({ CONDUIT_DISK_MIN_FREE_BYTES: '0' })).toBe(0)
  })

  it('falls back to the default for negative, fractional, NaN, and empty values', () => {
    expect(resolveDiskMinFreeBytes({ CONDUIT_DISK_MIN_FREE_BYTES: '-1' })).toBe(DEFAULT_DISK_MIN_FREE_BYTES)
    expect(resolveDiskMinFreeBytes({ CONDUIT_DISK_MIN_FREE_BYTES: '1.5' })).toBe(DEFAULT_DISK_MIN_FREE_BYTES)
    expect(resolveDiskMinFreeBytes({ CONDUIT_DISK_MIN_FREE_BYTES: 'NaN' })).toBe(DEFAULT_DISK_MIN_FREE_BYTES)
    expect(resolveDiskMinFreeBytes({ CONDUIT_DISK_MIN_FREE_BYTES: '' })).toBe(DEFAULT_DISK_MIN_FREE_BYTES)
  })

  it('falls back to the default for space, tab, and newline-only values', () => {
    expect(resolveDiskMinFreeBytes({ CONDUIT_DISK_MIN_FREE_BYTES: ' ' })).toBe(DEFAULT_DISK_MIN_FREE_BYTES)
    expect(resolveDiskMinFreeBytes({ CONDUIT_DISK_MIN_FREE_BYTES: '\t' })).toBe(DEFAULT_DISK_MIN_FREE_BYTES)
    expect(resolveDiskMinFreeBytes({ CONDUIT_DISK_MIN_FREE_BYTES: '\n' })).toBe(DEFAULT_DISK_MIN_FREE_BYTES)
    expect(resolveDiskMinFreeBytes({ CONDUIT_DISK_MIN_FREE_BYTES: ' \t\n' })).toBe(DEFAULT_DISK_MIN_FREE_BYTES)
  })
})

describe('classifyDiskPressure', () => {
  const pressure = (usedFraction: number, freeBytes: number): DiskPressure => ({
    totalBytes: 10_000,
    freeBytes,
    usedFraction,
  })

  it('is critical when free bytes are below a non-zero reserve', () => {
    expect(classifyDiskPressure(pressure(0.5, 500), 1024)).toBe('critical')
  })

  it('delegates to percentage classification when the reserve is satisfied', () => {
    expect(classifyDiskPressure(pressure(0.5, 2000), 1024)).toBe('ok')
    expect(classifyDiskPressure(pressure(0.85, 2000), 1024)).toBe('warning')
    expect(classifyDiskPressure(pressure(0.95, 2000), 1024)).toBe('critical')
  })

  it('ignores the absolute reserve when it is disabled (0)', () => {
    expect(classifyDiskPressure(pressure(0.5, 500), 0)).toBe('ok')
    expect(classifyDiskPressure(pressure(0.91, 500), 0)).toBe('critical')
  })
})

describe('formatDiskPressureMessage', () => {
  const pressure = (usedFraction: number, freeBytes: number): DiskPressure => ({
    totalBytes: 10 * 1024 ** 3,
    freeBytes,
    usedFraction,
  })

  it('mentions low free space and the reserve when percentage is not critical', () => {
    const msg = formatDiskPressureMessage(pressure(0.5, 100 * 1024 * 1024), 1024 ** 3)
    expect(msg).toMatch(/50%/)
    expect(msg).toMatch(/100 MB/)
    expect(msg).toMatch(/free space/i)
    expect(msg).toMatch(/reserve/i)
    expect(msg).toMatch(/1024 MB/)
  })

  it('keeps the percentage-full wording when used space is already critical', () => {
    const msg = formatDiskPressureMessage(pressure(0.95, 8 * 1024 ** 3), 1024 ** 3)
    expect(msg).toMatch(/95% full/)
    expect(msg).toMatch(/8192 MB free/)
    expect(msg).not.toMatch(/reserve/i)
  })
})

describe('measureDiskPressure', () => {
  it('computes used fraction from statfs blocks', async () => {
    statfs.mockResolvedValue({ bsize: 1024, blocks: 100, bavail: 10 })
    const p = await measureDiskPressure('/data')
    expect(p.totalBytes).toBe(1024 * 100)
    expect(p.freeBytes).toBe(1024 * 10)
    expect(p.usedFraction).toBeCloseTo(0.9)
  })
})

describe('assertVolumeHasSpace', () => {
  it('throws an operator-facing message when the volume is critically full', async () => {
    statfs.mockResolvedValue({ bsize: 1024, blocks: 100, bavail: 5 })
    await expect(assertVolumeHasSpace('/data', 'start this run', 0)).rejects.toThrow(
      /Not enough disk space to start this run/
    )
  })

  it('does not block a run when statfs fails', async () => {
    statfs.mockRejectedValue(new Error('ENOENT'))
    await expect(assertVolumeHasSpace('/missing', 'start this run')).resolves.toBeUndefined()
  })

  it('rejects a run below 90% used when free bytes are under the absolute reserve', async () => {
    // 50% used, 50 KiB free — percentage-ok, but below the default 1 GiB reserve.
    statfs.mockResolvedValue({ bsize: 1024, blocks: 100, bavail: 50 })
    await expect(assertVolumeHasSpace('/data', 'start this run')).rejects.toThrow(
      /Not enough disk space to start this run/
    )
  })

  it('permits the same filesystem when the absolute reserve is disabled', async () => {
    statfs.mockResolvedValue({ bsize: 1024, blocks: 100, bavail: 50 })
    await expect(assertVolumeHasSpace('/data', 'start this run', 0)).resolves.toBeUndefined()
  })
})
