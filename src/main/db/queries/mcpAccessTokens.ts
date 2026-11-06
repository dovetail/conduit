import * as crypto from 'crypto'
import { and, desc, eq, isNull } from 'drizzle-orm'
import { getDb } from '../index'
import { mcpAccessTokens } from '../schema'
import { ClientError } from '../../../server/errors'
import type {
  CreatedMcpAccessToken,
  McpAccessToken,
  McpAccessTokenInput,
  McpAccessTokenScope,
} from '../../../shared/types'

export const MCP_TOKEN_PREFIX = 'cdt_'
const DISPLAY_PREFIX_LENGTH = MCP_TOKEN_PREFIX.length + 6
const MAX_EXPIRY_DAYS = 3650
const DAY_MS = 24 * 60 * 60 * 1000

export function hashMcpToken(plaintext: string): string {
  return crypto.createHash('sha256').update(plaintext, 'utf8').digest('hex')
}

export function generateMcpTokenPlaintext(): string {
  return MCP_TOKEN_PREFIX + crypto.randomBytes(32).toString('base64url')
}

function rowToToken(row: typeof mcpAccessTokens.$inferSelect): McpAccessToken {
  return {
    id: row.id,
    name: row.name,
    tokenPrefix: row.tokenPrefix,
    scope: row.scope as McpAccessTokenScope,
    expiresAt: row.expiresAt ?? undefined,
    lastUsedAt: row.lastUsedAt ?? undefined,
    createdAt: row.createdAt,
  }
}

export async function listMcpAccessTokens(userId: string): Promise<McpAccessToken[]> {
  const rows = await getDb()
    .select()
    .from(mcpAccessTokens)
    .where(and(eq(mcpAccessTokens.userId, userId), isNull(mcpAccessTokens.revokedAt)))
    .orderBy(desc(mcpAccessTokens.createdAt))
  return rows.map(rowToToken)
}

export async function createMcpAccessToken(
  userId: string,
  input: McpAccessTokenInput
): Promise<CreatedMcpAccessToken> {
  const name = input.name?.trim()
  if (!name) throw new ClientError('A token name is required.')
  if (input.scope !== 'read' && input.scope !== 'write') {
    throw new ClientError("Token scope must be 'read' or 'write'.")
  }
  const days = Math.floor(Number(input.expiresInDays ?? 0))
  if (!Number.isFinite(days) || days < 0 || days > MAX_EXPIRY_DAYS) {
    throw new ClientError(`Expiry must be between 0 (never) and ${MAX_EXPIRY_DAYS} days.`)
  }

  const now = Date.now()
  const plaintext = generateMcpTokenPlaintext()
  const row = {
    id: crypto.randomUUID(),
    userId,
    name,
    tokenHash: hashMcpToken(plaintext),
    tokenPrefix: plaintext.slice(0, DISPLAY_PREFIX_LENGTH),
    scope: input.scope,
    expiresAt: days > 0 ? now + days * DAY_MS : null,
    lastUsedAt: null,
    revokedAt: null,
    createdAt: now,
  }
  await getDb().insert(mcpAccessTokens).values(row)
  return { token: rowToToken(row), plaintext }
}

/** Revoke one of the user's tokens. Returns false when no such active token exists. */
export async function revokeMcpAccessToken(userId: string, id: string): Promise<boolean> {
  const rows = await getDb()
    .update(mcpAccessTokens)
    .set({ revokedAt: Date.now() })
    .where(
      and(
        eq(mcpAccessTokens.id, id),
        eq(mcpAccessTokens.userId, userId),
        isNull(mcpAccessTokens.revokedAt)
      )
    )
    .returning({ id: mcpAccessTokens.id })
  return rows.length > 0
}

export interface ResolvedMcpAccessToken {
  id: string
  userId: string
  name: string
  scope: McpAccessTokenScope
  lastUsedAt?: number
}

/** Look up a presented plaintext token. Null when unknown, revoked, or expired. */
export async function resolveMcpAccessToken(
  plaintext: string,
  now: number = Date.now()
): Promise<ResolvedMcpAccessToken | null> {
  if (!plaintext.startsWith(MCP_TOKEN_PREFIX)) return null
  const rows = await getDb()
    .select()
    .from(mcpAccessTokens)
    .where(eq(mcpAccessTokens.tokenHash, hashMcpToken(plaintext)))
  const row = rows[0]
  if (!row || row.revokedAt != null) return null
  if (row.expiresAt != null && row.expiresAt <= now) return null
  return {
    id: row.id,
    userId: row.userId,
    name: row.name,
    scope: row.scope as McpAccessTokenScope,
    lastUsedAt: row.lastUsedAt ?? undefined,
  }
}

export async function touchMcpAccessToken(id: string, now: number = Date.now()): Promise<void> {
  await getDb().update(mcpAccessTokens).set({ lastUsedAt: now }).where(eq(mcpAccessTokens.id, id))
}
