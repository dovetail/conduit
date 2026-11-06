import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const resolveMcpAccessToken = vi.fn()
const touchMcpAccessToken = vi.fn(() => Promise.resolve())
vi.mock('../../main/db/queries/mcpAccessTokens', () => ({
  resolveMcpAccessToken: (...a: unknown[]) => resolveMcpAccessToken(...a),
  touchMcpAccessToken: (...a: unknown[]) => touchMcpAccessToken(...(a as [])),
}))
vi.mock('../../main/db/queries/groups', () => ({
  getUserGroupIds: () => Promise.resolve(['g1']),
}))

import { authenticateMcpRequest, parseBearer } from './auth'
import { isAllowedOrigin } from './http'

describe('parseBearer', () => {
  it('extracts the token', () => {
    expect(parseBearer('Bearer cdt_abc')).toBe('cdt_abc')
    expect(parseBearer('bearer   cdt_abc ')).toBe('cdt_abc')
    expect(parseBearer('Basic xyz')).toBeUndefined()
    expect(parseBearer(undefined)).toBeUndefined()
  })
})

describe('authenticateMcpRequest', () => {
  const saved = { ...process.env }
  beforeEach(() => {
    resolveMcpAccessToken.mockReset()
    touchMcpAccessToken.mockClear()
    delete process.env.CONDUIT_OKTA_ISSUER
    delete process.env.CONDUIT_MCP_REQUIRE_TOKEN
  })
  afterEach(() => {
    process.env = { ...saved }
  })

  it('allows tokenless calls as the dev user in dev-bypass mode', async () => {
    const res = await authenticateMcpRequest(undefined)
    expect(res).toMatchObject({ ok: true, caller: { userId: 'dev-user', scope: 'write', authKind: 'dev' } })
  })

  it('requires a token when auth is enabled or tokens are forced', async () => {
    process.env.CONDUIT_OKTA_ISSUER = 'https://okta.example'
    expect(await authenticateMcpRequest(undefined)).toMatchObject({ ok: false, status: 401 })
    delete process.env.CONDUIT_OKTA_ISSUER
    process.env.CONDUIT_MCP_REQUIRE_TOKEN = 'true'
    expect(await authenticateMcpRequest(undefined)).toMatchObject({ ok: false, status: 401 })
  })

  it('resolves a valid token to its user, groups, and scope', async () => {
    process.env.CONDUIT_OKTA_ISSUER = 'https://okta.example'
    resolveMcpAccessToken.mockResolvedValue({ id: 't1', userId: 'u1', name: 'laptop', scope: 'read' })
    const res = await authenticateMcpRequest('Bearer cdt_valid')
    expect(resolveMcpAccessToken).toHaveBeenCalledWith('cdt_valid')
    expect(res).toEqual({
      ok: true,
      caller: { userId: 'u1', userGroupIds: ['g1'], scope: 'read', authKind: 'token', tokenId: 't1', tokenName: 'laptop' },
    })
    expect(touchMcpAccessToken).toHaveBeenCalledTimes(1)
  })

  it('does not re-record use within the throttle window', async () => {
    resolveMcpAccessToken.mockResolvedValue({ id: 't1', userId: 'u1', name: 'n', scope: 'read', lastUsedAt: Date.now() })
    await authenticateMcpRequest('Bearer cdt_valid')
    expect(touchMcpAccessToken).not.toHaveBeenCalled()
  })

  it('rejects an unknown token even in dev mode', async () => {
    resolveMcpAccessToken.mockResolvedValue(null)
    expect(await authenticateMcpRequest('Bearer cdt_nope')).toMatchObject({ ok: false, status: 401 })
  })
})

describe('isAllowedOrigin', () => {
  it('allows non-browser requests and same-origin pages only', () => {
    expect(isAllowedOrigin(undefined, 'localhost:7456')).toBe(true)
    expect(isAllowedOrigin('http://localhost:7456', 'localhost:7456')).toBe(true)
    expect(isAllowedOrigin('https://evil.example', 'localhost:7456')).toBe(false)
    expect(isAllowedOrigin('null', 'localhost:7456')).toBe(false)
  })
})
