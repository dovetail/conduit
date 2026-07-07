/**
 * Provider-agnostic error-reporting contract shared by the server and the browser.
 *
 * This module contains ONLY types, the interface, and the pure `CompositeReporter`
 * that fans calls out to concrete providers. It must never import an SDK
 * (`@sentry/*`, etc.) so the seam stays free of platform-specific dependencies —
 * concrete providers live in `src/server/observability/` and
 * `src/renderer/observability/`.
 */

export type ReporterUser = { id?: string; email?: string; username?: string } | null

export type SeverityLevel = 'fatal' | 'error' | 'warning' | 'info' | 'debug'

export interface Breadcrumb {
  category?: string
  message: string
  level?: SeverityLevel
  data?: Record<string, unknown>
}

export interface CaptureContext {
  tags?: Record<string, string>
  extra?: Record<string, unknown>
  level?: SeverityLevel
  /** Attach the affected user to this event only (avoids global-scope races on the server). */
  user?: ReporterUser
}

/**
 * A pluggable error-reporting backend. Providers implement every method;
 * methods a provider does not support should be cheap no-ops rather than throw.
 */
export interface ErrorReporter {
  readonly name: string
  captureException(error: unknown, ctx?: CaptureContext): void
  captureMessage(message: string, level?: SeverityLevel, ctx?: CaptureContext): void
  setUser(user: ReporterUser): void
  addBreadcrumb(breadcrumb: Breadcrumb): void
  /** Flush buffered events. Resolves true when delivery is believed complete. */
  flush(timeoutMs?: number): Promise<boolean>
}

/**
 * Fans every call out to zero or more child reporters. An instance with no
 * children is a silent no-op — that is how "reporting disabled" is represented,
 * so callers always hold a real reporter and never a null.
 *
 * A child throwing synchronously is swallowed (and logged) so one misbehaving
 * provider can never suppress the others.
 */
export class CompositeReporter implements ErrorReporter {
  private readonly children: readonly ErrorReporter[]

  constructor(children: readonly ErrorReporter[]) {
    this.children = children
  }

  get name(): string {
    return `composite(${this.children.map((c) => c.name).join(',')})`
  }

  private fanOut(op: (child: ErrorReporter) => void): void {
    for (const child of this.children) {
      try {
        op(child)
      } catch (err) {
        // Never let one provider's failure break the others.
        // eslint-disable-next-line no-console
        console.error(`[observability] reporter "${child.name}" threw:`, err)
      }
    }
  }

  captureException(error: unknown, ctx?: CaptureContext): void {
    this.fanOut((c) => c.captureException(error, ctx))
  }

  captureMessage(message: string, level?: SeverityLevel, ctx?: CaptureContext): void {
    this.fanOut((c) => c.captureMessage(message, level, ctx))
  }

  setUser(user: ReporterUser): void {
    this.fanOut((c) => c.setUser(user))
  }

  addBreadcrumb(breadcrumb: Breadcrumb): void {
    this.fanOut((c) => c.addBreadcrumb(breadcrumb))
  }

  async flush(timeoutMs?: number): Promise<boolean> {
    const results = await Promise.all(
      this.children.map(async (c) => {
        try {
          return await c.flush(timeoutMs)
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error(`[observability] reporter "${c.name}" flush threw:`, err)
          return false
        }
      })
    )
    return results.every(Boolean)
  }
}

/**
 * A stable, always-present reporter handle. Its identity never changes, so
 * consumers can `import { reporter }` once at module load and the real providers
 * can be installed later via `setInner` — import order relative to init never
 * matters, and there is no CommonJS live-binding hazard. Until initialized the
 * inner reporter is an empty `CompositeReporter` (a silent no-op), so early
 * captures are dropped rather than throwing.
 *
 * Platform-neutral (no SDK imports), so both the server and the browser use this
 * one implementation instead of maintaining their own copies.
 */
export class DelegatingReporter implements ErrorReporter {
  private inner: ErrorReporter = new CompositeReporter([])

  get name(): string {
    return this.inner.name
  }

  setInner(inner: ErrorReporter): void {
    this.inner = inner
  }

  captureException(error: unknown, ctx?: CaptureContext): void {
    this.inner.captureException(error, ctx)
  }

  captureMessage(message: string, level?: SeverityLevel, ctx?: CaptureContext): void {
    this.inner.captureMessage(message, level, ctx)
  }

  setUser(user: ReporterUser): void {
    this.inner.setUser(user)
  }

  addBreadcrumb(breadcrumb: Breadcrumb): void {
    this.inner.addBreadcrumb(breadcrumb)
  }

  flush(timeoutMs?: number): Promise<boolean> {
    return this.inner.flush(timeoutMs)
  }
}

/** The per-call level, resolving an explicit context level over the positional arg. */
export function resolveLevel(
  level: SeverityLevel | undefined,
  ctx: CaptureContext | undefined
): SeverityLevel | undefined {
  return ctx?.level ?? level
}

/**
 * A dependency-free reporter that emits one structured JSON line per event.
 * Works identically in Node and the browser (only touches the global `console`),
 * so it lives in shared and both sides use it — no per-platform copies to drift.
 * Useful as a fallback, or alongside Sentry, so errors are visible in the log
 * stream without any external service. `flush` is a no-op that always succeeds.
 */
export function createConsoleReporter(): ErrorReporter {
  let currentUser: ReporterUser = null

  function serializeError(error: unknown): { message: string; stack?: string } {
    if (error instanceof Error) return { message: error.message, stack: error.stack }
    return { message: typeof error === 'string' ? error : JSON.stringify(error) }
  }

  function emit(
    method: 'error' | 'log',
    event: Record<string, unknown>,
    ctx?: CaptureContext
  ): void {
    const user = ctx?.user ?? currentUser
    const line = {
      source: 'observability',
      ...event,
      ...(ctx?.tags ? { tags: ctx.tags } : {}),
      ...(ctx?.extra ? { extra: ctx.extra } : {}),
      ...(user ? { user } : {}),
    }
    // eslint-disable-next-line no-console
    console[method](JSON.stringify(line))
  }

  return {
    name: 'console',

    captureException(error: unknown, ctx?: CaptureContext): void {
      const { message, stack } = serializeError(error)
      emit('error', { type: 'exception', level: ctx?.level ?? 'error', message, stack }, ctx)
    },

    captureMessage(message: string, level?: SeverityLevel, ctx?: CaptureContext): void {
      const resolved = resolveLevel(level, ctx) ?? 'info'
      const method = resolved === 'error' || resolved === 'fatal' ? 'error' : 'log'
      emit(method, { type: 'message', level: resolved, message }, ctx)
    },

    setUser(user: ReporterUser): void {
      currentUser = user
    },

    addBreadcrumb(breadcrumb: Breadcrumb): void {
      // eslint-disable-next-line no-console
      console.log(JSON.stringify({ source: 'observability', type: 'breadcrumb', ...breadcrumb }))
    },

    async flush(): Promise<boolean> {
      return true
    },
  }
}
