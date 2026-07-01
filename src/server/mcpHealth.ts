// src/server/mcpHealth.ts
import type { McpHealthResult } from '../shared/types'

/**
 * Map an HTTP response status from a reachable MCP URL to a health result.
 * 401/403 mean the endpoint is up but requires authentication.
 */
export function classifyUrlHealth(status: number, statusText: string): McpHealthResult {
  if (status === 401 || status === 403) {
    return { status: 'unauthorized', message: `HTTP ${status} ${statusText}` }
  }
  return { status: 'healthy', message: `HTTP ${status} ${statusText}` }
}
