// Uploads the compiled SERVER source maps (out/server, out/main, out/shared) to
// Sentry so production stack traces are readable. Gated on SENTRY_AUTH_TOKEN:
// dev builds and non-Sentry builds skip this entirely and exit 0.
//
// The renderer's maps are handled separately by @sentry/vite-plugin (which also
// deletes them after upload so they aren't served) — this script deliberately
// targets only the server output dirs.
import SentryCli from '@sentry/cli'

const token = process.env.SENTRY_AUTH_TOKEN
const org = process.env.SENTRY_ORG
const project = process.env.SENTRY_PROJECT
if (!token || !org || !project) {
  console.log(
    '[sourcemaps] SENTRY_AUTH_TOKEN / SENTRY_ORG / SENTRY_PROJECT not all set — skipping server source-map upload.'
  )
  process.exit(0)
}

const release = process.env.SENTRY_RELEASE || process.env.GIT_SHA
if (!release) {
  console.warn('[sourcemaps] No SENTRY_RELEASE or GIT_SHA set — skipping server source-map upload.')
  process.exit(0)
}

// sentry-cli reads SENTRY_AUTH_TOKEN / SENTRY_ORG / SENTRY_PROJECT from the env.
const cli = new SentryCli()
const paths = ['out/server', 'out/main', 'out/shared']

try {
  await cli.execute(['sourcemaps', 'inject', ...paths], true)
  await cli.execute(['sourcemaps', 'upload', '--release', release, ...paths], true)
  console.log(`[sourcemaps] Uploaded server source maps for release ${release}.`)
} catch (err) {
  // Don't fail the whole build if upload fails (e.g. transient network) — the
  // app still ships; traces just won't be symbolicated for this release.
  console.error('[sourcemaps] Server source-map upload failed:', err)
  process.exit(0)
}
