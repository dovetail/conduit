import { describe, it, expect } from 'vitest'
import { buildReporters } from './index'
import type { ObservabilityConfig } from './index'

/**
 * These tests are deliberately node-compatible (no jsdom): they only exercise
 * `buildReporters`, which constructs concrete providers and returns them. The
 * console provider is a pure object; the sentry provider's factory calls
 * `Sentry.init`, which is safe to invoke in the vitest node environment for
 * `@sentry/react` v8 (it degrades to a no-op transport when there is no DOM).
 * We only include `sentry` in a config when we also supply a DSN, so the
 * skip-without-dsn path is what runs when no DSN is present.
 */

const base: Omit<ObservabilityConfig, 'errorReporters'> = {
  sentryDsn: null,
  sentryEnvironment: null,
  sentryRelease: null,
}

describe('buildReporters', () => {
  it('builds a single console reporter for ["console"]', () => {
    const reporters = buildReporters({ ...base, errorReporters: ['console'] })
    expect(reporters).toHaveLength(1)
    expect(reporters.map((r) => r.name)).toEqual(['console'])
  })

  it('builds both sentry and console when a dsn is present', () => {
    const reporters = buildReporters({
      ...base,
      errorReporters: ['sentry', 'console'],
      sentryDsn: 'https://public@example.ingest.sentry.io/1',
    })
    expect(reporters).toHaveLength(2)
    const names = reporters.map((r) => r.name)
    expect(names).toContain('sentry')
    expect(names).toContain('console')
  })

  it('skips sentry when the dsn is null', () => {
    const reporters = buildReporters({ ...base, errorReporters: ['sentry'] })
    expect(reporters).toHaveLength(0)
  })

  it('ignores unknown reporter names', () => {
    const reporters = buildReporters({ ...base, errorReporters: ['console', 'mystery'] })
    expect(reporters.map((r) => r.name)).toEqual(['console'])
  })

  it('returns nothing for an empty list', () => {
    const reporters = buildReporters({ ...base, errorReporters: [] })
    expect(reporters).toHaveLength(0)
  })
})
