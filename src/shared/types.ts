export type RunnerType = 'claude' | 'amp' | 'cursor'

/** Reasoning effort for the Claude runner (maps to the `claude --effort <level>` flag). */
export type RunnerEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/** Whether a runner's CLI binary is installed and on the server's PATH. */
export interface RunnerCliStatus {
  runner: RunnerType
  /** The binary name checked (e.g. 'claude', 'amp', 'cursor-agent'). */
  binary: string
  installed: boolean
  /** Resolved path when installed. */
  path?: string
}

// ── Auth & Users ───────────────────────────────────────────────────────────

export interface User {
  id: string
  email: string
  name: string
  avatarUrl?: string
  lastLoginAt: number
  createdAt: number
}

export interface Group {
  id: string
  name: string
  parentGroupId?: string
  createdAt: number
  updatedAt: number
}

export type ShareableEntityType = 'agent' | 'publishTarget' | 'repository' | 'globalMcpServer'

export interface Share {
  id: string
  entityType: ShareableEntityType
  entityId: string
  targetType: 'user' | 'group' | 'everyone'
  targetId: string | null
  createdBy: string
  createdAt: number
}

export interface RequestContext {
  userId: string
  userGroupIds: string[]
}

export interface AuthState {
  user: User | null
  groups: Group[]
  isAuthenticated: boolean
  isDevMode: boolean
}

export interface GistFile {
  filename: string
  language: string | null
  size: number
  truncated?: boolean
  content?: string
}

export interface GistSummary {
  id: string
  description: string
  files: Record<string, GistFile>
  createdAt: string
  updatedAt: string
  public: boolean
  htmlUrl: string
  /** true when the gist contains a prompt.md file (Conduit-managed) */
  isConduitPrompt: boolean
}

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
  timestamp: number
}

export interface PromptChatSession {
  id: string
  agentId: string
  runner: RunnerType
  messages: ChatMessage[]
  extractedPrompt?: string
}

export type RunStatus = 'running' | 'completed' | 'failed' | 'stopped' | 'launched'

export interface McpOAuthConfig {
  clientId: string
  authorizationUrl: string  // override discovery if known
  tokenUrl: string          // override discovery if known
  scopes: string[]
}

/**
 * MCP transport type. Remote servers carry a `url` and may be declared as
 * 'url', 'http', 'streamable-http', or 'sse' depending on the client; 'stdio'
 * launches a local `command`. Use `isUrlMcpServer` rather than comparing to a
 * single literal — see src/shared/mcp.ts.
 */
export type McpTransportType = 'url' | 'http' | 'streamable-http' | 'sse' | 'stdio'

export interface McpServerEntry {
  command?: string
  args?: string[]
  type?: McpTransportType
  url?: string
  headers?: Record<string, string>
  env?: Record<string, string>
  oauth?: McpOAuthConfig
}

export interface OAuthToken {
  serverUrl: string
  accessToken: string
  refreshToken?: string
  expiresAt?: number   // unix ms, undefined = no expiry
  tokenType: string    // 'Bearer'
  scope?: string
}

export interface McpOAuthStatus {
  connected: boolean
  connectedByUserId?: string
  connectedByName?: string
  scope: 'user' | 'global'
  expiresAt?: number
}

export interface McpOAuthProbeResult {
  supportsOAuth: boolean   // discovery found authorization + token endpoints
  supportsDcr: boolean     // registration_endpoint present (Dynamic Client Registration)
}

export interface McpServersConfig {
  mcpServers: Record<string, McpServerEntry>
}

export interface AgentConfig {
  id: string
  name: string
  runner: RunnerType
  prompt: string
  envVars: Record<string, string>
  mcpConfig: McpServersConfig
  gistId?: string
  /** If set, the agent runs in this directory instead of an ephemeral workspace */
  workingDir?: string
  /** IDs of publish targets to notify when a run completes */
  publishTargetIds?: string[]
  /** ID of a managed repository to use as the workspace */
  repositoryId?: string
  /** Reasoning effort for the Claude runner. Ignored by other runners; unset uses the CLI default. */
  effort?: RunnerEffort
  /**
   * When true, MCP servers configured in the repository (its `.mcp.json`) and the
   * host's personal connectors load alongside Conduit's managed MCPs. When false
   * (default), only Conduit's global + agent MCPs are used (`--strict-mcp-config`).
   */
  enableRepoMcps?: boolean
  ownerId?: string
  createdAt: number
  updatedAt: number
}

