/**
 * Seeds the three standard global MCP servers into the Conduit database.
 * Run with: DATABASE_URL=... npx tsx scripts/seed-global-mcps.ts
 */

import { initDb, closeDb } from '../src/main/db/index'
import { listGlobalMcps, createGlobalMcp, updateGlobalMcp } from '../src/main/db/queries/globalMcps'
import type { McpServerEntry } from '../src/shared/types'

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
        SENTRY_ACCESS_TOKEN: '${SENTRY_ACCESS_TOKEN}',
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
        DD_API_KEY: '${DD_API_KEY}',
        DD_APP_KEY: '${DD_APP_KEY}',
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
      args: [
        'run', '--pull=always', '-q', '-i', '--rm',
        '-e', 'BUILDKITE_API_TOKEN=${BUILDKITE_API_TOKEN}',
        'buildkite/mcp-server',
        'stdio',
      ],
    },
  },
]

async function main(): Promise<void> {
  await initDb()

  const existing = await listGlobalMcps()
  const existingByKey = new Map(existing.map((m) => [m.serverKey, m]))

  for (const def of MCPS) {
    const found = existingByKey.get(def.serverKey)
    if (found) {
      await updateGlobalMcp(found.id, { name: def.name, serverConfig: def.serverConfig })
      console.log(`  ↺  Updated: ${def.name} (${def.serverKey})`)
    } else {
      await createGlobalMcp({
        name: def.name,
        serverKey: def.serverKey,
        serverConfig: def.serverConfig,
        enabled: true,
      })
      console.log(`  ✓  Added:   ${def.name} (${def.serverKey})`)
    }
  }

  console.log('\nDone. Required env vars:')
  console.log('  Sentry:    SENTRY_ACCESS_TOKEN')
  console.log('  Datadog:   DD_API_KEY  DD_APP_KEY  DD_SITE')
  console.log('  Buildkite: BUILDKITE_API_TOKEN')

  await closeDb()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
