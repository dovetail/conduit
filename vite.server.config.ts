import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { sentryVitePlugin } from '@sentry/vite-plugin'
import { resolve } from 'path'

/**
 * Vite config for building the renderer (React frontend) for server/Docker mode.
 * Output goes to out/renderer/ where the Express server serves it as static files.
 *
 * Source maps: only enabled when the full Sentry upload config is present
 * (auth token + org + project) — i.e. release builds that actually upload. The
 * Sentry plugin uploads the maps and then deletes them so they are never served
 * publicly. Requiring all three avoids the half-configured case where a lone
 * token would emit public maps but have nowhere to upload them. Dev builds and
 * non-Sentry builds skip all of this — no plugin, no emitted maps.
 */
const sentryAuthToken = process.env.SENTRY_AUTH_TOKEN
const sentryOrg = process.env.SENTRY_ORG
const sentryProject = process.env.SENTRY_PROJECT
const uploadSourcemaps = Boolean(sentryAuthToken && sentryOrg && sentryProject)

export default defineConfig({
  plugins: [
    react(),
    ...(uploadSourcemaps
      ? [
          sentryVitePlugin({
            org: sentryOrg,
            project: sentryProject,
            authToken: sentryAuthToken,
            release: { name: process.env.SENTRY_RELEASE ?? process.env.GIT_SHA },
            sourcemaps: {
              // Remove maps from the build output after upload so they aren't
              // served to browsers from out/renderer/.
              filesToDeleteAfterUpload: ['out/renderer/**/*.map'],
            },
          }),
        ]
      : []),
  ],
  root: resolve('src/renderer'),
  base: '/',
  build: {
    outDir: resolve('out/renderer'),
    emptyOutDir: true,
    // Maps are needed only when we're going to upload them to Sentry.
    sourcemap: uploadSourcemaps,
  },
  resolve: {
    alias: {
      '@renderer': resolve('src/renderer'),
      '@shared': resolve('src/shared'),
    },
  },
})
