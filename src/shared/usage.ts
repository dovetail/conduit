import type { RunUsage } from './types'

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

function num(...candidates: unknown[]): number | undefined {
  for (const c of candidates) {
    if (typeof c === 'number' && Number.isFinite(c) && c >= 0) return c
  }
  return undefined
}

/**
 * Extract metering from a CLI's terminal `result` stream event. Claude Code
 * reports snake_case (`total_cost_usd`, `usage.input_tokens`, …), Cursor reports
 * camelCase token counts, and Amp follows Claude's shape — so each field accepts
 * either spelling. Returns undefined when the event carries nothing usable.
 */
export function parseRunUsage(event: unknown): RunUsage | undefined {
  const e = asRecord(event)
  const u = asRecord(e.usage)

  const usage: RunUsage = {
    costUsd: num(e.total_cost_usd, e.totalCostUsd, e.cost_usd, e.costUsd),
    inputTokens: num(u.input_tokens, u.inputTokens),
    outputTokens: num(u.output_tokens, u.outputTokens),
    cacheReadTokens: num(u.cache_read_input_tokens, u.cacheReadTokens, u.cache_read_tokens),
    cacheWriteTokens: num(
      u.cache_creation_input_tokens,
      u.cacheWriteTokens,
      u.cacheCreationTokens,
      u.cache_write_tokens
    ),
    numTurns: num(e.num_turns, e.numTurns),
    cliDurationMs: num(e.duration_ms, e.durationMs),
    apiDurationMs: num(e.duration_api_ms, e.durationApiMs),
  }

  const entries = Object.entries(usage).filter(([, v]) => v !== undefined)
  return entries.length > 0 ? (Object.fromEntries(entries) as RunUsage) : undefined
}

export function formatDurationMs(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`
  if (minutes > 0) return `${minutes}m ${seconds}s`
  return `${seconds}s`
}

export function formatCostUsd(costUsd: number): string {
  return costUsd > 0 && costUsd < 0.01 ? '<$0.01' : `$${costUsd.toFixed(2)}`
}

export function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

/** Total tokens the CLI reported, or undefined if it reported none. */
export function totalTokens(usage: RunUsage | undefined): number | undefined {
  if (!usage) return undefined
  const parts = [usage.inputTokens, usage.outputTokens, usage.cacheReadTokens, usage.cacheWriteTokens]
  const reported = parts.filter((p): p is number => p !== undefined)
  return reported.length > 0 ? reported.reduce((a, b) => a + b, 0) : undefined
}

/**
 * One-line human summary of a run's metering, e.g.
 * `Session 2m 3s · cost $0.42 · tokens 1.2k in / 3.4k out / 50.0k cached`.
 * Fields the CLI did not report are omitted — a missing cost is never shown as $0.
 */
export function formatRunMetering(durationMs: number, usage: RunUsage | undefined): string {
  const parts = [`Session ${formatDurationMs(durationMs)}`]
  if (usage?.costUsd !== undefined) parts.push(`cost ${formatCostUsd(usage.costUsd)}`)

  const tokens: string[] = []
  if (usage?.inputTokens !== undefined) tokens.push(`${formatTokenCount(usage.inputTokens)} in`)
  if (usage?.outputTokens !== undefined) tokens.push(`${formatTokenCount(usage.outputTokens)} out`)
  if (usage?.cacheReadTokens !== undefined) tokens.push(`${formatTokenCount(usage.cacheReadTokens)} cached`)
  if (tokens.length > 0) parts.push(`tokens ${tokens.join(' / ')}`)

  if (usage?.numTurns !== undefined) parts.push(`${usage.numTurns} turns`)
  return parts.join(' · ')
}
