import type { McpServersConfig, McpServerEntry, OAuthToken } from '../../shared/types'
import { listEnabledGlobalMcps } from '../db/queries/globalMcps'
import { getToken, saveToken } from '../db/queries/oauthTokens'
import { getClient } from '../db/queries/mcpOAuthClients'
import { refreshAccessToken, normalizeTokenScheme } from '../../server/mcpOAuth/flow'
import { auditMcpOAuth } from '../../server/mcpOAuth/audit'
import { isUrlMcpServer } from '../../shared/mcp'

const GLOBAL_OWNER = '__global__'

// Renew this many ms *before* the access token actually expires. Linear issues
// 24h access tokens and rejects a just-expired bearer; refreshing inside the
// skew window means health checks and run injection never present a token the
// provider already considers dead. Matches the Okta session skew pattern.
const REFRESH_SKEW_MS = 5 * 60_000

// Run injection bakes the bearer into the run's config for its whole life, and
// runs go for hours, so at launch renew anything that would die within this window.
const RUN_LAUNCH_REFRESH_SKEW_MS = 2 * 60 * 60_000

// Serialises concurrent refreshes of the same (url, owner). Providers that
// rotate refresh tokens (Linear, Auth0-style) invalidate the previous RT once
// a refresh succeeds — two racing refreshes make the loser get invalid_grant
// and the UI reads as "disconnected". Callers inside the skew window share one
// in-flight refresh, mirroring src/server/auth/session.ts.
const refreshLocks = new Map<string, Promise<OAuthToken | null>>()

export async function buildMergedMcpConfig(
  agentMcpConfig: McpServersConfig,
  _actingUserId: string
): Promise<{ config: McpServersConfig; globalUrls: Set<string> }> {
  const globalMcps = await listEnabledGlobalMcps()
  const globalServers: Record<string, McpServerEntry> = {}
  const globalUrls = new Set<string>()
  for (const g of globalMcps) {
    globalServers[g.serverKey] = g.serverConfig
    if (isUrlMcpServer(g.serverConfig)) globalUrls.add(g.serverConfig.url!)
  }
  return {
    config: { mcpServers: { ...globalServers, ...agentMcpConfig.mcpServers } },
    globalUrls,
  }
}

function needsRefresh(token: OAuthToken, skewMs = REFRESH_SKEW_MS): boolean {
  if (token.expiresAt === undefined) return false
  return token.expiresAt - Date.now() <= skewMs
}

function stillHardValid(token: OAuthToken): boolean {
  return token.expiresAt === undefined || token.expiresAt > Date.now()
}

async function refreshTokenForOwner(url: string, owner: string, skewMs: number): Promise<OAuthToken | null> {
  // Re-read under the lock: a just-finished refresh (or another pod) may have
  // already persisted a fresh pair before we started the network call.
  const current = await getToken(url, owner)
  if (!current) return null
  if (!needsRefresh(current, skewMs)) return current
  if (!current.refreshToken) return stillHardValid(current) ? current : null

  const client = await getClient(url)
  if (!client) return stillHardValid(current) ? current : null
  try {
    const refreshed = await refreshAccessToken({
      serverUrl: url,
      tokenEndpoint: client.tokenEndpoint,
      clientId: client.clientId,
      clientSecret: client.clientSecret,
      refreshToken: current.refreshToken,
      resource: client.resource,
    })
    await saveToken(refreshed, owner, null)
    auditMcpOAuth('token_refreshed', { serverUrl: url, owner, clientId: client.clientId })
    return refreshed
  } catch (err) {
    // Cross-pod race: another worker may have rotated+saved already. Prefer
    // that copy over declaring the connection dead — and skip the failure
    // audit/warn when we recovered, so logs stay meaningful.
    const latest = await getToken(url, owner)
    if (latest && !needsRefresh(latest, skewMs)) return latest
    if (latest && stillHardValid(latest)) return latest
    const msg = err instanceof Error ? err.message : String(err)
    auditMcpOAuth('token_refresh_failed', { serverUrl: url, owner, clientId: client.clientId, error: msg })
    console.warn(`[conduit] refresh failed for ${url} (${owner}):`, err)
    return null
  }
}

async function resolveValidToken(
  url: string,
  owner: string,
  skewMs = REFRESH_SKEW_MS
): Promise<OAuthToken | null> {
  const token = await getToken(url, owner)
  if (!token) return null
  if (!needsRefresh(token, skewMs)) return token
  if (!token.refreshToken) return stillHardValid(token) ? token : null

  const key = `${url}::${owner}`
  let lock = refreshLocks.get(key)
  if (!lock) {
    lock = refreshTokenForOwner(url, owner, skewMs).finally(() => refreshLocks.delete(key))
    refreshLocks.set(key, lock)
  }
  return lock
}

/**
 * Resolve a valid global OAuth token for a server URL (refreshing if expired),
 * or null if none/invalid. Used by the health check so it reflects real auth
 * state rather than an unauthenticated probe.
 */
export function resolveGlobalMcpToken(url: string): Promise<OAuthToken | null> {
  return resolveValidToken(url, GLOBAL_OWNER)
}

/**
 * Resolve a token for health / tools/list probes. Prefers the shared global
 * token (matching runtime injection for global MCPs), then falls back to the
 * acting user's per-agent token so agent-scoped OAuth (e.g. Linear on an agent)
 * is not falsely reported as disconnected.
 */
