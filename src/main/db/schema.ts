import { pgTable, text, bigint, boolean, primaryKey, uniqueIndex } from 'drizzle-orm/pg-core'

// All timestamps are unix ms (bigint). Booleans are native pg booleans.
// JSON-shaped columns remain TEXT (serialized) for simplicity; switch to
// jsonb later if you want server-side filtering by JSON fields.

// ── Auth & Users ───────────────────────────────────────────────────────────

export const users = pgTable('users', {
  id: text('id').primaryKey(),
  email: text('email').notNull(),
  name: text('name').notNull(),
  avatarUrl: text('avatar_url'),
  lastLoginAt: bigint('last_login_at', { mode: 'number' }).notNull(),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
})

export const groups = pgTable('groups', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  parentGroupId: text('parent_group_id'),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
})

export const userGroups = pgTable('user_groups', {
  userId: text('user_id').notNull(),
  groupId: text('group_id').notNull(),
}, (table) => ({
  pk: primaryKey({ columns: [table.userId, table.groupId] }),
}))

export const sessions = pgTable('sessions', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  accessToken: text('access_token').notNull(),
  refreshToken: text('refresh_token'),
  expiresAt: bigint('expires_at', { mode: 'number' }).notNull(),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
})

export const shares = pgTable('shares', {
  id: text('id').primaryKey(),
  entityType: text('entity_type').notNull(),
  entityId: text('entity_id').notNull(),
  targetType: text('target_type').notNull(),
  targetId: text('target_id'),
  createdBy: text('created_by').notNull(),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
}, (table) => ({
  uniqueShare: uniqueIndex('unique_share').on(table.entityType, table.entityId, table.targetType, table.targetId),
}))

// ── Existing Tables ────────────────────────────────────────────────────────

export const oauthTokens = pgTable('oauth_tokens', {
  serverUrl: text('server_url').notNull(),
  // userId for personal tokens; '__global__' for shared/global MCP tokens.
  tokenOwner: text('token_owner').notNull().default('__global__'),
  // The real user who authorized this token (for display), even for global.
  connectedByUserId: text('connected_by_user_id'),
  accessToken: text('access_token').notNull(),   // encrypted at rest
  refreshToken: text('refresh_token'),            // encrypted at rest
  expiresAt: bigint('expires_at', { mode: 'number' }),
  tokenType: text('token_type').notNull().default('Bearer'),
  scope: text('scope'),
}, (table) => ({
  pk: primaryKey({ columns: [table.serverUrl, table.tokenOwner] }),
}))

export const mcpOAuthClients = pgTable('mcp_oauth_clients', {
  serverUrl: text('server_url').primaryKey(),
  clientId: text('client_id').notNull(),
  clientSecretEnc: text('client_secret_enc'),      // encrypted; null for public clients
  authorizationEndpoint: text('authorization_endpoint').notNull(),
  tokenEndpoint: text('token_endpoint').notNull(),
  registrationData: text('registration_data'),     // raw DCR response JSON
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
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
  ownerId: text('owner_id'),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
})

export const globalMcpServers = pgTable('global_mcp_servers', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  serverKey: text('server_key').notNull(),
  serverConfig: text('server_config').notNull(),
  enabled: boolean('enabled').notNull().default(true),
  ownerId: text('owner_id'),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
})

export const publishTargets = pgTable('publish_targets', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  type: text('type').notNull().default('slack'),
  config: text('config').notNull().default('{}'),
  enabled: boolean('enabled').notNull().default(true),
  ownerId: text('owner_id'),
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
  ownerId: text('owner_id'),
  githubAppId: text('github_app_id'),
  githubPrivateKeyEnc: text('github_private_key_enc'),
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
  startedBy: text('started_by'),
})