export interface ExecutionRun {
  id: string
  agentId: string
  status: RunStatus
  startedAt: number
  endedAt?: number
  durationMs?: number
  workspacePath?: string
  logPath: string
  exitCode?: number
  triggerContext?: TriggerContext
  startedBy?: string
  /** Last non-empty output line of the run (ANSI-stripped), for a list excerpt. */
  lastLine?: string
}

export interface LogEntry {
  t: number
  stream: 'stdout' | 'stderr' | 'system'
  chunk: string
}

export interface RunOutputPayload {
  runId: string
  stream: 'stdout' | 'stderr' | 'system'
  chunks: string[]
}

export interface RunStatusChangePayload {
  runId: string
  status: RunStatus
  exitCode?: number
  endedAt?: number
  durationMs?: number
}

export interface McpHealthResult {
  status: 'healthy' | 'unhealthy' | 'unauthorized'
  message: string
}

export interface McpToolInfo {
  name: string
  description?: string
}

export interface McpToolsResult {
  tools: McpToolInfo[]
  error?: string
}

export interface GlobalMcpServer {
  id: string
  name: string
  serverKey: string
  serverConfig: McpServerEntry
  enabled: boolean
  ownerId?: string
  createdAt: number
  updatedAt: number
}

// ── Repositories ────────────────────────────────────────────────────────────

export type RepoSyncStatus = 'pending' | 'cloning' | 'ready' | 'syncing' | 'error'

export type RepoAuthMethod = 'none' | 'pat' | 'ssh' | 'githubapp'

export interface Repository {
  id: string
  name: string
  url: string
  defaultBranch: string
  authMethod: RepoAuthMethod
  syncStatus: RepoSyncStatus
  syncError?: string
  lastSyncedAt?: number
  clonePath?: string
  ownerId?: string
  /** GitHub App ID (not secret) — present when authMethod is 'githubapp'. */
  githubAppId?: string
  /**
   * Whether a GitHub App private key is stored for this repo. Derived server-side;
   * the key itself is never returned to the client (write-only).
   */
  hasGithubKey?: boolean
  /** Git author/committer name for agent commits in this repo's worktrees. */
  commitAuthorName?: string
  /** Git author/committer email for agent commits in this repo's worktrees. */
  commitAuthorEmail?: string
  createdAt: number
  updatedAt: number
}

/**
 * Fields accepted when creating or updating a repository. The raw PEM is
 * write-only — it is encrypted server-side and never read back. On update, an
 * absent/empty `githubPrivateKey` leaves the stored key untouched.
 */
export type RepositoryInput = Omit<
  Repository,
  'id' | 'createdAt' | 'updatedAt' | 'syncStatus' | 'clonePath' | 'hasGithubKey'
> & {
  /** Raw GitHub App private key PEM. Write-only. */
  githubPrivateKey?: string
}

/** Payload for testing a repository connection before/without persisting it. */
export interface RepoTestConnectionInput {
  url: string
  authMethod: RepoAuthMethod
  /** GitHub App ID — required (with a key) for testing 'githubapp' auth. */
  githubAppId?: string
  /** Raw PEM to test with. If omitted, falls back to the stored key for `repoId`. */
  githubPrivateKey?: string
  /** Existing repo id — lets the test reuse the stored key when no new PEM is supplied. */
  repoId?: string
}

export interface RepoSyncStatusPayload {
  repoId: string
  syncStatus: RepoSyncStatus
  syncError?: string
  lastSyncedAt?: number
}

// ── Publish Targets ─────────────────────────────────────────────────────────

export type PublishTargetType = 'slack' | 'email' | 'webhook'

