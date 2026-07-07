import * as Sentry from '@sentry/node'
import {
  resolveLevel,
  type Breadcrumb,
  type CaptureContext,
  type ErrorReporter,
  type ReporterUser,
  type SeverityLevel,
} from '../../shared/observability'

/**
 * A thin adapter over `@sentry/node`. `Sentry.init` is invoked eagerly on
 * construction (preserving today's config exactly), and each capture applies
 * the per-call `CaptureContext` via `Sentry.withScope` so concurrent requests
 * never race on global scope.
 *
 * Sentry's default `OnUncaughtException` / `OnUnhandledRejection` integrations
 * are disabled: process-level errors are captured by our own generic
 * `process.on` handlers (in src/server/index.ts) so capture works for every
 * configured provider, not just Sentry — and so a process error isn't reported
 * twice (once by Sentry's integration, once by ours).
 */
export function createSentryReporter(): ErrorReporter {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV ?? 'production',
    release: process.env.SENTRY_RELEASE ?? process.env.GIT_SHA,
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? 0),
    integrations: (defaults) =>
      defaults.filter(
        (i) => i.name !== 'OnUncaughtException' && i.name !== 'OnUnhandledRejection'
      ),
  })

  function applyContext(scope: Sentry.Scope, ctx?: CaptureContext): void {
    if (!ctx) return
    if (ctx.tags) {
      for (const [key, value] of Object.entries(ctx.tags)) scope.setTag(key, value)
    }
    if (ctx.extra) {
      for (const [key, value] of Object.entries(ctx.extra)) scope.setExtra(key, value)
    }
    if (ctx.level) scope.setLevel(ctx.level as Sentry.SeverityLevel)
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
        Sentry.captureMessage(message, resolveLevel(level, ctx) as Sentry.SeverityLevel | undefined)
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
