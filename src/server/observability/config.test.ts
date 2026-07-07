import { describe, it, expect, vi, afterEach } from 'vitest'
import { parseReporterConfig } from './index'

afterEach(() => {
  vi.restoreAllMocks()
})

// A DSN so the `sentry` reporter isn't gated out; these tests exercise list
// parsing, not the DSN gate (which has its own tests below).
const DSN = 'https://key@example.ingest.sentry.io/1'

describe('parseReporterConfig', () => {
  it('parses a comma-separated list of known reporters', () => {
    expect(
      parseReporterConfig({ CONDUIT_ERROR_REPORTER: 'sentry,console', SENTRY_DSN: DSN })
    ).toEqual(['sentry', 'console'])
  })

  it('trims whitespace and lowercases names', () => {
    expect(
      parseReporterConfig({ CONDUIT_ERROR_REPORTER: '  Sentry ,  CONSOLE ', SENTRY_DSN: DSN })
    ).toEqual(['sentry', 'console'])
  })

  it('drops empty entries from the list', () => {
    expect(
      parseReporterConfig({ CONDUIT_ERROR_REPORTER: 'sentry,,console,', SENTRY_DSN: DSN })
    ).toEqual(['sentry', 'console'])
  })

  it('dedupes repeated names, preserving first-seen order', () => {
    expect(
      parseReporterConfig({ CONDUIT_ERROR_REPORTER: 'console,sentry,console,sentry', SENTRY_DSN: DSN })
    ).toEqual(['console', 'sentry'])
  })

  it('drops unknown names and warns once listing them', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const result = parseReporterConfig({
      CONDUIT_ERROR_REPORTER: 'sentry,datadog,rollbar',
      SENTRY_DSN: DSN,
    })
    expect(result).toEqual(['sentry'])
    expect(warn).toHaveBeenCalledTimes(1)
    const msg = String(warn.mock.calls[0][0])
    expect(msg).toContain('datadog')
    expect(msg).toContain('rollbar')
  })

  it('does not warn when all names are known and sentry has a DSN', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    parseReporterConfig({ CONDUIT_ERROR_REPORTER: 'sentry,console', SENTRY_DSN: DSN })
    expect(warn).not.toHaveBeenCalled()
  })

  it('defaults to ["sentry"] when unset but SENTRY_DSN is present', () => {
    expect(parseReporterConfig({ SENTRY_DSN: DSN })).toEqual(['sentry'])
  })

  it('defaults to [] when unset and no SENTRY_DSN', () => {
    expect(parseReporterConfig({})).toEqual([])
  })

  it('treats a blank CONDUIT_ERROR_REPORTER like unset (DSN fallback)', () => {
    expect(parseReporterConfig({ CONDUIT_ERROR_REPORTER: '   ', SENTRY_DSN: DSN })).toEqual(['sentry'])
    expect(parseReporterConfig({ CONDUIT_ERROR_REPORTER: '   ' })).toEqual([])
  })

  describe('sentry requires a DSN', () => {
    it('drops an explicitly requested sentry when SENTRY_DSN is absent, and warns', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      expect(parseReporterConfig({ CONDUIT_ERROR_REPORTER: 'sentry,console' })).toEqual(['console'])
      expect(warn).toHaveBeenCalledTimes(1)
      expect(String(warn.mock.calls[0][0])).toContain('SENTRY_DSN')
    })

    it('keeps other reporters when sentry is dropped for missing DSN', () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      expect(parseReporterConfig({ CONDUIT_ERROR_REPORTER: 'console,sentry' })).toEqual(['console'])
    })
  })
})