export interface SlackPublishConfig {
  /** Slack Bot User OAuth Token (xoxb-...) — used for chat.postMessage */
  botToken?: string
  /** Incoming Webhook URL — alternative to bot token */
  webhookUrl?: string
  /** Channel or user ID to post to (required for bot token mode) */
  channel: string
  /** Emoji icon for the bot (e.g. :robot_face:) — optional override */
  iconEmoji?: string
}

export interface EmailPublishConfig {
  /** SMTP host */
  smtpHost: string
  /** SMTP port (default 587) */
  smtpPort: number
  /** SMTP username */
  smtpUser: string
  /** SMTP password or app password */
  smtpPass: string
  /** Use TLS (default true) */
  smtpSecure: boolean
  /** From address */
  from: string
  /** Comma-separated recipient addresses */
  to: string
  /** Email subject template — {{agentName}} and {{status}} are replaced */
  subject: string
}

export interface WebhookPublishConfig {
  /** URL to POST to */
  url: string
  /** HTTP method (default POST) */
  method: 'POST' | 'PUT'
  /** Optional headers as key-value pairs */
  headers: Record<string, string>
  /** Optional shared secret for HMAC-SHA256 signature in X-Conduit-Signature header */
  secret?: string
}

export type PublishConfig = SlackPublishConfig | EmailPublishConfig | WebhookPublishConfig

export interface PublishTarget {
  id: string
  name: string
  type: PublishTargetType
  config: PublishConfig
  enabled: boolean
  ownerId?: string
  createdAt: number
  updatedAt: number
}

/** Connection-validation result for a publish target (mirrors McpHealthResult). */
export interface PublishTargetHealthResult {
  status: 'healthy' | 'unhealthy' | 'unauthorized'
  message: string
}

// ── Triggers ────────────────────────────────────────────────────────────────

export type TriggerType = 'cron' | 'slack' | 'webhook'

export interface CronTriggerConfig {
  expression: string
  timezone?: string
}

export interface SlackTriggerConfig {
  channelFilter?: string
}

export interface WebhookTriggerConfig {
  secret?: string
}

export type TriggerConfig = CronTriggerConfig | SlackTriggerConfig | WebhookTriggerConfig

export interface Trigger {
  id: string
  agentId: string
  name: string
  type: TriggerType
  config: TriggerConfig
  enabled: boolean
  lastTriggeredAt?: number
  createdAt: number
  updatedAt: number
}

export interface TriggerContext {
  triggerId: string
  triggerType: TriggerType
  payload?: string
  slackMeta?: {
    userId: string
    userName?: string
    channelId: string
    channelName?: string
    messageTs: string
    threadTs?: string
  }
}

export interface TriggerFiredPayload {
  triggerId: string
  agentId: string
  runId: string
  triggerType: TriggerType
}

