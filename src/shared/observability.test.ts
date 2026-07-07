import { describe, it, expect, vi, afterEach } from 'vitest'
import { CompositeReporter, DelegatingReporter, createConsoleReporter } from './observability'
import type { ErrorReporter, ReporterUser, Breadcrumb, CaptureContext, SeverityLevel } from './observability'

/** A recording fake so we assert on real fan-out, not mocks of the class under test. */
function makeFake(name: string, flushResult = true): ErrorReporter & {
  exceptions: Array<{ error: unknown; ctx?: CaptureContext }>
  messages: Array<{ message: string; level?: SeverityLevel; ctx?: CaptureContext }>
  users: ReporterUser[]
  breadcrumbs: Breadcrumb[]
  flushCalls: number
} {
  const rec = {
    name,
    exceptions: [] as Array<{ error: unknown; ctx?: CaptureContext }>,
    messages: [] as Array<{ message: string; level?: SeverityLevel; ctx?: CaptureContext }>,
    users: [] as ReporterUser[],
    breadcrumbs: [] as Breadcrumb[],
    flushCalls: 0,
    captureException(error: unknown, ctx?: CaptureContext) {
      rec.exceptions.push({ error, ctx })
    },
    captureMessage(message: string, level?: SeverityLevel, ctx?: CaptureContext) {
      rec.messages.push({ message, level, ctx })
    },
    setUser(user: ReporterUser) {
      rec.users.push(user)
    },
    addBreadcrumb(b: Breadcrumb) {
      rec.breadcrumbs.push(b)
    },
    async flush(_timeoutMs?: number) {
      rec.flushCalls++
      return flushResult
    },
  }
  return rec
}

describe('CompositeReporter', () => {
  it('fans captureException out to every child with the same context', () => {
    const a = makeFake('a')
    const b = makeFake('b')
    const composite = new CompositeReporter([a, b])
    const err = new Error('boom')
    const ctx: CaptureContext = { tags: { channel: 'agent:list' } }

    composite.captureException(err, ctx)

    expect(a.exceptions).toEqual([{ error: err, ctx }])
    expect(b.exceptions).toEqual([{ error: err, ctx }])
  })

  it('fans captureMessage, setUser, and addBreadcrumb to every child', () => {
    const a = makeFake('a')
    const b = makeFake('b')
    const composite = new CompositeReporter([a, b])

    composite.captureMessage('hi', 'warning')
    composite.setUser({ id: 'u1' })
    composite.addBreadcrumb({ message: 'clicked' })

    expect(a.messages).toEqual([{ message: 'hi', level: 'warning', ctx: undefined }])
    expect(b.messages).toEqual([{ message: 'hi', level: 'warning', ctx: undefined }])
    expect(a.users).toEqual([{ id: 'u1' }])
    expect(b.breadcrumbs).toEqual([{ message: 'clicked' }])
  })

  it('flush awaits all children and resolves true only when all succeed', async () => {
    const a = makeFake('a', true)
    const b = makeFake('b', true)
    const composite = new CompositeReporter([a, b])

    await expect(composite.flush(100)).resolves.toBe(true)
    expect(a.flushCalls).toBe(1)
    expect(b.flushCalls).toBe(1)
  })

  it('flush resolves false when any child fails to flush', async () => {
    const a = makeFake('a', true)
    const b = makeFake('b', false)
    const composite = new CompositeReporter([a, b])

    await expect(composite.flush()).resolves.toBe(false)
  })

  it('keeps fanning out when one child throws synchronously', () => {
    const thrower: ErrorReporter = {
      name: 'thrower',
      captureException() {
        throw new Error('child exploded')
      },
      captureMessage() {},
      setUser() {},
      addBreadcrumb() {},
      async flush() {
        return true
      },
    }
    const good = makeFake('good')
    const composite = new CompositeReporter([thrower, good])

    expect(() => composite.captureException(new Error('x'))).not.toThrow()
    expect(good.exceptions).toHaveLength(1)
  })

  it('is a silent no-op with zero children and flush resolves true', async () => {
    const composite = new CompositeReporter([])

    expect(() => composite.captureException(new Error('x'))).not.toThrow()
    expect(() => composite.captureMessage('m')).not.toThrow()
    expect(() => composite.setUser(null)).not.toThrow()
    expect(() => composite.addBreadcrumb({ message: 'b' })).not.toThrow()
    await expect(composite.flush()).resolves.toBe(true)
  })

  it('exposes a name listing its children', () => {
    const composite = new CompositeReporter([makeFake('sentry'), makeFake('console')])
    expect(composite.name).toContain('sentry')
    expect(composite.name).toContain('console')
  })
})

describe('DelegatingReporter', () => {
  it('is a silent no-op before an inner reporter is installed', async () => {
    const d = new DelegatingReporter()
    expect(() => d.captureException(new Error('x'))).not.toThrow()
    await expect(d.flush()).resolves.toBe(true)
  })

  it('forwards every call to the installed inner reporter', () => {
    const d = new DelegatingReporter()
    const inner = makeFake('inner')
    d.setInner(inner)

    const err = new Error('boom')
    const ctx: CaptureContext = { tags: { a: 'b' } }
    d.captureException(err, ctx)
    d.captureMessage('m', 'warning')
    d.setUser({ id: 'u1' })
    d.addBreadcrumb({ message: 'crumb' })

    expect(inner.exceptions).toEqual([{ error: err, ctx }])
    expect(inner.messages).toEqual([{ message: 'm', level: 'warning', ctx: undefined }])
    expect(inner.users).toEqual([{ id: 'u1' }])
    expect(inner.breadcrumbs).toEqual([{ message: 'crumb' }])
  })

  it('reflects the installed reporter in its name and swaps in place', () => {
    const d = new DelegatingReporter()
    d.setInner(new CompositeReporter([makeFake('sentry')]))
    expect(d.name).toContain('sentry')
    d.setInner(new CompositeReporter([makeFake('console')]))
    expect(d.name).toContain('console')
  })
})

describe('createConsoleReporter', () => {
  afterEach(() => vi.restoreAllMocks())

  it('emits one structured JSON exception line to console.error', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const reporter = createConsoleReporter()

    reporter.captureException(new Error('kaboom'), { tags: { channel: 'x' } })

    expect(spy).toHaveBeenCalledTimes(1)
    const payload = JSON.parse(spy.mock.calls[0][0] as string)
    expect(payload).toMatchObject({
      source: 'observability',
      type: 'exception',
      level: 'error',
      message: 'kaboom',
      tags: { channel: 'x' },
    })
    expect(typeof payload.stack).toBe('string')
  })

  it('routes non-error messages to console.log with the resolved level', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const reporter = createConsoleReporter()

    reporter.captureMessage('hello', 'info')

    const payload = JSON.parse(logSpy.mock.calls[0][0] as string)
    expect(payload).toMatchObject({ type: 'message', level: 'info', message: 'hello' })
  })

  it('includes the user set via setUser and always flushes true', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const reporter = createConsoleReporter()
    reporter.setUser({ id: 'u42' })

    reporter.captureException(new Error('e'))

    const payload = JSON.parse(spy.mock.calls[0][0] as string)
    expect(payload.user).toEqual({ id: 'u42' })
    await expect(reporter.flush()).resolves.toBe(true)
  })
})
