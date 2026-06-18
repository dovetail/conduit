/**
 * One-off migration: copy existing local SQLite data into Postgres.
 *
 * Run with: npm run db:migrate-sqlite   (after `npm run db:up`)
 *
 * Reads the legacy SQLite database at $CONDUIT_DATA_DIR/conduit.db (default
 * ~/.conduit/conduit.db) and inserts its rows into the Postgres database the
 * app now uses. Idempotent: existing rows (by primary key) are skipped via
 * ON CONFLICT DO NOTHING, so it is safe to re-run. The SQLite file is left
 * untouched as a backup.
 *
 * NOTE: this script depends on `better-sqlite3`, which is kept as a
 * devDependency only for this migration. Once you have migrated, the SQLite
 * dependencies are removed as cleanup and this script can be deleted.
 */

import * as path from 'path'
import * as os from 'os'
import * as fs from 'fs'
import Database from 'better-sqlite3'
import { initDb, rawQuery } from '../src/main/db/index'

const DATA_DIR = process.env.CONDUIT_DATA_DIR ?? path.join(os.homedir(), '.conduit')
const SQLITE_PATH = path.join(DATA_DIR, 'conduit.db')

// Migration order respects foreign keys: parents before children.
// (runs and triggers reference agents.id.)
const TABLES = [
  'users',
  'agents',
  'global_mcp_servers',
  'publish_targets',
  'repositories',
  'runs',
  'triggers',
  'shares',
] as const

// Columns that are INTEGER (0/1) in SQLite but BOOLEAN in Postgres.
const BOOLEAN_COLUMNS = new Set(['enabled'])

function convert(column: string, value: unknown): unknown {
  if (value === null || value === undefined) return null
  if (BOOLEAN_COLUMNS.has(column)) return value === 1 || value === true || value === '1'
  return value
}

async function main(): Promise<void> {
  if (!fs.existsSync(SQLITE_PATH)) {
    console.log(`No SQLite database found at ${SQLITE_PATH} — nothing to migrate.`)
    return
  }

  await initDb()
  const sqlite = new Database(SQLITE_PATH, { readonly: true })

  console.log(`Migrating ${SQLITE_PATH} → Postgres\n`)

  for (const table of TABLES) {
    // Skip tables that don't exist in the legacy DB.
    const exists = sqlite
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`)
      .get(table)
    if (!exists) {
      console.log(`  – ${table}: not present in SQLite, skipping`)
      continue
    }

    const rows = sqlite.prepare(`SELECT * FROM "${table}"`).all() as Record<string, unknown>[]
    if (rows.length === 0) {
      console.log(`  – ${table}: 0 rows`)
      continue
    }

    // Only migrate columns that still exist in the Postgres schema — legacy
    // SQLite databases may carry columns that have since been dropped.
    const pgColRows = await rawQuery<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = $1`,
      [table]
    )
    const pgCols = new Set(pgColRows.map(r => r.column_name))

    let inserted = 0
    for (const row of rows) {
      const cols = Object.keys(row).filter(c => pgCols.has(c))
      const colList = cols.map(c => `"${c}"`).join(', ')
      const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ')
      const values = cols.map(c => convert(c, row[c]))
      const result = await rawQuery<{ id?: string }>(
        `INSERT INTO ${table} (${colList}) VALUES (${placeholders}) ON CONFLICT DO NOTHING RETURNING *`,
        values
      )
      inserted += result.length
    }
    console.log(`  ✓ ${table}: ${inserted} inserted, ${rows.length - inserted} skipped (already present)`)
  }

  sqlite.close()
  console.log('\nMigration complete. Your SQLite file is untouched as a backup.')
}

main().catch((err) => {
  console.error('[migrate] Failed:', err)
  process.exit(1)
})
