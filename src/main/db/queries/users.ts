import { eq, ilike, or } from 'drizzle-orm'
import { getDb } from '../index'
import { users } from '../schema'
import type { User } from '../../../shared/types'

function rowToUser(row: typeof users.$inferSelect): User {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    avatarUrl: row.avatarUrl ?? undefined,
    lastLoginAt: row.lastLoginAt,
    createdAt: row.createdAt,
  }
}

export async function upsertUser(data: {
  id: string
  email: string
  name: string
  avatarUrl?: string
}): Promise<User> {
  const now = Date.now()

  await getDb().insert(users).values({
    id: data.id,
    email: data.email,
    name: data.name,
    avatarUrl: data.avatarUrl ?? null,
    lastLoginAt: now,
    createdAt: now,
  }).onConflictDoUpdate({
    target: users.id,
    set: {
      email: data.email,
      name: data.name,
      avatarUrl: data.avatarUrl ?? null,
      lastLoginAt: now,
    },
  })

  const rows = await getDb().select().from(users).where(eq(users.id, data.id))
  if (rows.length === 0) throw new Error(`Failed to upsert user with id ${data.id}`)
  return rowToUser(rows[0])
}

export async function getUser(id: string): Promise<User | null> {
  const rows = await getDb().select().from(users).where(eq(users.id, id))
  if (rows.length === 0) return null
  return rowToUser(rows[0])
}

export async function listUsers(): Promise<User[]> {
  const rows = await getDb().select().from(users)
  return rows.map(rowToUser)
}

export async function searchUsers(query: string): Promise<User[]> {
  const pattern = `%${query}%`
  const rows = await getDb()
    .select()
    .from(users)
    .where(or(ilike(users.name, pattern), ilike(users.email, pattern)))
  return rows.map(rowToUser)
}
