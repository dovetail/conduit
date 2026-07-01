import type { McpServerEntry } from './types'

/**
 * Whether an MCP server is URL-based (a remote server reached over HTTP/SSE)
 * rather than a local stdio process.
 *
 * A server is URL-based when it carries a `url` and its transport isn't stdio.
 * This tolerates the various remote transport labels clients emit ('url',
 * 'http', 'streamable-http', 'sse') — historically the code compared strictly
 * to `type === 'url'`, which silently excluded 'http' servers from OAuth and
 * token injection even though the health check treated them as remote.
 */
export function isUrlMcpServer(cfg: McpServerEntry | undefined): boolean {
  return !!cfg && !!cfg.url && cfg.type !== 'stdio'
}
