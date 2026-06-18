import { eq, lt } from 'drizzle-orm'
import { getDb } from '../index'
import { sessions } from '../schema'

export async function createSession(data: {
  userId: string
  accessToken: string
  refreshToken?: string
  expiresAt: number
}) {
  const id = crypto.randomUUID()
  const now = Date.now()

  await getDb().insert(sessions).values({
    id,
    userId: data.userId,
    accessToken: data.accessToken,
    refreshToken: data.refreshToken ?? null,
    expiresAt: data.expiresAt,
    createdAt: now,
  })

  const rows = await getDb().select().from(sessions).where(eq(sessions.id, id))
  if (rows.length === 0) throw new Error(`Failed to create session with id ${id}`)
  return rows[0]
}

export async function getSession(id: string) {
  const rows = await getDb().select().from(sessions).where(eq(sessions.id, id))
  return rows[0] ?? null
}

export async function deleteSession(id: string): Promise<void> {
  await getDb().delete(sessions).where(eq(sessions.id, id))
}

export async function deleteExpiredSessions(): Promise<number> {
  const now = Date.now()
  const deleted = await getDb()
    .delete(sessions)
    .where(lt(sessions.expiresAt, now))
    .returning({ id: sessions.id })
  return deleted.length
}

export async function updateSessionTokens(
  id: string,
  data: { accessToken: string; refreshToken?: string; expiresAt: number }
): Promise<void> {
  await getDb().update(sessions).set({
    accessToken: data.accessToken,
    refreshToken: data.refreshToken ?? null,
    expiresAt: data.expiresAt,
  }).where(eq(sessions.id, id))
}
