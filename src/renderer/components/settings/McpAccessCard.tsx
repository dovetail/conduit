import React, { useState } from 'react'
import { Plug, Loader2, Copy, Check, Trash2 } from 'lucide-react'
import { formatDistanceToNow } from 'date-fns'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { useCreateMcpToken, useMcpTokens, useRevokeMcpToken } from '@renderer/hooks/useMcpTokens'
import { CONDUIT_MCP_HTTP_PATH, type CreatedMcpAccessToken, type McpAccessTokenScope } from '@shared/types'

const EXPIRY_OPTIONS = [
  { days: 30, label: '30 days' },
  { days: 90, label: '90 days' },
  { days: 365, label: '1 year' },
  { days: 0, label: 'Never' },
]

function mcpUrl(): string {
  return `${window.location.origin}${CONDUIT_MCP_HTTP_PATH}`
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <Button
      size="sm"
      variant="ghost"
      className="gap-1.5 flex-shrink-0"
      onClick={async () => {
        await navigator.clipboard.writeText(text)
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      }}
    >
      {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      {copied ? 'Copied' : 'Copy'}
    </Button>
  )
}

function CodeLine({ text }: { text: string }) {
  return (
    <div className="flex items-center gap-2">
      <code className="flex-1 min-w-0 overflow-x-auto whitespace-nowrap text-[11px] px-2 py-1.5 rounded bg-[var(--bg-primary)] text-[var(--text-primary)]">
        {text}
      </code>
      <CopyButton text={text} />
    </div>
  )
}

function NewTokenNotice({ created }: { created: CreatedMcpAccessToken }) {
  const url = mcpUrl()
  const claudeCmd = `claude mcp add --transport http conduit ${url} --header "Authorization: Bearer ${created.plaintext}"`
  const jsonConfig = JSON.stringify(
    { mcpServers: { conduit: { url, headers: { Authorization: `Bearer ${created.plaintext}` } } } },
    null,
    2
  )
  return (
    <div className="rounded-md border border-green-500/30 bg-green-500/5 px-3 py-2.5 space-y-2">
      <p className="text-xs font-medium text-green-500">
        Token "{created.token.name}" created. Copy it now — it won't be shown again.
      </p>
      <CodeLine text={created.plaintext} />
      <p className="text-xs text-[var(--text-secondary)] pt-1">Claude Code:</p>
      <CodeLine text={claudeCmd} />
      <p className="text-xs text-[var(--text-secondary)] pt-1">
        Cursor (<code>.cursor/mcp.json</code>) and other clients that support remote MCP servers:
      </p>
      <div className="flex items-start gap-2">
        <pre className="flex-1 min-w-0 overflow-x-auto text-[11px] px-2 py-1.5 rounded bg-[var(--bg-primary)] text-[var(--text-primary)]">
          {jsonConfig}
        </pre>
        <CopyButton text={jsonConfig} />
      </div>
    </div>
  )
}

export function McpAccessCard() {
  const { data: tokens = [], isLoading } = useMcpTokens()
  const createToken = useCreateMcpToken()
  const revokeToken = useRevokeMcpToken()
  const [name, setName] = useState('')
  const [scope, setScope] = useState<McpAccessTokenScope>('read')
  const [expiresInDays, setExpiresInDays] = useState(90)
  const [created, setCreated] = useState<CreatedMcpAccessToken | null>(null)

  const handleCreate = async () => {
    if (!name.trim()) return
    try {
      setCreated(await createToken.mutateAsync({ name: name.trim(), scope, expiresInDays }))
      setName('')
    } catch (err) {
      console.error('Failed to create MCP token:', err)
    }
  }

  return (
    <div className="rounded-lg border border-[var(--border)] px-4 py-3.5 space-y-3.5" style={{ background: 'var(--bg-secondary)' }}>
      <div className="flex items-start gap-2.5">
        <Plug className="h-4 w-4 flex-shrink-0 text-[var(--text-secondary)] mt-0.5" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-[var(--text-primary)]">MCP server</div>
          <p className="text-xs text-[var(--text-secondary)] mt-0.5">
            Connect an AI client (Claude Code, Cursor, …) to Conduit to configure agents, investigate
            runs, and refine prompts without the UI. It acts as you and sees what you see. Read tokens
            can only inspect; write tokens can also change, delete, and start things.
          </p>
          <div className="mt-2">
            <CodeLine text={mcpUrl()} />
          </div>
        </div>
      </div>

      <div className="flex items-center gap-2 pt-3 border-t border-[var(--border)]">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleCreate()
          }}
          placeholder="Token name (e.g. Claude Code on laptop)"
          autoComplete="off"
          className="flex-1"
        />
        <select
          value={scope}
          onChange={(e) => setScope(e.target.value as McpAccessTokenScope)}
          className="h-8 rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-2 text-xs text-[var(--text-primary)]"
          aria-label="Token scope"
        >
          <option value="read">Read</option>
          <option value="write">Read &amp; write</option>
        </select>
        <select
          value={expiresInDays}
          onChange={(e) => setExpiresInDays(Number(e.target.value))}
          className="h-8 rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-2 text-xs text-[var(--text-primary)]"
          aria-label="Token expiry"
        >
          {EXPIRY_OPTIONS.map((o) => (
            <option key={o.days} value={o.days}>
              {o.label}
            </option>
          ))}
        </select>
        <Button size="sm" onClick={handleCreate} disabled={!name.trim() || createToken.isPending} className="gap-1.5">
          {createToken.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
          Create token
        </Button>
      </div>
      {createToken.isError && (
        <p className="text-xs text-red-400">
          {createToken.error instanceof Error ? createToken.error.message : String(createToken.error)}
        </p>
      )}

      {created && <NewTokenNotice created={created} />}

      {isLoading ? (
        <div className="flex items-center gap-1.5 text-xs text-[var(--text-secondary)]">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Loading tokens…
        </div>
      ) : tokens.length === 0 ? (
        <p className="text-xs text-[var(--text-secondary)]">No tokens yet.</p>
      ) : (
        <ul className="divide-y divide-[var(--border)]">
          {tokens.map((t) => (
            <li key={t.id} className="flex items-center justify-between gap-3 py-2">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm text-[var(--text-primary)] truncate">{t.name}</span>
                  <code className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--bg-primary)] text-[var(--text-secondary)]">
                    {t.tokenPrefix}…
                  </code>
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--bg-primary)] text-[var(--text-secondary)]">
                    {t.scope === 'write' ? 'read & write' : 'read'}
                  </span>
                </div>
                <p className="text-xs text-[var(--text-secondary)] mt-0.5">
                  Created {formatDistanceToNow(t.createdAt, { addSuffix: true })}
                  {' · '}
                  {t.lastUsedAt ? `last used ${formatDistanceToNow(t.lastUsedAt, { addSuffix: true })}` : 'never used'}
                  {' · '}
                  {t.expiresAt
                    ? t.expiresAt < Date.now()
                      ? 'expired'
                      : `expires ${formatDistanceToNow(t.expiresAt, { addSuffix: true })}`
                    : 'never expires'}
                </p>
              </div>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => revokeToken.mutate(t.id)}
                disabled={revokeToken.isPending}
                className="gap-1.5 flex-shrink-0"
              >
                <Trash2 className="h-3.5 w-3.5" />
                Revoke
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
