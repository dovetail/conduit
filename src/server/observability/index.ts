import {
  CompositeReporter,
  DelegatingReporter,
  createConsoleReporter,
  type ErrorReporter,
} from '../../shared/observability'
import { createSentryReporter } from './sentryReporter'

/** Reporter names this build knows how to construct. */
const KNOWN_REPORTERS = ['sentry', 'console'] as const
type KnownReporter = (typeof KNOWN_REPORTERS)[number]

/**
 * Resolve the ordered, de-duplicated list of reporter names to enable.
 *
 * - `CONDUIT_ERROR_REPORTER` is a comma-separated list; each entry is trimmed,
 *   lowercased, and empties dropped. Unknown names are dropped with a single
 *   `console.warn` listing them.
 * - When unset/blank: `['sentry']` if `SENTRY_DSN` is set, else `[]`.
 * - `sentry` requires a DSN. If it is requested (explicitly or by default) but
 *   `SENTRY_DSN` is absent, it is dropped — so we never `Sentry.init` without a
 *   DSN and `getReporterNames()` never advertises a reporter that isn't really
 *   active. An explicit request without a DSN warns.
 */
export function parseReporterConfig(env: NodeJS.ProcessEnv): string[] {
  const raw = env.CONDUIT_ERROR_REPORTER
  const hasDsn = Boolean(env.SENTRY_DSN)

  if (!raw || !raw.trim()) {
    return hasDsn ? ['sentry'] : []
  }

  const seen = new Set<string>()
  const known: string[] = []
  const unknown: string[] = []
  for (const part of raw.split(',')) {
    const name = part.trim().toLowerCase()
    if (!name || seen.has(name)) continue
    seen.add(name)
    if ((KNOWN_REPORTERS as readonly string[]).includes(name)) {
      known.push(name)
    } else {
      unknown.push(name)
    }
  }

  if (unknown.length > 0) {
    console.warn(
      `[observability] Ignoring unknown error reporter(s): ${unknown.join(', ')}. ` +
        `Known reporters: ${KNOWN_REPORTERS.join(', ')}.`
    )
  }

  // sentry is meaningless without a DSN — drop it rather than init a dead client.
  if (known.includes('sentry') && !hasDsn) {
    console.warn('[observability] "sentry" reporter requested but SENTRY_DSN is unset — skipping it.')
    return known.filter((n) => n !== 'sentry')
  }

  return known
}

/** Build a concrete reporter from its resolved name. */
function buildReporter(name: KnownReporter): ErrorReporter {
  switch (name) {
    case 'sentry':
      return createSentryReporter()
    case 'console':
      return createConsoleReporter()
  }
}

const delegating = new DelegatingReporter()

/** The process-wide error reporter. Import this everywhere. */
export const reporter: ErrorReporter = delegating

let resolvedNames: string[] = []

/**
 * Build the configured reporters and install them behind the `reporter`
 * singleton. Returns the resolved reporter names (for `/api/runtime-config`).
 * Call once, as early as possible (see ./instrument).
 */
export function initObservability(): string[] {
  resolvedNames = parseReporterConfig(process.env)
  const children = resolvedNames.map((name) => buildReporter(name as KnownReporter))
  delegating.setInner(new CompositeReporter(children))
  return resolvedNames
}

/** The reporter names resolved by the last `initObservability` call. */
export function getReporterNames(): string[] {
  return resolvedNames
}
