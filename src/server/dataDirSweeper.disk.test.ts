import { describe, it, expect, vi, beforeEach } from 'vitest'

const { reporter } = vi.hoisted(() => ({
  reporter: {
    captureException: vi.fn(),
    captureMessage: vi.fn(),
    addBreadcrumb: vi.fn(),
  },
}))

// Keep loading dataDirSweeper free of real I/O / the runner graph (same pattern
// as dataDirSweeper.test.ts).
vi.mock('./runner', () => ({
  getActiveWorkspacePaths: () => new Set<string>(),
  getActiveRunIds: () => new Set<string>(),
}))
vi.mock('./gitOps', () => ({ removeWorktree: vi.fn(async () => {}) }))
vi.mock('../main/execution/workspace', () => ({ deleteWorkspace: vi.fn(() => {}) }))
vi.mock('./observability', () => ({ reporter }))
vi.mock('../main/utils/paths', () => ({ REPOS_DIR: '/nonexistent-repos', DATA_DIR: '/nonexistent-data' }))

const { measureDiskPressure } = vi.hoisted(() => ({
  measureDiskPressure: vi.fn(),
}))
vi.mock('./diskPressure', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./diskPressure')>()
  return { ...actual, measureDiskPressure }
})

import {
  classifyDiskUsage,
  reportDiskPressure,
  shouldEscalateDisk,
  resetReportedDiskLevel,
} from './dataDirSweeper'

beforeEach(() => {
  reporter.captureException.mockReset()
  reporter.captureMessage.mockReset()
  reporter.addBreadcrumb.mockReset()
  measureDiskPressure.mockReset()
  resetReportedDiskLevel()
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
    expect(classifyDiskUsage(0.9)).toBe('critical')
    expect(classifyDiskUsage(0.99)).toBe('critical')
  })
})

describe('measureDiskPressure', () => {
  it('returns sane real filesystem stats for an existing directory', async () => {
    const { measureDiskPressure: realMeasure } = await vi.importActual<typeof import('./diskPressure')>(
      './diskPressure'
    )
    const p = await realMeasure(process.cwd())
    expect(p.totalBytes).toBeGreaterThan(0)
    expect(p.freeBytes).toBeGreaterThanOrEqual(0)
    expect(p.usedFraction).toBeGreaterThanOrEqual(0)
    expect(p.usedFraction).toBeLessThanOrEqual(1)
  })
})

describe('shouldEscalateDisk', () => {
  it('alerts on upward transitions', () => {
    expect(shouldEscalateDisk('ok', 'warning')).toBe(true)
    expect(shouldEscalateDisk('warning', 'critical')).toBe(true)
  })

  it('does not re-alert at the same level or on recovery', () => {
    expect(shouldEscalateDisk('critical', 'critical')).toBe(false)
    expect(shouldEscalateDisk('critical', 'warning')).toBe(false)
    expect(shouldEscalateDisk('warning', 'warning')).toBe(false)
  })
})

describe('reportDiskPressure', () => {
  const PINNED_MIN_FREE = 0
  const sample = (usedFraction: number, freeBytes = 8 * 1024 ** 3) => ({
    totalBytes: 10 * 1024 ** 3,
    freeBytes,
    usedFraction,
  })

  it('emits a breadcrumb every sample but messages only on upward transitions', async () => {
    measureDiskPressure.mockResolvedValueOnce(sample(0.5))
    await reportDiskPressure('/data', PINNED_MIN_FREE)
    expect(reporter.addBreadcrumb).toHaveBeenCalledTimes(1)
    expect(reporter.captureMessage).not.toHaveBeenCalled()

    measureDiskPressure.mockResolvedValueOnce(sample(0.85))
    await reportDiskPressure('/data', PINNED_MIN_FREE)
    expect(reporter.addBreadcrumb).toHaveBeenCalledTimes(2)
    expect(reporter.captureMessage).toHaveBeenCalledTimes(1)
    expect(reporter.captureMessage.mock.calls[0][1]).toBe('warning')
    expect(reporter.captureMessage.mock.calls[0][2].extra).toEqual(
      expect.objectContaining({ minFreeBytes: PINNED_MIN_FREE })
    )

    measureDiskPressure.mockResolvedValueOnce(sample(0.85))
    await reportDiskPressure('/data', PINNED_MIN_FREE)
    expect(reporter.addBreadcrumb).toHaveBeenCalledTimes(3)
    expect(reporter.captureMessage).toHaveBeenCalledTimes(1)

    measureDiskPressure.mockResolvedValueOnce(sample(0.95))
    await reportDiskPressure('/data', PINNED_MIN_FREE)
    expect(reporter.addBreadcrumb).toHaveBeenCalledTimes(4)
    expect(reporter.captureMessage).toHaveBeenCalledTimes(2)
    expect(reporter.captureMessage.mock.calls[1][1]).toBe('error')

    measureDiskPressure.mockResolvedValueOnce(sample(0.95))
    await reportDiskPressure('/data', PINNED_MIN_FREE)
    expect(reporter.addBreadcrumb).toHaveBeenCalledTimes(5)
    expect(reporter.captureMessage).toHaveBeenCalledTimes(2)
  })

  it('re-arms a message after pressure recovers', async () => {
    measureDiskPressure.mockResolvedValueOnce(sample(0.85))
    await reportDiskPressure('/data', PINNED_MIN_FREE)
    expect(reporter.captureMessage).toHaveBeenCalledTimes(1)

    measureDiskPressure.mockResolvedValueOnce(sample(0.85))
    await reportDiskPressure('/data', PINNED_MIN_FREE)
    expect(reporter.addBreadcrumb).toHaveBeenCalledTimes(2)
    expect(reporter.captureMessage).toHaveBeenCalledTimes(1)

    measureDiskPressure.mockResolvedValueOnce(sample(0.5))
    await reportDiskPressure('/data', PINNED_MIN_FREE)
    expect(reporter.addBreadcrumb).toHaveBeenCalledTimes(3)
    expect(reporter.captureMessage).toHaveBeenCalledTimes(1)

    measureDiskPressure.mockResolvedValueOnce(sample(0.85))
    await reportDiskPressure('/data', PINNED_MIN_FREE)
    expect(reporter.addBreadcrumb).toHaveBeenCalledTimes(4)
    expect(reporter.captureMessage).toHaveBeenCalledTimes(2)
  })

  it('honors an injected minFreeBytes instead of the process environment', async () => {
    measureDiskPressure.mockResolvedValueOnce(sample(0.5, 100))
    await reportDiskPressure('/data', 0)
    expect(reporter.addBreadcrumb).toHaveBeenCalledTimes(1)
    expect(reporter.captureMessage).not.toHaveBeenCalled()
  })

  it('captures a reserve-aware message when free bytes trip the reserve', async () => {
    measureDiskPressure.mockResolvedValueOnce(sample(0.5, 100 * 1024 * 1024))
    await reportDiskPressure('/data', 1024 ** 3)
    expect(reporter.captureMessage).toHaveBeenCalledTimes(1)
    const [message, level] = reporter.captureMessage.mock.calls[0]
    expect(level).toBe('error')
    expect(message).toMatch(/50%/)
    expect(message).toMatch(/100 MB/)
    expect(message).toMatch(/free space/i)
    expect(message).toMatch(/reserve/i)
  })
})
