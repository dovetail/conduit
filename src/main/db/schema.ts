import { pgTable, text, bigint, boolean } from 'drizzle-orm/pg-core'

// All timestamps are unix ms (bigint). Booleans are native pg booleans.
// JSON-shaped columns remain TEXT (serialized) for simplicity; switch to
// jsonb later if you want server-side filtering by JSON fields.

export const oauthTokens = pgTable('oauth_tokens', {
  serverUrl: text('server_url').primaryKey(),
  accessToken: text('access_token').notNull(),
  refreshToken: text('refresh_token'),
  expiresAt: bigint('expires_at', { mode: 'number' }),
  tokenType: text('token_type').notNull().default('Bearer'),
  scope: text('scope'),
})

export const agents = pgTable('agents', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  runner: text('runner').notNull(),
  prompt: text('prompt').notNull(),
  envVars: text('env_vars').notNull().default('{}'),
  mcpConfig: text('mcp_config').notNull().default('{"mcpServers":{}}'),
  gistId: text('gist_id'),
  workingDir: text('working_dir'),
  publishTargetIds: text('publish_target_ids'),
  repositoryId: text('repository_id'),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
})

export const globalMcpServers = pgTable('global_mcp_servers', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  serverKey: text('server_key').notNull(),
  serverConfig: text('server_config').notNull(),
  enabled: boolean('enabled').notNull().default(true),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
})

export const publishTargets = pgTable('publish_targets', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  type: text('type').notNull().default('slack'),
  config: text('config').notNull().default('{}'),
  enabled: boolean('enabled').notNull().default(true),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
})

export const repositories = pgTable('repositories', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  url: text('url').notNull(),
  defaultBranch: text('default_branch').notNull().default('main'),
  authMethod: text('auth_method').notNull().default('none'),
  syncStatus: text('sync_status').notNull().default('pending'),
  syncError: text('sync_error'),
  lastSyncedAt: bigint('last_synced_at', { mode: 'number' }),
  clonePath: text('clone_path'),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
})

export const triggers = pgTable('triggers', {
  id: text('id').primaryKey(),
  agentId: text('agent_id')
    .notNull()
    .references(() => agents.id),
  name: text('name').notNull(),
  type: text('type').notNull(),
  config: text('config').notNull().default('{}'),
  enabled: boolean('enabled').notNull().default(true),
  lastTriggeredAt: bigint('last_triggered_at', { mode: 'number' }),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
})

export const runs = pgTable('runs', {
  id: text('id').primaryKey(),
  agentId: text('agent_id')
    .notNull()
    .references(() => agents.id),
  status: text('status').notNull(),
  startedAt: bigint('started_at', { mode: 'number' }).notNull(),
  endedAt: bigint('ended_at', { mode: 'number' }),
  durationMs: bigint('duration_ms', { mode: 'number' }),
  workspacePath: text('workspace_path'),
  logPath: text('log_path').notNull(),
  exitCode: bigint('exit_code', { mode: 'number' }),
  triggerContext: text('trigger_context'),
})
