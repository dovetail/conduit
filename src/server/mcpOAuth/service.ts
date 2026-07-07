import * as crypto from 'crypto'
import type { McpOAuthConfig, McpOAuthProbeResult, McpOAuthStatus, McpServerEntry } from '../../shared/types'
import { getGlobalMcp } from '../../main/db/queries/globalMcps'
import { getAgent } from '../../main/db/queries/agents'
import { canAccessEntity, isEntityOwner } from '../../main/db/queries/access'
import { getTokenStatus, saveToken, deleteToken, getConnectedByUserId } from '../../main/db/queries/oauthTokens'
import { discoverOAuthEndpoints, ensureRegisteredClient } from './discovery'
import { generatePkce, buildAuthorizationUrl, exchangeCode } from './flow'
import { putPending, takePending } from './state'
import { isUrlMcpServer } from '../../shared/mcp'

const GLOBAL_OWNER = '__global__'

/**
 * Build the OAuth callback URL. This MUST be a single, stable value per
 * deployment: OAuth providers register it at DCR time and then reject any auth /
 * token request whose `redirect_uri` isn't byte-identical (Sentry → "Invalid
 * redirect URI"; Datadog, OAuth 2.1 → "Mismatching redirect URI").
 *
 * So `CONDUIT_BASE_URL` (the canonical public URL) takes precedence — it does not
 * vary with how the user reached the console. The browser origin is only a
 * fallback for local dev where `CONDUIT_BASE_URL` is unset (there it equals
 * `http://localhost:7456`), and localhost is the last resort.
 *
 * Production MUST set `CONDUIT_BASE_URL` to the public hostname; otherwise a user
 * on a different origin would derive a different redirect URI and break DCR.
 */
export function getRedirectUri(origin?: string): string {
  const raw = process.env.CONDUIT_BASE_URL || origin?.trim() || 'http://localhost:7456'
  const base = raw.replace(/\/$/, '')
  return `${base}/mcp/oauth/callback`
}

interface ServerTarget {
  serverUrl: string
  oauthConfig?: McpOAuthConfig
  tokenOwner: string
  scope: 'user' | 'global'
  parentEntityType: 'globalMcpServer' | 'agent'
  parentEntityId: string
}

export async function resolveServerTarget(serverId: string, isGlobal: boolean, userId: string): Promise<ServerTarget> {
  if (isGlobal) {
    const g = await getGlobalMcp(serverId)
    if (!g) throw new Error(`Global MCP server ${serverId} not found`)
    const cfg = g.serverConfig
    if (!isUrlMcpServer(cfg)) throw new Error('MCP server is not a URL-type server')
    return { serverUrl: cfg.url!, oauthConfig: cfg.oauth, tokenOwner: GLOBAL_OWNER, scope: 'global', parentEntityType: 'globalMcpServer', parentEntityId: g.id }
  }
  const [agentId, serverKey] = serverId.split(':')
  const agent = await getAgent(agentId)
  if (!agent) throw new Error(`Agent ${agentId} not found`)
  const entry: McpServerEntry | undefined = agent.mcpConfig.mcpServers[serverKey]
  if (!isUrlMcpServer(entry)) throw new Error(`Agent MCP server ${serverKey} is not a URL-type server`)
  return { serverUrl: entry!.url!, oauthConfig: entry!.oauth, tokenOwner: userId, scope: 'user', parentEntityType: 'agent', parentEntityId: agentId }
}

async function assertAccess(t: ServerTarget, userId: string, userGroupIds: string[]): Promise<void> {
  if (!(await canAccessEntity(t.parentEntityType, t.parentEntityId, userId, userGroupIds))) {
    throw new Error('Access denied')
  }
}