// IPC API surface exposed via contextBridge
export interface ConduitAPI {
  agents: {
    list: () => Promise<AgentConfig[]>
    get: (id: string) => Promise<AgentConfig | null>
    create: (data: Omit<AgentConfig, 'id' | 'createdAt' | 'updatedAt'>) => Promise<AgentConfig>
    update: (id: string, data: Partial<Omit<AgentConfig, 'id' | 'createdAt' | 'updatedAt'>>) => Promise<AgentConfig>
    delete: (id: string) => Promise<void>
  }
  runs: {
    list: (agentId: string) => Promise<ExecutionRun[]>
    start: (agentId: string) => Promise<ExecutionRun>
    stop: (runId: string) => Promise<void>
    getLog: (runId: string) => Promise<LogEntry[]>
  }
  onOutput: (cb: (payload: RunOutputPayload) => void) => () => void
  onRunStatusChange: (cb: (payload: RunStatusChangePayload) => void) => () => void
  gist: {
    save: (content: string, gistId?: string) => Promise<string>
    load: (gistId: string) => Promise<string>
    list: () => Promise<GistSummary[]>
  }
  prefs: {
    get: <T>(key: string) => Promise<T | undefined>
    set: (key: string, value: unknown) => Promise<void>
  }
  shell: {
    openExternal: (url: string) => Promise<void>
  }
  globalMcps: {
    list: () => Promise<GlobalMcpServer[]>
    create: (data: Omit<GlobalMcpServer, 'id' | 'createdAt' | 'updatedAt'>) => Promise<GlobalMcpServer>
    update: (id: string, data: Partial<Omit<GlobalMcpServer, 'id' | 'createdAt' | 'updatedAt'>>) => Promise<GlobalMcpServer>
    delete: (id: string) => Promise<void>
    checkHealth: (serverConfig: McpServerEntry) => Promise<McpHealthResult>
    listTools: (serverConfig: McpServerEntry) => Promise<McpToolsResult>
  }
  runners: {
    /** Report which runner CLIs are installed and on the server's PATH. */
    checkCli: () => Promise<RunnerCliStatus[]>
  }
  repos: {
    list: () => Promise<Repository[]>
    get: (id: string) => Promise<Repository | null>
    create: (data: RepositoryInput) => Promise<Repository>
    update: (id: string, data: Partial<RepositoryInput>) => Promise<Repository>
    delete: (id: string) => Promise<void>
    triggerSync: (id: string) => Promise<void>
    testConnection: (data: RepoTestConnectionInput) => Promise<{ success: boolean; message: string }>
  }
  onRepoSyncStatus: (cb: (payload: RepoSyncStatusPayload) => void) => () => void
  publishTargets: {
    list: () => Promise<PublishTarget[]>
    get: (id: string) => Promise<PublishTarget | null>
    create: (data: Omit<PublishTarget, 'id' | 'createdAt' | 'updatedAt'>) => Promise<PublishTarget>
    update: (id: string, data: Partial<Omit<PublishTarget, 'id' | 'createdAt' | 'updatedAt'>>) => Promise<PublishTarget>
    delete: (id: string) => Promise<void>
    test: (type: PublishTargetType, config: PublishConfig) => Promise<{ success: boolean; error?: string }>
    checkHealth: (type: PublishTargetType, config: PublishConfig) => Promise<PublishTargetHealthResult>
  }
  triggers: {
    list: (agentId: string) => Promise<Trigger[]>
    get: (id: string) => Promise<Trigger | null>
    create: (data: Omit<Trigger, 'id' | 'createdAt' | 'updatedAt'>) => Promise<Trigger>
    update: (id: string, data: Partial<Omit<Trigger, 'id' | 'createdAt' | 'updatedAt'>>) => Promise<Trigger>
    delete: (id: string) => Promise<void>
  }
  onTriggerFired: (cb: (payload: TriggerFiredPayload) => void) => () => void
  mcpOAuth: {
    getStatus: (serverId: string, isGlobal: boolean) => Promise<McpOAuthStatus>
    startAuth: (serverId: string, isGlobal: boolean, redirectOrigin?: string) => Promise<{ authUrl: string }>
    revoke: (serverId: string, isGlobal: boolean) => Promise<void>
    probe: (serverConfig: McpServerEntry) => Promise<McpOAuthProbeResult>
  }
  onMcpOAuthComplete: (
    cb: (payload: { serverUrl: string; success: boolean; error?: string }) => void
  ) => () => void
  promptChat: {
    start: (agentId: string, runner: RunnerType) => Promise<string>
    send: (sessionId: string, message: string) => Promise<void>
    close: (sessionId: string) => Promise<void>
  }
  onPromptChatToken: (cb: (payload: { sessionId: string; token: string }) => void) => () => void
  onPromptChatDone: (cb: (payload: { sessionId: string; extractedPrompt?: string }) => void) => () => void
  onPromptChatError: (cb: (payload: { sessionId: string; error: string }) => void) => () => void
  shares: {
    list: (entityType: ShareableEntityType, entityId: string) => Promise<Share[]>
    create: (data: { entityType: ShareableEntityType; entityId: string; targetType: 'user' | 'group' | 'everyone'; targetId?: string }) => Promise<Share>
    delete: (shareId: string) => Promise<void>
  }
  users: {
    list: () => Promise<User[]>
    search: (query: string) => Promise<User[]>
  }
  groups: {
    list: () => Promise<Group[]>
  }
  onShareChange: (cb: (payload: { entityType: ShareableEntityType; entityId: string }) => void) => () => void
}

declare global {
  interface Window {
    conduit: ConduitAPI
  }
}
