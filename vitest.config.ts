import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

/**
 * Vitest config. Mirrors the `@renderer` / `@shared` path aliases used by the
 * renderer (see vite.server.config.ts and tsconfig.web.json) so tests can import
 * production modules that reference those aliases.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@renderer': resolve(__dirname, 'src/renderer'),
      '@shared': resolve(__dirname, 'src/shared'),
    },
  },
})
