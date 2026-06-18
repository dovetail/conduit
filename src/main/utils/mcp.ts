import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import type { McpServersConfig, McpServerEntry } from '../../shared/types'
import { listEnabledGlobalMcps } from '../db/queries/globalMcps'
import { getToken } from '../db/queries/oauthTokens'

/**
 * Merges global MCP servers with agent-specific MCP config.
 * Global MCPs form the base layer; agent MCPs override on key conflict.
 */
export async function buildMergedMcpConfig(agentMcpConfig: McpServersConfig): Promise<McpServersConfig> {
  const globalMcps = await listEnabledGlobalMcps()
  const globalServers: Record<string, McpServerEntry> = {}
  for (const g of globalMcps) {
    globalServers[g.serverKey] = g.serverConfig
  }
  return {
    mcpServers: {
      ...globalServers,
      ...agentMcpConfig.mcpServers,
    },
  }
}

/**
 * For each URL-type MCP server in the config, look up any stored OAuth token
 * and inject it as an Authorization header if it is still valid.
 */
export async function injectOAuthTokens(config: McpServersConfig): Promise<McpServersConfig> {
  const updated: Record<string, McpServerEntry> = {}
  for (const [key, entry] of Object.entries(config.mcpServers)) {
    if (entry.type === 'url' && entry.url) {
      const token = await getToken(entry.url)
      if (token && (!token.expiresAt || token.expiresAt > Date.now())) {
        updated[key] = {
          ...entry,
          headers: {
            ...entry.headers,
            Authorization: `${token.tokenType} ${token.accessToken}`,
          },
        }
        continue
      }
    }
    updated[key] = entry
  }
  return { mcpServers: updated }
}

/**
 * Expands ${VAR_NAME} placeholders in MCP server config strings using process.env.
 * Applies to env values and args strings. Unset variables are left as-is.
 */
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

/**
 * Writes an MCP config JSON file to the OS temp directory.
 * Returns the path to the written file.
 */
export async function writeMcpConfig(runId: string, config: McpServersConfig): Promise<string> {
  const withTokens = await injectOAuthTokens(config)
  const withEnv = resolveAllEnvVars(withTokens)
  const filePath = path.join(os.tmpdir(), `conduit-mcp-${runId}.json`)
  fs.writeFileSync(filePath, JSON.stringify(withEnv, null, 2), 'utf8')
  return filePath
}

/**
 * Deletes the MCP config file for a given run. Silently ignores errors.
 */
export function deleteMcpConfig(runId: string): void {
  const filePath = path.join(os.tmpdir(), `conduit-mcp-${runId}.json`)
  try {
    fs.unlinkSync(filePath)
  } catch {
    // Ignore — file may have already been deleted or never created
  }
}