export async function startAuth(serverId: string, isGlobal: boolean, userId: string, userGroupIds: string[] = [], redirectOrigin?: string): Promise<{ authUrl: string }> {
  const t = await resolveServerTarget(serverId, isGlobal, userId)
  await assertAccess(t, userId, userGroupIds)
  const redirectUri = getRedirectUri(redirectOrigin)
  const client = await ensureRegisteredClient(t.serverUrl, t.oauthConfig, redirectUri)
  const { verifier, challenge } = generatePkce()
  const state = crypto.randomBytes(16).toString('hex')
  await putPending(state, {
    codeVerifier: verifier,
    serverUrl: t.serverUrl,
    tokenOwner: t.tokenOwner,
    connectedByUserId: userId,
    clientId: client.clientId,
    clientSecret: client.clientSecret,
    redirectUri,
    tokenEndpoint: client.tokenEndpoint,
    resource: client.resource,
    createdAt: Date.now(),
  })
  const authUrl = buildAuthorizationUrl({
    authorizationEndpoint: client.authorizationEndpoint,
    clientId: client.clientId,
    redirectUri,
    scopes: t.oauthConfig?.scopes ?? [],
    state,
    challenge,
    resource: client.resource,
  })
  return { authUrl }
}

export async function getStatus(serverId: string, isGlobal: boolean, userId: string, userGroupIds: string[] = []): Promise<McpOAuthStatus> {
  const t = await resolveServerTarget(serverId, isGlobal, userId)
  await assertAccess(t, userId, userGroupIds)
  return getTokenStatus(t.serverUrl, t.tokenOwner, t.scope)
}

export async function revoke(serverId: string, isGlobal: boolean, userId: string, userGroupIds: string[] = []): Promise<void> {
  const t = await resolveServerTarget(serverId, isGlobal, userId)
  await assertAccess(t, userId, userGroupIds)
  if (t.scope === 'global') {
    // Global tokens: only the global MCP owner or the connector may revoke.
    const connectedBy = await getConnectedByUserId(t.serverUrl, t.tokenOwner)
    const owns = await isEntityOwner('globalMcpServer', t.parentEntityId, userId)
    if (!owns && connectedBy !== userId) throw new Error('Only the owner or the connecting user can revoke this token')
  }
  await deleteToken(t.serverUrl, t.tokenOwner)
}

export async function probeOAuthSupport(config: McpServerEntry): Promise<McpOAuthProbeResult> {
  if (!isUrlMcpServer(config)) {
    return { supportsOAuth: false, supportsDcr: false }
  }
  try {
    const meta = await discoverOAuthEndpoints(config.url!)
    return { supportsOAuth: true, supportsDcr: !!meta.registration_endpoint }
  } catch {
    // Discovery failed — do a lightweight probe to detect 401/403.
    try {
      const res = await fetch(config.url!, {
        method: 'GET',
        headers: { Accept: '*/*' },
        signal: AbortSignal.timeout(5000),
      })
      if (res.status === 401 || res.status === 403) {
        return { supportsOAuth: true, supportsDcr: false }
      }
    } catch {
      // network error — fall through
    }
    return { supportsOAuth: false, supportsDcr: false }
  }
}

/** Handle the OAuth redirect. Pure enough to unit test; the route wraps it. */
export async function handleCallback(query: Record<string, string | undefined>): Promise<{ ok: boolean; serverUrl?: string; error?: string }> {
  const { code, state, error, error_description } = query
  if (!state) return { ok: false, error: 'Missing state' }
  const pending = await takePending(state)
  if (!pending) return { ok: false, error: 'Invalid or expired state' }
  if (error) return { ok: false, serverUrl: pending.serverUrl, error: error_description ?? error }
  if (!code) return { ok: false, serverUrl: pending.serverUrl, error: 'No authorization code' }
  try {
    const token = await exchangeCode({
      serverUrl: pending.serverUrl,
      tokenEndpoint: pending.tokenEndpoint,
      clientId: pending.clientId,
      clientSecret: pending.clientSecret,
      code,
      redirectUri: pending.redirectUri,
      verifier: pending.codeVerifier,
      resource: pending.resource,
    })
    await saveToken(token, pending.tokenOwner, pending.connectedByUserId)
    return { ok: true, serverUrl: pending.serverUrl }
  } catch (err) {
    return { ok: false, serverUrl: pending.serverUrl, error: err instanceof Error ? err.message : String(err) }
  }
}
