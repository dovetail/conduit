import React, { useState, useCallback } from 'react'
import CodeMirror from '@uiw/react-codemirror'
import { json } from '@codemirror/lang-json'
import { oneDark } from '@codemirror/theme-one-dark'
import { Info } from 'lucide-react'
import { useUIStore } from '@renderer/store/ui'
import { useGlobalMcps } from '@renderer/hooks/useGlobalMcps'
import { McpOAuthButton } from '@renderer/components/settings/McpOAuthButton'
import { useMcpOAuthProbe } from '@renderer/hooks/useMcpOAuth'
import type { McpServersConfig, McpServerEntry } from '@shared/types'

const DEFAULT_MCP_CONFIG: McpServersConfig = { mcpServers: {} }

function AgentMcpOAuthRow({ agentId, serverKey, entry }: { agentId: string; serverKey: string; entry: McpServerEntry }) {
  const probe = useMcpOAuthProbe(entry)
  const show = !!entry.oauth || !!probe.data?.supportsOAuth
  return (
    <div className="flex items-center justify-between gap-3 px-2.5 py-1.5 rounded bg-[var(--bg-primary)] border border-[var(--border)]">
      <div className="min-w-0">
        <p className="text-xs font-medium text-[var(--text-primary)] truncate">{serverKey}</p>
        <p className="text-xs text-[var(--text-secondary)] font-mono truncate opacity-70">{entry.url}</p>
      </div>
      {show ? (
        <McpOAuthButton serverId={`${agentId}:${serverKey}`} isGlobal={false} serverUrl={entry.url!} serverName={serverKey} />
      ) : (
        <span className="text-xs text-[var(--text-secondary)] opacity-60">No authentication required</span>
      )}
    </div>
  )
}

interface McpEditorProps {
  value: McpServersConfig
  onChange: (value: McpServersConfig) => void
  /** Optional agent ID — when provided, shows OAuth buttons for URL-type servers */
  agentId?: string
}

export function McpEditor({ value, onChange, agentId }: McpEditorProps) {
  const { theme, setShowGlobalMcpManager } = useUIStore()
  const isDark = theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)

  const { data: globalMcps = [] } = useGlobalMcps()
  const enabledGlobalCount = globalMcps.filter((m) => m.enabled).length

  const serialize = (v: McpServersConfig) => JSON.stringify(v, null, 2)

  const [text, setText] = useState(() => serialize(value ?? DEFAULT_MCP_CONFIG))
  const [error, setError] = useState<string | null>(null)

  const handleChange = useCallback(
    (val: string) => {
      setText(val)
      try {
        const parsed = JSON.parse(val) as McpServersConfig
        if (typeof parsed !== 'object' || parsed === null || !('mcpServers' in parsed)) {
          setError('Must be an object with a "mcpServers" key')
          return
        }
        setError(null)
        onChange(parsed)
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Invalid JSON')
      }
    },
    [onChange]
  )

  // Collect all URL-type servers for the authentication panel (probe will determine per-row whether OAuth is needed)
  const urlServers = Object.entries(value?.mcpServers ?? {}).filter(
    ([, entry]) => (entry.type === 'url' || !!entry.url) && !!entry.url
  )

  return (
    <div className="space-y-2">
      {/* Global MCP info banner */}
      <div className="flex items-center gap-2 px-2.5 py-2 rounded-md bg-[var(--bg-secondary)] border border-[var(--border)] text-xs text-[var(--text-secondary)]">
        <Info className="h-3.5 w-3.5 text-[var(--accent)] flex-shrink-0" />
        <span>
          Agent-specific MCPs below. Global MCPs (
          <span className="text-[var(--text-primary)] font-medium">{enabledGlobalCount}</span>
          {' '}configured) are also active.
        </span>
        <button
          onClick={() => setShowGlobalMcpManager(true)}
          className="ml-auto flex-shrink-0 text-[var(--accent)] hover:underline font-medium whitespace-nowrap"
        >
          Manage global MCPs →
        </button>
      </div>

      <div className="space-y-1">
        <div className="rounded-md border border-[var(--border)] overflow-hidden text-xs">
          <CodeMirror
            value={text}
            height="200px"
            extensions={[json()]}
            theme={isDark ? oneDark : undefined}
            onChange={handleChange}
            basicSetup={{
              lineNumbers: true,
              foldGutter: true,
              highlightActiveLine: true,
              autocompletion: true,
            }}
          />
        </div>
        {error && (
          <p className="text-xs text-red-400 flex items-center gap-1">
            <span className="font-medium">JSON error:</span> {error}
          </p>
        )}
      </div>

      {/* OAuth authentication panel for URL-type servers */}
      {agentId && urlServers.length > 0 && (
        <div className="rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] p-2.5 space-y-2">
          <p className="text-xs font-medium text-[var(--text-secondary)]">
            URL-based MCP servers — authentication required:
          </p>
          {urlServers.map(([serverKey, entry]) => (
            <AgentMcpOAuthRow key={serverKey} agentId={agentId} serverKey={serverKey} entry={entry} />
          ))}
        </div>
      )}
    </div>
  )
}
