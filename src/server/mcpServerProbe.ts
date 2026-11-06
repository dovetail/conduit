import { isUrlMcpServer } from '../shared/mcp'
import { classifyUrlHealth, buildHealthProbeHeaders } from './mcpHealth'
import { listMcpTools } from './mcpTools'
import type { McpHealthResult, McpServerEntry, McpToolsResult } from '../shared/types'

/** `Authorization` value from a stored OAuth token (global, else the user's), if any. */
async function resolveOAuthAuthorization(url: string, userId: string): Promise<string | undefined> {
  try {
    const { resolveMcpTokenForUrl } = await import('../main/utils/mcp')
    const { normalizeTokenScheme } = await import('./mcpOAuth/flow')
    const token = await resolveMcpTokenForUrl(url, userId)
    if (token) return `${normalizeTokenScheme(token.tokenType)} ${token.accessToken}`
  } catch {
    // No token resolvable — callers fall back to the config's own headers.
  }
  return undefined
}

/**
 * Probe whether an MCP server is reachable and authorized, as the given user.
 *
 * URL servers get a real MCP `initialize` POST with the streamable-HTTP Accept
 * header: Streamable-HTTP servers (Linear/Sentry/Figma/…) reject a bare GET with
 * 405/406, which would read as a misleading failure once a valid token gets past
 * the 401. The config's own headers are carried (manual `Authorization`, or
 * Datadog-style API-key headers) and a resolved OAuth token overrides them —
 * matching run-time injection precedence. Stdio servers check the command is on
 * PATH.
 */
export async function checkMcpServerHealth(
  config: McpServerEntry,
  userId: string
): Promise<McpHealthResult> {
  if (isUrlMcpServer(config) && config.url) {
    try {
      const authOverride = await resolveOAuthAuthorization(config.url, userId)
      const headers = buildHealthProbeHeaders(config.headers, authOverride)
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 4000)
      const res = await fetch(config.url, {
        method: 'POST',
        signal: controller.signal,
        headers,
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-06-18',
            capabilities: {},
            clientInfo: { name: 'conduit-healthcheck', version: '1' },
          },
        }),
      })
      clearTimeout(timeout)
      return classifyUrlHealth(res.status, res.statusText)
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Connection failed'
      return { status: 'unhealthy', message: msg }
    }
  }

  const command = config.command ?? ''
  if (!command) return { status: 'unhealthy', message: 'No command configured' }

  try {
    const { execFileSync } = await import('child_process')
    // execFile (not exec) avoids shell interpretation of `command`.
    execFileSync('which', [command], { stdio: 'ignore' })
    return { status: 'healthy', message: `${command} found in PATH` }
  } catch {
    return { status: 'unhealthy', message: `${command} not found in PATH` }
  }
}

/**
 * List an MCP server's tools as the given user, injecting a stored OAuth token
 * so authenticated servers don't 401 on the initialize call.
 */
export async function listMcpServerTools(
  config: McpServerEntry,
  userId: string
): Promise<McpToolsResult> {
  let effective = config
  if (isUrlMcpServer(config) && config.url) {
    const authorization = await resolveOAuthAuthorization(config.url, userId)
    if (authorization) {
      effective = { ...config, headers: { ...config.headers, Authorization: authorization } }
    }
  }
  return listMcpTools(effective)
}
