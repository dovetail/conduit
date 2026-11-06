/**
 * conduit-mcp-stdio — relays an MCP client's stdio session to a Conduit
 * server's Streamable-HTTP `/api/mcp` endpoint, for clients that can only launch
 * local MCP servers. stdout carries the protocol, so diagnostics go to stderr.
 *
 * Env: CONDUIT_MCP_URL (default http://localhost:7456/api/mcp), CONDUIT_MCP_TOKEN.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import { CONDUIT_MCP_HTTP_PATH } from '../shared/types'

const url = new URL(process.env.CONDUIT_MCP_URL ?? `http://localhost:7456${CONDUIT_MCP_HTTP_PATH}`)
const token = process.env.CONDUIT_MCP_TOKEN

const upstream = new StreamableHTTPClientTransport(url, {
  requestInit: { headers: token ? { Authorization: `Bearer ${token}` } : {} },
})
const local = new StdioServerTransport()

function requestId(msg: JSONRPCMessage): string | number | undefined {
  return 'id' in msg && 'method' in msg ? msg.id : undefined
}

local.onmessage = (msg) => {
  upstream.send(msg).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[conduit-mcp-stdio] ${message}`)
    const id = requestId(msg)
    // Answer the request so the client doesn't hang waiting on a dead upstream.
    if (id !== undefined) {
      local.send({ jsonrpc: '2.0', id, error: { code: -32000, message: `Conduit MCP request failed: ${message}` } }).catch(() => {})
    }
  })
}
upstream.onmessage = (msg) => {
  local.send(msg).catch((err) => console.error('[conduit-mcp-stdio] stdout write failed:', err))
}
upstream.onerror = (err) => console.error('[conduit-mcp-stdio] upstream error:', err.message)

let closing = false
async function shutdown(code: number): Promise<void> {
  if (closing) return
  closing = true
  await upstream.close().catch(() => {})
  await local.close().catch(() => {})
  process.exit(code)
}
local.onclose = () => void shutdown(0)
process.stdin.on('end', () => void shutdown(0))
process.on('SIGINT', () => void shutdown(0))
process.on('SIGTERM', () => void shutdown(0))

async function main(): Promise<void> {
  await upstream.start()
  await local.start()
  console.error(`[conduit-mcp-stdio] relaying stdio to ${url.href}${token ? '' : ' (no token)'}`)
}

main().catch((err) => {
  console.error('[conduit-mcp-stdio] failed to start:', err)
  process.exit(1)
})
