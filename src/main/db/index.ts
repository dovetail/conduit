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

// Local-dev default. When neither RDS IAM nor an explicit DATABASE_URL is set,
// point at the Postgres started by `npm run db:up` (Podman) so `npm run dev`
// works with zero configuration — same zero-setup feel as the old SQLite file.
const DEV_DATABASE_URL = 'postgres://conduit:conduit@localhost:5432/conduit'

function applyDevDefaults(): void {
  if (process.env.DATABASE_USE_RDS_IAM === 'true') return
  if (!process.env.DATABASE_URL) {
    process.env.DATABASE_URL = DEV_DATABASE_URL
    if (!process.env.DATABASE_SSL) process.env.DATABASE_SSL = 'disable'
  }
}

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
  applyDevDefaults()
  pool = new Pool(buildPoolConfig())

  drizzleDb = drizzle(pool, { schema })

  // Idempotent schema bootstrap. Drizzle migrations land here once we
  // generate them; for now this matches the columns referenced by the app.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      name TEXT NOT NULL,
      avatar_url TEXT,
      last_login_at BIGINT NOT NULL,
      created_at BIGINT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS groups (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      parent_group_id TEXT,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS user_groups (
      user_id TEXT NOT NULL,
      group_id TEXT NOT NULL,
      PRIMARY KEY (user_id, group_id)
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      access_token TEXT NOT NULL,
      refresh_token TEXT,
      expires_at BIGINT NOT NULL,
      created_at BIGINT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS shares (
      id TEXT PRIMARY KEY,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_id TEXT,
      created_by TEXT NOT NULL,
      created_at BIGINT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS unique_share
      ON shares (entity_type, entity_id, target_type, target_id);

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
      effort TEXT,
      enable_repo_mcps BOOLEAN NOT NULL DEFAULT false,
      owner_id TEXT,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS global_mcp_servers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      server_key TEXT NOT NULL,
      server_config TEXT NOT NULL,
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      owner_id TEXT,
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
      trigger_context TEXT,
      started_by TEXT
    );

    CREATE TABLE IF NOT EXISTS publish_targets (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'slack',
      config TEXT NOT NULL DEFAULT '{}',
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      owner_id TEXT,
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
      owner_id TEXT,
      github_app_id TEXT,
      github_private_key_enc TEXT,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL
    );

    -- Idempotent column adds for databases created before these columns existed.
    ALTER TABLE agents ADD COLUMN IF NOT EXISTS owner_id TEXT;
    ALTER TABLE agents ADD COLUMN IF NOT EXISTS effort TEXT;
    ALTER TABLE agents ADD COLUMN IF NOT EXISTS enable_repo_mcps BOOLEAN NOT NULL DEFAULT false;
    ALTER TABLE global_mcp_servers ADD COLUMN IF NOT EXISTS owner_id TEXT;
    ALTER TABLE publish_targets ADD COLUMN IF NOT EXISTS owner_id TEXT;
    ALTER TABLE repositories ADD COLUMN IF NOT EXISTS owner_id TEXT;
    ALTER TABLE repositories ADD COLUMN IF NOT EXISTS github_app_id TEXT;
    ALTER TABLE repositories ADD COLUMN IF NOT EXISTS github_private_key_enc TEXT;
    ALTER TABLE runs ADD COLUMN IF NOT EXISTS started_by TEXT;
    ALTER TABLE oauth_tokens ADD COLUMN IF NOT EXISTS token_owner TEXT NOT NULL DEFAULT '__global__';
    ALTER TABLE oauth_tokens ADD COLUMN IF NOT EXISTS connected_by_user_id TEXT;

    CREATE TABLE IF NOT EXISTS mcp_oauth_clients (
      server_url TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      client_secret_enc TEXT,
      authorization_endpoint TEXT NOT NULL,
      token_endpoint TEXT NOT NULL,
      registration_data TEXT,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL
    );
  `)

  // Guarded primary-key swap for oauth_tokens: drop the old single-column PK
  // and replace it with a composite (server_url, token_owner) PK — but only if
  // the table still has a single-column primary key. Run as a separate statement
  // because DO $$ blocks contain internal semicolons that must not be split by
  // the caller; pool.query() sends the full string to Postgres intact, so a
  // single-statement call is the safest approach.
  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'oauth_tokens'::regclass AND contype = 'p'
          AND array_length(conkey, 1) = 2
      ) THEN
        ALTER TABLE oauth_tokens DROP CONSTRAINT IF EXISTS oauth_tokens_pkey;
        ALTER TABLE oauth_tokens ADD PRIMARY KEY (server_url, token_owner);
      END IF;
    END $$;
  `)
}

export async function closeDb(): Promise<void> {
  if (pool) await pool.end()
}

export function getDb(): NodePgDatabase<typeof schema> {
  if (!drizzleDb) throw new Error('Database not initialized. Call initDb() first.')
  return drizzleDb
}

// Escape hatch for the handful of dynamic queries (visibility UNIONs) that are
// awkward to express with the query builder. `text` uses pg-style `$1..$n`
// placeholders. Table names come from fixed internal maps, never user input.
export async function rawQuery<T = Record<string, unknown>>(
  text: string,
  params: unknown[] = []
): Promise<T[]> {
  const res = await pool.query(text, params)
  return res.rows as T[]
}

export { drizzleDb }
