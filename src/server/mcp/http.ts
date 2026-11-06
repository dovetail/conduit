import express, { Router, type Request, type Response } from 'express'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { reporter } from '../observability'
import { authenticateMcpRequest } from './auth'
import type { McpDeps } from './context'
import { createConduitMcpServer } from './server'

export function isMcpEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CONDUIT_MCP_ENABLED !== 'false'
}

function jsonRpcError(res: Response, status: number, message: string, headers: Record<string, string> = {}): void {
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v)
  res.status(status).json({ jsonrpc: '2.0', error: { code: -32000, message }, id: null })
}

/**
 * Browsers attach an Origin header; MCP clients don't. A cross-origin Origin
 * means a web page is trying to drive the endpoint (DNS rebinding / CSRF
 * against a local dev server) — reject it, as the MCP transport spec advises.
 */
export function isAllowedOrigin(origin: string | undefined, host: string | undefined): boolean {
  if (!origin) return true
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

/**
 * Streamable-HTTP MCP endpoint, stateless: every POST builds a server bound to
 * the authenticated caller, handles the JSON-RPC message(s), and is discarded.
 * Stateless keeps it correct behind a multi-pod load balancer (no session
 * affinity) and means a revoked token stops working on the very next request.
 */
export function createMcpRouter(deps: McpDeps): Router {
  const router = Router()

  router.all('/', (req, res, next) => {
    if (!isAllowedOrigin(req.headers.origin, req.headers.host)) {
      jsonRpcError(res, 403, 'Cross-origin requests to the MCP endpoint are not allowed.')
      return
    }
    next()
  })

  router.post('/', express.json({ limit: '4mb' }), async (req: Request, res: Response) => {
    const auth = await authenticateMcpRequest(req.headers.authorization)
    if (!auth.ok) {
      jsonRpcError(res, auth.status, auth.error, { 'WWW-Authenticate': 'Bearer realm="conduit-mcp"' })
      return
    }

    const server = createConduitMcpServer(auth.caller, deps)
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    })
    res.on('close', () => {
      transport.close().catch(() => {})
      server.close().catch(() => {})
    })
    try {
      await server.connect(transport)
      await transport.handleRequest(req, res, req.body)
    } catch (err) {
      reporter.captureException(err, { tags: { component: 'mcp', op: 'handleRequest' }, user: { id: auth.caller.userId } })
      if (!res.headersSent) jsonRpcError(res, 500, 'Internal server error')
    }
  })

  // Stateless server: no server-initiated SSE stream and no sessions to end.
  const methodNotAllowed = (_req: Request, res: Response) =>
    jsonRpcError(res, 405, 'Method not allowed. Send MCP JSON-RPC messages with POST.', { Allow: 'POST' })
  router.get('/', methodNotAllowed)
  router.delete('/', methodNotAllowed)

  return router
}
