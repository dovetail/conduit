import { Pool } from 'pg'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import * as schema from './schema'

let pool: Pool
let drizzleDb: NodePgDatabase<typeof schema>

export async function initDb(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required (e.g. postgres://user:pass@host:5432/db)')
  }

  pool = new Pool({
    connectionString: databaseUrl,
    // RDS Postgres requires SSL; node-postgres validates by default but we
    // disable verification for the in-cluster CA bundle. Tighten if you ship
    // RDS root CA.
    ssl: process.env.DATABASE_SSL === 'disable' ? false : { rejectUnauthorized: false },
  })

  drizzleDb = drizzle(pool, { schema })

  // Idempotent schema bootstrap. Drizzle migrations land here once we
  // generate them; for now this matches the columns referenced by the app.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      runner TEXT NOT NULL,
      prompt TEXT NOT NULL,
      env_vars TEXT NOT NULL DEFAULT '{}',
      mcp_config TEXT NOT NULL DEFAULT '{"mcpServers":{}}',
      gist_id TEXT,
      working_dir TEXT,
      publish_target_ids TEXT,
      repository_id TEXT,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS global_mcp_servers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      server_key TEXT NOT NULL,
      server_config TEXT NOT NULL,
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL REFERENCES agents(id),
      status TEXT NOT NULL,
      started_at BIGINT NOT NULL,
      ended_at BIGINT,
      duration_ms BIGINT,
      workspace_path TEXT,
      log_path TEXT NOT NULL,
      exit_code BIGINT,
      trigger_context TEXT
    );

    CREATE TABLE IF NOT EXISTS publish_targets (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'slack',
      config TEXT NOT NULL DEFAULT '{}',
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS triggers (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      config TEXT NOT NULL DEFAULT '{}',
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      last_triggered_at BIGINT,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS oauth_tokens (
      server_url TEXT PRIMARY KEY,
      access_token TEXT NOT NULL,
      refresh_token TEXT,
      expires_at BIGINT,
      token_type TEXT NOT NULL DEFAULT 'Bearer',
      scope TEXT
    );

    CREATE TABLE IF NOT EXISTS repositories (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      default_branch TEXT NOT NULL DEFAULT 'main',
      auth_method TEXT NOT NULL DEFAULT 'none',
      sync_status TEXT NOT NULL DEFAULT 'pending',
      sync_error TEXT,
      last_synced_at BIGINT,
      clone_path TEXT,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL
    );
  `)
}

export async function closeDb(): Promise<void> {
  if (pool) await pool.end()
}

export function getDb(): NodePgDatabase<typeof schema> {
  if (!drizzleDb) throw new Error('Database not initialized. Call initDb() first.')
  return drizzleDb
}

export { drizzleDb }
