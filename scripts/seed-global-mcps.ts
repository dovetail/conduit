/**
 * Seeds the three standard global MCP servers into the Conduit database.
 * Run with: npx tsx scripts/seed-global-mcps.ts
 *
 * Env vars referenced (${VAR}) are expanded at agent-run time, not here.
 * Set them in your system environment or in the agent's env-var editor.
 *
 * References:
 *   Sentry:     https://docs.sentry.io/product/sentry-mcp/
 *   Datadog:    https://docs.datadoghq.com/bits_ai/mcp_server/
 *   Buildkite:  https://buildkite.com/docs/apis/mcp-server
 */

import * as path from 'path'
import * as os from 'os'
import { initDb } from '../src/main/db/index'
import { listGlobalMcps, createGlobalMcp, updateGlobalMcp } from '../src/main/db/queries/globalMcps'
import { DEV_USER_ID, DEV_CONTEXT } from '../src/server/auth/config'
import type { McpServerEntry } from '../src/shared/types'

// Point the DB at ~/.conduit (same as the running server)
process.env.CONDUIT_DATA_DIR = process.env.CONDUIT_DATA_DIR ?? path.join(os.homedir(), '.conduit')

// ─── MCP definitions ──────────────────────────────────────────────────────────

const MCPS: Array<{
  name: string
  serverKey: string
  serverConfig: McpServerEntry
}> = [
  {
    name: 'Sentry',
    serverKey: 'sentry',
    serverConfig: {
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@sentry/mcp-server@latest'],
      env: {
        // https://docs.sentry.io/product/sentry-mcp/
        SENTRY_ACCESS_TOKEN: '${SENTRY_ACCESS_TOKEN}',
        // Optional: override for self-hosted Sentry
        // SENTRY_HOST: '${SENTRY_HOST}',
      },
    },
  },
  {
    name: 'Datadog',
    serverKey: 'datadog',
    serverConfig: {
      type: 'stdio',
      command: 'npx',
      args: ['-y', 'datadog-mcp-server'],
      env: {
        // https://docs.datadoghq.com/bits_ai/mcp_server/setup/
        DD_API_KEY: '${DD_API_KEY}',
        DD_APP_KEY: '${DD_APP_KEY}',
        // Site: datadoghq.com | datadoghq.eu | us5.datadoghq.com | ap1.datadoghq.com
        DD_SITE: '${DD_SITE}',
      },
    },
  },
  {
    name: 'Buildkite',
    serverKey: 'buildkite',
    serverConfig: {
      type: 'stdio',
      command: 'docker',
      // https://buildkite.com/docs/apis/mcp-server
      // -e BUILDKITE_API_TOKEN (no value) inherits from the host environment
      args: [
        'run', '--pull=always', '-q', '-i', '--rm',
        '-e', 'BUILDKITE_API_TOKEN=${BUILDKITE_API_TOKEN}',
        'buildkite/mcp-server',
        'stdio',
      ],
    },
  },
]

// ─── Upsert logic ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  await initDb()

  const existing = await listGlobalMcps(DEV_CONTEXT.userId, DEV_CONTEXT.userGroupIds)
  const existingByKey = new Map(existing.map(m => [m.serverKey, m]))

  for (const def of MCPS) {
    const found = existingByKey.get(def.serverKey)
    if (found) {
      await updateGlobalMcp(found.id, {
        name: def.name,
        serverConfig: def.serverConfig,
      })
      console.log(`  ↺  Updated: ${def.name} (${def.serverKey})`)
    } else {
      await createGlobalMcp({
        name: def.name,
        serverKey: def.serverKey,
        serverConfig: def.serverConfig,
        enabled: true,
      }, DEV_USER_ID)
      console.log(`  ✓  Added:   ${def.name} (${def.serverKey})`)
    }
  }

  console.log('\nDone. Required env vars:\n')
  console.log('  Sentry:    SENTRY_ACCESS_TOKEN')
  console.log('  Datadog:   DD_API_KEY  DD_APP_KEY  DD_SITE')
  console.log('  Buildkite: BUILDKITE_API_TOKEN')
  console.log('\nSet them in your system environment or in each agent\'s env-var editor.')
}

main().catch((err) => {
  console.error('[seed] Failed:', err)
  process.exit(1)
})
