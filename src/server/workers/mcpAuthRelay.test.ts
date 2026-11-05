import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import http from 'http'
import type { AddressInfo } from 'net'
import type { McpServersConfig } from '../../shared/types'
import { startMcpAuthRelay, type McpAuthRelay } from './mcpAuthRelay'

interface Seen {
  method?: string
  url?: string
  authorization?: string
  sessionId?: string
  body: string
}

describe('startMcpAuthRelay', () => {
  let upstream: http.Server
  let upstreamUrl: string
  let seen: Seen[]
  let relay: McpAuthRelay | undefined

  beforeEach(async () => {
    seen = []
    upstream = http.createServer((req, res) => {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        seen.push({
          method: req.method,
          url: req.url,
          authorization: req.headers.authorization,
          sessionId: req.headers['mcp-session-id'] as string | undefined,
          body,
        })
        res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'sess-1' })
        res.end('{"ok":true}')
      })
    })
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
    upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/mcp?org=acme`
  })

  afterEach(async () => {
    await relay?.close()
    relay = undefined
    await new Promise<void>((resolve) => upstream.close(() => resolve()))
  })

  function config(): string {
    const cfg: McpServersConfig = {
      mcpServers: {
        buildkite: { type: 'http', url: upstreamUrl, headers: { authorization: 'Bearer tok_1', 'X-Extra': 'kept' } },
        static: { type: 'http', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer pat' } },
      },
    }
    return JSON.stringify(cfg)
  }

  async function start(): Promise<McpServersConfig> {
    relay = await startMcpAuthRelay(config(), ['buildkite'])
    return JSON.parse(relay.content) as McpServersConfig
  }

  it('points only the listed servers at the loopback relay, behind a per-run secret', async () => {
    const cfg = await start()
    const relayed = cfg.mcpServers.buildkite
    expect(relayed.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/buildkite$/)
    expect(relayed.headers).toEqual({ 'X-Extra': 'kept', Authorization: expect.stringMatching(/^Bearer [0-9a-f]{64}$/) })
    expect(cfg.mcpServers.static).toEqual({
      type: 'http',
      url: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer pat' },
    })
  })

  it('forwards requests upstream with the current token, swapping it on update', async () => {
    const cfg = await start()
    const { url, headers } = cfg.mcpServers.buildkite
    const call = (): Promise<Response> =>
      fetch(url!, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json', 'mcp-session-id': 'sess-1' },
        body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
      })

    const first = await call()
    expect(first.status).toBe(200)
    expect(first.headers.get('mcp-session-id')).toBe('sess-1')
    expect(await first.json()).toEqual({ ok: true })

    relay!.update({ buildkite: 'Bearer tok_2', unknown: 'Bearer nope' })
    await (await call()).text()

    expect(seen.map((s) => s.authorization)).toEqual(['Bearer tok_1', 'Bearer tok_2'])
    expect(seen[0]).toMatchObject({
      method: 'POST',
      url: '/mcp?org=acme',
      sessionId: 'sess-1',
      body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
    })
  })

  it('rejects callers without the run secret and unknown servers', async () => {
    const cfg = await start()
    const url = cfg.mcpServers.buildkite.url!
    expect((await fetch(url, { headers: { Authorization: 'Bearer wrong' } })).status).toBe(401)
    expect((await fetch(url)).status).toBe(401)
    const other = url.replace(/\/buildkite$/, '/static')
    expect((await fetch(other, { headers: cfg.mcpServers.buildkite.headers })).status).toBe(404)
    expect(seen).toEqual([])
  })

  it('answers 502 when the upstream is unreachable', async () => {
    const cfg = await start()
    await new Promise<void>((resolve) => upstream.close(() => resolve()))
    upstream = http.createServer()
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
    const res = await fetch(cfg.mcpServers.buildkite.url!, { headers: cfg.mcpServers.buildkite.headers })
    expect(res.status).toBe(502)
  })
})
