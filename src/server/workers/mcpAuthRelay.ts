import http from 'http'
import https from 'https'
import type { AddressInfo } from 'net'
import { randomBytes, timingSafeEqual } from 'crypto'
import type { McpServersConfig } from '../../shared/types'

/**
 * Loopback relay for a run's OAuth MCP servers. The agent CLI reads its MCP
 * config once at startup, so a bearer baked into it dies with the access token
 * (an hour for some providers). Instead the config points those servers at
 * this relay with a per-run secret, and the relay forwards each request
 * upstream with whatever Authorization value it was last given.
 */
export interface McpAuthRelay {
  /** The MCP config with the relayed servers pointed at the relay. */
  readonly content: string
  update(auth: Record<string, string>): void
  close(): Promise<void>
}

interface Route {
  url: string
  authorization: string
}

// Never forwarded in either direction: connection-scoped, or replaced here.
const DROPPED_HEADERS = new Set([
  'authorization',
  'connection',
  'host',
  'keep-alive',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

function forwardableHeaders(headers: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
  const out: http.OutgoingHttpHeaders = {}
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined && !DROPPED_HEADERS.has(name.toLowerCase())) out[name] = value
  }
  return out
}

function matchesSecret(header: string | undefined, expected: Buffer): boolean {
  if (!header) return false
  const given = Buffer.from(header)
  return given.length === expected.length && timingSafeEqual(given, expected)
}

export async function startMcpAuthRelay(content: string, serverKeys: string[]): Promise<McpAuthRelay> {
  const config = JSON.parse(content) as McpServersConfig
  const routes = new Map<string, Route>()
  for (const key of serverKeys) {
    const entry = config.mcpServers[key]
    if (!entry?.url) continue
    const headers = { ...entry.headers }
    const authName = Object.keys(headers).find((h) => h.toLowerCase() === 'authorization')
    if (!authName) continue
    routes.set(key, { url: entry.url, authorization: headers[authName] })
  }

  const secret = randomBytes(32).toString('hex')
  const expectedAuth = Buffer.from(`Bearer ${secret}`)

  const server = http.createServer((req, res) => {
    const requestUrl = new URL(req.url ?? '/', 'http://relay')
    let key: string
    try {
      key = decodeURIComponent(requestUrl.pathname.slice(1))
    } catch {
      key = ''
    }
    const route = routes.get(key)
    if (!route) {
      res.writeHead(404).end()
      return
    }
    if (!matchesSecret(req.headers.authorization, expectedAuth)) {
      res.writeHead(401).end()
      return
    }

    const target = new URL(route.url)
    for (const [name, value] of requestUrl.searchParams) target.searchParams.append(name, value)
    const headers = forwardableHeaders(req.headers)
    headers.authorization = route.authorization

    const upstream = (target.protocol === 'https:' ? https : http).request(
      target,
      { method: req.method, headers },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 502, forwardableHeaders(upstreamRes.headers))
        upstreamRes.pipe(res)
      }
    )
    upstream.on('error', (err) => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' })
      res.end(`Conduit MCP relay could not reach ${target.origin}: ${err.message}`)
    })
    // A client that hangs up (e.g. drops an SSE stream) must not leave the
    // upstream request open.
    res.on('close', () => upstream.destroy())
    req.pipe(upstream)
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const { port } = server.address() as AddressInfo

  for (const key of routes.keys()) {
    const entry = config.mcpServers[key]
    const headers = Object.fromEntries(
      Object.entries(entry.headers ?? {}).filter(([h]) => h.toLowerCase() !== 'authorization')
    )
    config.mcpServers[key] = {
      ...entry,
      url: `http://127.0.0.1:${port}/${encodeURIComponent(key)}`,
      headers: { ...headers, Authorization: `Bearer ${secret}` },
    }
  }

  return {
    content: JSON.stringify(config, null, 2),
    update(auth) {
      for (const [key, authorization] of Object.entries(auth)) {
        const route = routes.get(key)
        if (route) route.authorization = authorization
      }
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
      }),
  }
}
