import { describe, it, expect } from 'vitest'
import { isUrlMcpServer } from './mcp'

describe('isUrlMcpServer', () => {
  it('treats type "url" with a url as URL-based', () => {
    expect(isUrlMcpServer({ type: 'url', url: 'https://x/mcp' })).toBe(true)
  })

  it('treats type "http" with a url as URL-based (regression: OAuth previously excluded these)', () => {
    expect(isUrlMcpServer({ type: 'http', url: 'https://mcp.sentry.dev/mcp' })).toBe(true)
  })

  it('treats streamable-http and sse transports as URL-based', () => {
    expect(isUrlMcpServer({ type: 'streamable-http', url: 'https://x/mcp' })).toBe(true)
    expect(isUrlMcpServer({ type: 'sse', url: 'https://x/sse' })).toBe(true)
  })

  it('treats a url with no explicit type as URL-based', () => {
    expect(isUrlMcpServer({ url: 'https://x/mcp' })).toBe(true)
  })

  it('is false for stdio servers', () => {
    expect(isUrlMcpServer({ type: 'stdio', command: 'npx', args: ['-y', 'server'] })).toBe(false)
  })

  it('is false when there is no url', () => {
    expect(isUrlMcpServer({ type: 'http' })).toBe(false)
    expect(isUrlMcpServer({ command: 'npx' })).toBe(false)
    expect(isUrlMcpServer(undefined)).toBe(false)
  })
})
