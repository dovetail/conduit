import {
  CompositeReporter,
  DelegatingReporter,
  createConsoleReporter,
  type ErrorReporter,
} from '@shared/observability'
import { createSentryReporter } from './sentryReporter'

export interface ObservabilityConfig {
  errorReporters: string[]
  sentryDsn: string | null
  sentryEnvironment: string | null
  sentryRelease: string | null
}

/**
 * Constructs concrete reporters for each requested provider name. The name list
 * is already normalized server-side (see server parseReporterConfig) before it's
 * sent via /api/runtime-config. Known providers: `sentry`, `console`. Sentry is
 * only built when a DSN is present; unknown names are ignored.
 */
export function buildReporters(config: ObservabilityConfig): ErrorReporter[] {
  const reporters: ErrorReporter[] = []
  for (const name of config.errorReporters) {
    switch (name) {
      case 'sentry':
        if (config.sentryDsn) {
          reporters.push(
            createSentryReporter({
              sentryDsn: config.sentryDsn,
              sentryEnvironment: config.sentryEnvironment,
              sentryRelease: config.sentryRelease,
            })
          )
        }
        break
      case 'console':
        reporters.push(createConsoleReporter())
        break
      default:
        // Unknown provider name — ignore.
        break
    }
  }
  return reporters
}

const delegating = new DelegatingReporter()

/** The stable, always-safe reporter handle used across the renderer. */
export const reporter: ErrorReporter = delegating

/** Wire up the configured providers. Safe to call once after runtime config loads. */
export function initObservability(config: ObservabilityConfig): void {
  delegating.setInner(new CompositeReporter(buildReporters(config)))
}
