import { resolveMcpAccessToken, touchMcpAccessToken } from '../../main/db/queries/mcpAccessTokens'
import { getUserGroupIds } from '../../main/db/queries/groups'
import { isAuthEnabled } from '../auth/config'
import { getDevContext } from '../auth/devBypass'
import type { McpCaller } from './context'

/** lastUsedAt is informational; don't write it on every request. */
const TOUCH_INTERVAL_MS = 60_000

export type McpAuthResult =
  | { ok: true; caller: McpCaller }
  | { ok: false; status: 401; error: string }

export function parseBearer(header: string | undefined): string | undefined {
  if (!header) return undefined
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header)
  return match?.[1]
}

/** Whether a request without a token is allowed (dev-bypass mode, unless tokens are forced). */
export function allowsAnonymousMcp(env: NodeJS.ProcessEnv = process.env): boolean {
  return !isAuthEnabled() && env.CONDUIT_MCP_REQUIRE_TOKEN !== 'true'
}

/**
 * Resolve the caller of an MCP request. A presented token is always validated
 * (even in dev mode), and its scope applies. Without a token, only dev-bypass
 * mode is allowed, acting as the synthetic dev user with write scope — the
 * same trust the unauthenticated browser WebSocket gets in that mode.
 */
export async function authenticateMcpRequest(authorization: string | undefined): Promise<McpAuthResult> {
  const plaintext = parseBearer(authorization)
  if (!plaintext) {
    if (allowsAnonymousMcp()) {
      return { ok: true, caller: { ...getDevContext(), scope: 'write', authKind: 'dev' } }
    }
    return {
      ok: false,
      status: 401,
      error: 'Missing bearer token. Create a Conduit MCP access token in Settings and send it as "Authorization: Bearer <token>".',
    }
  }

  const token = await resolveMcpAccessToken(plaintext)
  if (!token) return { ok: false, status: 401, error: 'Invalid, expired, or revoked MCP access token.' }

  const now = Date.now()
  if (!token.lastUsedAt || now - token.lastUsedAt > TOUCH_INTERVAL_MS) {
    touchMcpAccessToken(token.id, now).catch((err) =>
      console.warn('[mcp] Failed to record token use:', err)
    )
  }

  return {
    ok: true,
    caller: {
      userId: token.userId,
      userGroupIds: await getUserGroupIds(token.userId),
      scope: token.scope,
      authKind: 'token',
      tokenId: token.id,
      tokenName: token.name,
    },
  }
}
