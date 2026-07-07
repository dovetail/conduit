import * as Sentry from '@sentry/react'
import {
  resolveLevel,
  type ErrorReporter,
  type ReporterUser,
  type CaptureContext,
  type Breadcrumb,
  type SeverityLevel,
} from '@shared/observability'

export interface SentryReporterConfig {
  sentryDsn: string | null
  sentryEnvironment: string | null
  sentryRelease: string | null
}

/**
 * Wraps `@sentry/react`. Preserves the previous behavior exactly:
 * `Sentry.init` with `tracesSampleRate: 0` (no browser tracing — out of scope).
 *
 * Per-call context (tags/extra/level/user) is applied inside `Sentry.withScope`
 * so it never leaks onto the global scope, while `setUser` sets the persistent
 * global user (login/logout).
 */
export function createSentryReporter(config: SentryReporterConfig): ErrorReporter {
  Sentry.init({
    dsn: config.sentryDsn ?? undefined,
    environment: config.sentryEnvironment ?? undefined,
    release: config.sentryRelease ?? undefined,
    tracesSampleRate: 0,
  })

  function applyContext(scope: Sentry.Scope, ctx?: CaptureContext): void {
    if (!ctx) return
    if (ctx.level) scope.setLevel(ctx.level)
    if (ctx.tags) {
      for (const [key, value] of Object.entries(ctx.tags)) scope.setTag(key, value)
    }
    if (ctx.extra) {
      for (const [key, value] of Object.entries(ctx.extra)) scope.setExtra(key, value)
    }
    if (ctx.user !== undefined) scope.setUser(ctx.user)
  }

  return {
    name: 'sentry',

    captureException(error: unknown, ctx?: CaptureContext): void {
      Sentry.withScope((scope) => {
        applyContext(scope, ctx)
        Sentry.captureException(error)
      })
    },

    captureMessage(message: string, level?: SeverityLevel, ctx?: CaptureContext): void {
      Sentry.withScope((scope) => {
        applyContext(scope, ctx)
        Sentry.captureMessage(message, resolveLevel(level, ctx))
      })
    },

    setUser(user: ReporterUser): void {
      Sentry.setUser(user)
    },

    addBreadcrumb(breadcrumb: Breadcrumb): void {
      Sentry.addBreadcrumb(breadcrumb)
    },

    flush(timeoutMs?: number): Promise<boolean> {
      return Sentry.flush(timeoutMs)
    },
  }
}