export async function resolveMcpTokenForUrl(
  url: string,
  actingUserId?: string
): Promise<OAuthToken | null> {
  const global = await resolveValidToken(url, GLOBAL_OWNER)
  if (global) return global
  if (actingUserId) return resolveValidToken(url, actingUserId)
  return null
}

// While a run is live its OAuth MCP tokens are re-resolved on this cadence and
// renewed when they would die within RUN_MCP_REFRESH_SKEW_MS. Providers such as
// Buildkite issue hour-long access tokens, far shorter than a long run.
export const RUN_MCP_REFRESH_INTERVAL_MS = 5 * 60_000
const RUN_MCP_REFRESH_SKEW_MS = 15 * 60_000

/** A run's MCP server whose Authorization header is a Conduit-managed OAuth bearer. */
export interface RunMcpOAuthServer {
  key: string
  url: string
  owner: string
  /** The Authorization value injected at launch. */
  authorization: string
}

function authorizationFor(token: OAuthToken): string {
  return `${normalizeTokenScheme(token.tokenType)} ${token.accessToken}`
}

export async function injectOAuthTokens(
  config: McpServersConfig,
  actingUserId: string,
  globalUrls: Set<string>,
  oauthServers?: RunMcpOAuthServer[]
): Promise<McpServersConfig> {
  const updated: Record<string, McpServerEntry> = {}
  for (const [key, entry] of Object.entries(config.mcpServers)) {
    if (isUrlMcpServer(entry)) {
      const owner = globalUrls.has(entry.url!) ? GLOBAL_OWNER : actingUserId
      const token = await resolveValidToken(entry.url!, owner, RUN_LAUNCH_REFRESH_SKEW_MS)
      if (token) {
        const authorization = authorizationFor(token)
        updated[key] = { ...entry, headers: { ...entry.headers, Authorization: authorization } }
        // Legacy SSE hands the client a second endpoint path, which the
        // worker's relay cannot route, so those keep the launch-time bearer.
        if (entry.type !== 'sse') oauthServers?.push({ key, url: entry.url!, owner, authorization })
        continue
      }
    }
    updated[key] = entry
  }
  return { mcpServers: updated }
}

/**
 * Current Authorization values for a run's OAuth MCP servers, renewing any
 * that would expire soon. Servers whose token is gone or unrefreshable are
 * omitted, so the worker keeps the last value it had.
 */
export async function resolveRunMcpAuth(servers: RunMcpOAuthServer[]): Promise<Record<string, string>> {
  const auth: Record<string, string> = {}
  for (const s of servers) {
    const token = await resolveValidToken(s.url, s.owner, RUN_MCP_REFRESH_SKEW_MS)
    if (token) auth[s.key] = authorizationFor(token)
  }
  return auth
}

import { writeMcpConfigContent } from './mcpConfigFile'

// Re-exported so existing callers (orchestrator, legacy Electron runner) keep
// their single import site; the implementations live in mcpConfigFile.ts,
// which is DB-free so the standalone conduit-worker can import it.
export { writeMcpConfigContent, deleteMcpConfig } from './mcpConfigFile'

/**
 * Materialize the run's merged MCP config (global servers + agent servers,
 * OAuth tokens injected, env vars expanded) as serialized JSON — without
 * writing it anywhere. The orchestrator uses this to build the RunSpec so the
 * config can travel to whatever worker executes the run.
 */
export async function buildMcpConfigContent(
  agentMcpConfig: McpServersConfig,
  actingUserId: string
): Promise<string> {
  return (await buildRunMcpConfig(agentMcpConfig, actingUserId)).content
}

/** As buildMcpConfigContent, plus the OAuth servers to keep refreshed for the run. */
export async function buildRunMcpConfig(
  agentMcpConfig: McpServersConfig,
  actingUserId: string
): Promise<{ content: string; oauthServers: RunMcpOAuthServer[] }> {
  const { config, globalUrls } = await buildMergedMcpConfig(agentMcpConfig, actingUserId)
  const oauthServers: RunMcpOAuthServer[] = []
  const withTokens = await injectOAuthTokens(config, actingUserId, globalUrls, oauthServers)
  const withEnv = resolveAllEnvVars(withTokens)
  return { content: JSON.stringify(withEnv, null, 2), oauthServers }
}

export async function writeMcpConfig(
  runId: string,
  agentMcpConfig: McpServersConfig,
  actingUserId: string
): Promise<string> {
  const content = await buildMcpConfigContent(agentMcpConfig, actingUserId)
  return writeMcpConfigContent(runId, content)
}

function expandEnvVars(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (match, name) => process.env[name] ?? match)
}

function resolveServerEnv(entry: McpServerEntry): McpServerEntry {
  const resolved: McpServerEntry = { ...entry }
  if (entry.env) {
    resolved.env = Object.fromEntries(
      Object.entries(entry.env).map(([k, v]) => [k, expandEnvVars(v)])
    )
  }
  if (entry.args) {
    resolved.args = entry.args.map(expandEnvVars)
  }
  return resolved
}

function resolveAllEnvVars(config: McpServersConfig): McpServersConfig {
  return {
    mcpServers: Object.fromEntries(
      Object.entries(config.mcpServers).map(([key, entry]) => [key, resolveServerEnv(entry)])
    ),
  }
}
