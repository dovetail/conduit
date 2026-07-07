import { eq, lt } from 'drizzle-orm'
import { getDb } from '../index'
import { mcpOAuthPending } from '../schema'
import { encryptSecret, decryptSecret } from '../../../server/crypto'
import type { PendingAuth } from '../../../server/mcpOAuth/state'

/** Pending OAuth state lifetime — a user has this long to complete the flow. */
export const PENDING_TTL_MS = 10 * 60 * 1000

/**
 * Persist pending OAuth state, keyed by the `state` param. The payload (which
 * includes the PKCE verifier and client secret) is encrypted at rest. Upserts so
 * a retried startAuth for the same state overwrites cleanly.
 */
export async function putPendingAuth(state: string, entry: PendingAuth): Promise<void> {
  const dataEnc = encryptSecret(JSON.stringify(entry))
  await getDb()
    .insert(mcpOAuthPending)
    .values({ state, dataEnc, createdAt: entry.createdAt })
    .onConflictDoUpdate({
      target: mcpOAuthPending.state,
      set: { dataEnc, createdAt: entry.createdAt },
    })
}

/**
 * Atomically consume the pending state: delete-and-return in one statement so a
 * given `state` can be redeemed exactly once (no replay), even across pods.
 * Returns null when the state is unknown or has expired.
 */
export async function takePendingAuth(state: string): Promise<PendingAuth | null> {
  const rows = await getDb()
    .delete(mcpOAuthPending)
    .where(eq(mcpOAuthPending.state, state))
    .returning()
  const row = rows[0]
  if (!row) return null
  if (Date.now() - row.createdAt > PENDING_TTL_MS) return null
  try {
    return JSON.parse(decryptSecret(row.dataEnc)) as PendingAuth
  } catch {
    return null
  }
}

/** Remove expired pending rows (hygiene; consumed rows are already deleted). */
export async function deleteExpiredPendingAuth(): Promise<number> {
  const deleted = await getDb()
    .delete(mcpOAuthPending)
    .where(lt(mcpOAuthPending.createdAt, Date.now() - PENDING_TTL_MS))
    .returning({ state: mcpOAuthPending.state })
  return deleted.length
}
