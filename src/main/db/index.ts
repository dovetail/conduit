import { Signer } from '@aws-sdk/rds-signer'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import * as fs from 'fs'
import * as path from 'path'
import { Pool, type PoolConfig } from 'pg'
import * as schema from './schema'

let pool: Pool
let drizzleDb: NodePgDatabase<typeof schema>

// `global-bundle.pem` is the AWS RDS root certificate bundle, downloaded at
// Docker build time. We bundle it next to the compiled JS in `out/main/db/`
// so the running container can validate the RDS server certificate. The
// alternative (in-cluster CA / `rejectUnauthorized: false`) lets MITMs sit
// between the pod and RDS — not acceptable when DATABASE_USE_RDS_IAM=true.
const RDS_CA_BUNDLE_PATH = path.join(__dirname, 'global-bundle.pem')

function getRequiredEnv(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(`${name} env var is required`)
  }
  return value
}

function buildPoolConfig(): PoolConfig {
  // Production / staging: RDS IAM auth. The pod assumes its EKS Pod
  // Identity role and mints a short-lived (~15-minute) auth token per
  // new pg.Pool connection. node-postgres calls the `password` function
  // each time it opens a fresh connection, so token expiry is handled
  // transparently as the pool churns.
  if (process.env.DATABASE_USE_RDS_IAM === 'true') {
    const hostname = getRequiredEnv('DATABASE_HOST')
    const port = Number.parseInt(getRequiredEnv('DATABASE_PORT'), 10)
    const database = getRequiredEnv('DATABASE_NAME')
    const user = getRequiredEnv('DATABASE_USER')
    const region = getRequiredEnv('AWS_REGION')
    if (!Number.isFinite(port)) {
      throw new Error(`DATABASE_PORT must be a number, got: ${process.env.DATABASE_PORT}`)
    }

    const signer = new Signer({ hostname, port, username: user, region })

    return {
      host: hostname,
      port,
      database,
      user,
      password: () => signer.getAuthToken(),
      ssl: { ca: fs.readFileSync(RDS_CA_BUNDLE_PATH, 'utf8'), rejectUnauthorized: true },
    }
  }

  // Local dev / Docker Compose: password auth via DATABASE_URL. Skip TLS
  // entirely when DATABASE_SSL=disable so the bundled compose Postgres
  // (which doesn't have a cert) works out of the box.
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) {
    throw new Error(
      'Set either DATABASE_USE_RDS_IAM=true (with DATABASE_HOST/PORT/NAME/USER and AWS_REGION) ' +
        'for IAM auth, or DATABASE_URL (postgres://user:pass@host:5432/db) for password auth.',
    )
  }
  return {
    connectionString: databaseUrl,
    ssl: process.env.DATABASE_SSL === 'disable' ? false : { rejectUnauthorized: false },
  }
}

export async function initDb(): Promise<void> {
  pool = new Pool(buildPoolConfig())

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
