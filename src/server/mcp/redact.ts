import type {
  AgentConfig,
  GlobalMcpServer,
  McpServerEntry,
  McpServersConfig,
  PublishTarget,
  Trigger,
} from '../../shared/types'
import { ClientError } from '../errors'

/**
 * Placeholder that replaces secret values in everything the MCP server returns.
 * Writes that send it back unchanged keep the stored value, so an LLM can
 * round-trip a config it read without ever seeing (or clobbering) the secrets.
 */
export const REDACTED = '[redacted]'

const SECRET_KEY_RE = /token|secret|pass(word)?|api[_-]?key|webhookurl|credential|auth/i

function redactValues(rec: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!rec) return rec
  return Object.fromEntries(Object.keys(rec).map((k) => [k, rec[k] ? REDACTED : '']))
}

/** Query-string values can carry API keys (`?api_key=…`); keep the names only. */
export function redactUrl(url: string | undefined): string | undefined {
  if (!url) return url
  try {
    const parsed = new URL(url)
    if (parsed.username || parsed.password) {
      parsed.username = parsed.username ? REDACTED : ''
      parsed.password = ''
    }
    for (const key of [...parsed.searchParams.keys()]) parsed.searchParams.set(key, REDACTED)
    return decodeURIComponent(parsed.toString())
  } catch {
    return url
  }
}

export function redactMcpEntry(entry: McpServerEntry): McpServerEntry {
  const out: McpServerEntry = { ...entry }
  if (entry.url) out.url = redactUrl(entry.url)
  if (entry.headers) out.headers = redactValues(entry.headers)
  if (entry.env) out.env = redactValues(entry.env)
  return out
}

export function redactMcpServers(config: McpServersConfig | undefined): McpServersConfig {
  const servers = config?.mcpServers ?? {}
  return {
    mcpServers: Object.fromEntries(
      Object.entries(servers).map(([key, entry]) => [key, redactMcpEntry(entry)])
    ),
  }
}

export function redactAgent(agent: AgentConfig): AgentConfig {
  return {
    ...agent,
    envVars: redactValues(agent.envVars) ?? {},
    mcpConfig: redactMcpServers(agent.mcpConfig),
  }
}

export function redactGlobalMcp(server: GlobalMcpServer): GlobalMcpServer {
  return { ...server, serverConfig: redactMcpEntry(server.serverConfig) }
}

export function redactPublishTarget(target: PublishTarget): PublishTarget {
  const config = { ...(target.config as unknown as Record<string, unknown>) }
  for (const [key, value] of Object.entries(config)) {
    if (key === 'headers' && value && typeof value === 'object') {
      config[key] = redactValues(value as Record<string, string>)
    } else if (SECRET_KEY_RE.test(key) && typeof value === 'string' && value) {
      config[key] = REDACTED
    }
  }
  return { ...target, config: config as unknown as PublishTarget['config'] }
}

export function redactTrigger(trigger: Trigger): Trigger {
  const config = { ...(trigger.config as unknown as Record<string, unknown>) }
  if (typeof config.secret === 'string' && config.secret) config.secret = REDACTED
  return { ...trigger, config: config as unknown as Trigger['config'] }
}

/**
 * Resolve a key/value patch against the stored values. A `null` value deletes
 * the key; the redaction placeholder keeps the stored value (and is rejected
 * for keys that have no stored value, since it would persist literally).
 */
export function applyRecordPatch(
  existing: Record<string, string>,
  patch: Record<string, string | null>,
  label: string
): Record<string, string> {
  const out = { ...existing }
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete out[key]
    } else if (value === REDACTED) {
      if (!(key in existing)) {
        throw new ClientError(`${label} "${key}" has no stored value to keep; provide the real value.`)
      }
    } else {
      out[key] = value
    }
  }
  return out
}

/**
 * Merge an incoming MCP server entry with the stored one: header/env values
 * sent back as the placeholder keep their stored values, and a redacted URL
 * keeps the stored URL.
 */
export function mergeMcpEntry(incoming: McpServerEntry, existing: McpServerEntry | undefined): McpServerEntry {
  const merged: McpServerEntry = { ...incoming }
  if (incoming.url && incoming.url.includes(REDACTED)) {
    if (!existing?.url || redactUrl(existing.url) !== incoming.url) {
      throw new ClientError('The server URL contains a redacted value; provide the full URL.')
    }
    merged.url = existing.url
  }
  for (const field of ['headers', 'env'] as const) {
    const values = incoming[field]
    if (!values) continue
    const stored = existing?.[field] ?? {}
    const resolved: Record<string, string> = {}
    for (const [key, value] of Object.entries(values)) {
      if (value === REDACTED) {
        if (!(key in stored)) {
          throw new ClientError(`MCP ${field} "${key}" has no stored value to keep; provide the real value.`)
        }
        resolved[key] = stored[key]!
      } else {
        resolved[key] = value
      }
    }
    merged[field] = resolved
  }
  return merged
}
