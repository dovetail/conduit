import { and, desc, eq } from 'drizzle-orm'
import { getDb } from '../index'
import { promptRevisions } from '../schema'
import type { PromptRevision, PromptRevisionSource } from '../../../shared/types'

const UI_COALESCE_WINDOW_MS = 10 * 60 * 1000

function rowToRevision(row: typeof promptRevisions.$inferSelect): PromptRevision {
  return {
    id: row.id,
    agentId: row.agentId,
    prompt: row.prompt,
    source: row.source as PromptRevisionSource,
    note: row.note ?? undefined,
    createdBy: row.createdBy ?? undefined,
    createdAt: row.createdAt,
  }
}

/** Newest first. */
export async function listPromptRevisions(agentId: string, limit = 50): Promise<PromptRevision[]> {
  const rows = await getDb()
    .select()
    .from(promptRevisions)
    .where(eq(promptRevisions.agentId, agentId))
    .orderBy(desc(promptRevisions.createdAt))
    .limit(limit)
  return rows.map(rowToRevision)
}

export async function getPromptRevision(agentId: string, id: string): Promise<PromptRevision | null> {
  const rows = await getDb()
    .select()
    .from(promptRevisions)
    .where(and(eq(promptRevisions.id, id), eq(promptRevisions.agentId, agentId)))
  return rows[0] ? rowToRevision(rows[0]) : null
}

export interface PromptChange {
  agentId: string
  previousPrompt: string
  /** When the previous prompt took effect (the agent's prior updatedAt). */
  previousAt: number
  nextPrompt: string
  source: Exclude<PromptRevisionSource, 'baseline'>
  note?: string
  userId?: string
}

/**
 * Record a prompt change. No-op when the prompt is unchanged. The first recorded
 * change of an agent also stores the pre-change prompt as a 'baseline' revision,
 * so the version that existed before history tracking can still be restored.
 */
export async function recordPromptChange(change: PromptChange): Promise<PromptRevision | null> {
  if (change.previousPrompt === change.nextPrompt) return null
  const db = getDb()
  const latestRows = await db
    .select()
    .from(promptRevisions)
    .where(eq(promptRevisions.agentId, change.agentId))
    .orderBy(desc(promptRevisions.createdAt))
    .limit(1)
  const latest = latestRows[0]
  const now = Date.now()

  // The editor auto-saves on every typing pause; fold a burst of UI saves by the
  // same user into one revision instead of recording each keystroke batch.
  if (
    latest &&
    change.source === 'ui' &&
    latest.source === 'ui' &&
    latest.createdBy === (change.userId ?? null) &&
    now - latest.createdAt < UI_COALESCE_WINDOW_MS
  ) {
    await db
      .update(promptRevisions)
      .set({ prompt: change.nextPrompt, createdAt: now })
      .where(eq(promptRevisions.id, latest.id))
    return rowToRevision({ ...latest, prompt: change.nextPrompt, createdAt: now })
  }

  if (!latest) {
    await db.insert(promptRevisions).values({
      id: crypto.randomUUID(),
      agentId: change.agentId,
      prompt: change.previousPrompt,
      source: 'baseline',
      note: 'Prompt before revision history began',
      createdBy: null,
      // Strictly older than the new revision so ordering is stable.
      createdAt: Math.min(change.previousAt, now - 1),
    })
  }
  const row = {
    id: crypto.randomUUID(),
    agentId: change.agentId,
    prompt: change.nextPrompt,
    source: change.source,
    note: change.note?.trim() || null,
    createdBy: change.userId ?? null,
    createdAt: now,
  }
  await db.insert(promptRevisions).values(row)
  return rowToRevision(row)
}
