import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import type { McpServersConfig, McpServerEntry, OAuthToken } from '../../shared/types'
import { listEnabledGlobalMcps } from '../db/queries/globalMcps'
import { getToken, saveToken } from '../db/queries/oauthTokens'
import { getClient } from '../db/queries/mcpOAuthClients'
import { refreshAccessToken } from '../../server/mcpOAuth/flow'
import { isUrlMcpServer } from '../../shared/mcp'

const GLOBAL_OWNER = '__global__'

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

async function resolveValidToken(url: string, owner: string): Promise<OAuthToken | null> {
  const token = await getToken(url, owner)
  if (!token) return null
  const expired = token.expiresAt !== undefined && token.expiresAt <= Date.now()
  if (!expired) return token
  if (!token.refreshToken) return null
  const client = await getClient(url)
  if (!client) return null
  try {
    const refreshed = await refreshAccessToken({
      serverUrl: url,
      tokenEndpoint: client.tokenEndpoint,
      clientId: client.clientId,
      clientSecret: client.clientSecret,
      refreshToken: token.refreshToken,
    })
    await saveToken(refreshed, owner, null)
    return refreshed
  } catch (err) {
    console.warn(`[conduit] refresh failed for ${url} (${owner}):`, err)
    return null
  }
}

/**
 * Resolve a valid global OAuth token for a server URL (refreshing if expired),
 * or null if none/invalid. Used by the health check so it reflects real auth
 * state rather than an unauthenticated probe.
 */
export function resolveGlobalMcpToken(url: string): Promise<OAuthToken | null> {
  return resolveValidToken(url, GLOBAL_OWNER)
}

export async function injectOAuthTokens(
  config: McpServersConfig,
  actingUserId: string,
  globalUrls: Set<string>
): Promise<McpServersConfig> {
  const updated: Record<string, McpServerEntry> = {}
  for (const [key, entry] of Object.entries(config.mcpServers)) {
    if (isUrlMcpServer(entry)) {
      const owner = globalUrls.has(entry.url!) ? GLOBAL_OWNER : actingUserId
      const token = await resolveValidToken(entry.url!, owner)
      if (token) {
        updated[key] = {
          ...entry,
          headers: { ...entry.headers, Authorization: `${token.tokenType} ${token.accessToken}` },
        }
        continue
      }
    }
    updated[key] = entry
  }
  return { mcpServers: updated }
}

export async function writeMcpConfig(
  runId: string,
  agentMcpConfig: McpServersConfig,
  actingUserId: string
): Promise<string> {
  const { config, globalUrls } = await buildMergedMcpConfig(agentMcpConfig, actingUserId)
  const withTokens = await injectOAuthTokens(config, actingUserId, globalUrls)
  const withEnv = resolveAllEnvVars(withTokens)
  const filePath = path.join(os.tmpdir(), `conduit-mcp-${runId}.json`)
  fs.writeFileSync(filePath, JSON.stringify(withEnv, null, 2), 'utf8')
  return filePath
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

export function deleteMcpConfig(runId: string): void {
  const filePath = path.join(os.tmpdir(), `conduit-mcp-${runId}.json`)
  try {
    fs.unlinkSync(filePath)
  } catch {
    // Ignore — file may have already been deleted or never created
  }
}
