import React, { useState, useCallback } from 'react'
import CodeMirror from '@uiw/react-codemirror'
import { json } from '@codemirror/lang-json'
import { oneDark } from '@codemirror/theme-one-dark'
import { Plus, Pencil, Trash2, Info, Loader2, X, Check, ChevronDown, ChevronRight, RefreshCw, Share2 } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { ShareDialog } from '@renderer/components/ShareDialog'
import { useUIStore } from '@renderer/store/ui'
import {
  useGlobalMcps,
  useCreateGlobalMcp,
  useUpdateGlobalMcp,
  useDeleteGlobalMcp,
} from '@renderer/hooks/useGlobalMcps'
import { useMcpHealth } from '@renderer/hooks/useMcpHealth'
import { useMcpTools } from '@renderer/hooks/useMcpTools'
import { useAuth } from '@renderer/contexts/AuthContext'
import { cn } from '@renderer/lib/utils'
import { McpOAuthButton } from './McpOAuthButton'
import { useMcpOAuthProbe } from '@renderer/hooks/useMcpOAuth'
import { api } from '@renderer/lib/ipc'
import { isUrlMcpServer } from '@shared/mcp'
import type { GlobalMcpServer, McpServerEntry, McpOAuthConfig } from '@shared/types'

/**
 * If a URL MCP server supports OAuth and isn't already connected, start the auth
 * flow and open the authorization window. No-op for stdio servers, non-OAuth
 * servers, or servers with a still-valid token. Best-effort — the popup may be
 * blocked, in which case the Authenticate button remains as the reliable fallback.
 */
async function maybeKickOAuth(serverId: string, cfg: McpServerEntry) {
  if (!isUrlMcpServer(cfg)) return
  try {
    const probe = cfg.oauth ? { supportsOAuth: true } : await api.mcpOAuth.probe(cfg)
    if (!probe.supportsOAuth) return
    const status = await api.mcpOAuth.getStatus(serverId, true)
    const valid = status.connected && (status.expiresAt === undefined || status.expiresAt > Date.now())
    if (valid) return
    const { authUrl } = await api.mcpOAuth.startAuth(serverId, true)
    const win = window.open(authUrl, '_blank', 'noopener,noreferrer')
    if (!win) {
      // Popup blocked — the Authenticate button remains as the reliable fallback.
      console.warn('[mcp] OAuth popup was blocked by the browser; use the Authenticate button.')
    }
  } catch (err) {
    // Surface the failure (was previously silent) so auth problems are diagnosable.
    console.error('[mcp] failed to start OAuth flow:', err)
  }
}

function McpHealthDot({ serverId, serverConfig }: { serverId: string; serverConfig: McpServerEntry }) {
  const { data, isLoading, isFetching, refetch } = useMcpHealth(serverId, serverConfig)

  const pending = isLoading || isFetching
  const color = pending
    ? '#F59E0B'
    : data?.status === 'healthy'
    ? '#22C55E'
    : data?.status === 'unauthorized'
    ? '#F59E0B'
    : '#EF4444'

  const label = pending
    ? 'Checking…'
    : data?.status === 'healthy'
    ? `Connected · ${data.message}`
    : data?.status === 'unauthorized'
    ? `Authentication required · ${data.message}`
    : `Not connected · ${data?.message ?? 'Unknown error'}`

  const handleRefresh = async (e: React.MouseEvent) => {
    e.stopPropagation()
    const res = await refetch()
    // If the server needs authentication, launch the OAuth flow just like Save does.
    if (res.data?.status === 'unauthorized') {
      void maybeKickOAuth(serverId, serverConfig)
    }
  }

  return (
    <button
      onClick={handleRefresh}
      title={label}
      className="flex items-center gap-1 flex-shrink-0 group"
      aria-label={label}
    >
      <span
        className={cn('inline-block w-2 h-2 rounded-full transition-colors', pending && 'animate-pulse')}
        style={{ backgroundColor: color }}
      />
      <RefreshCw
        className="h-2.5 w-2.5 text-[var(--text-secondary)] opacity-0 group-hover:opacity-60 transition-opacity"
      />
    </button>
  )
}

const DEFAULT_SERVER_CONFIG: McpServerEntry = {
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
}

const DEFAULT_SERVER_CONFIG_JSON = JSON.stringify(DEFAULT_SERVER_CONFIG, null, 2)

interface FormState {
  name: string
  serverKey: string
  serverConfigText: string
  serverConfigError: string | null
  enabled: boolean
  // OAuth config fields (shown when server config is a URL type)
  oauthClientId: string
  oauthScopes: string        // comma-separated
  oauthAuthorizationUrl: string
  oauthTokenUrl: string
  showOAuthSection: boolean
}

function emptyForm(): FormState {
  return {
    name: '',
    serverKey: '',
    serverConfigText: DEFAULT_SERVER_CONFIG_JSON,
    serverConfigError: null,
    enabled: true,
    oauthClientId: '',
    oauthScopes: '',
    oauthAuthorizationUrl: '',
    oauthTokenUrl: '',
    showOAuthSection: false,
  }
}

function formFromServer(server: GlobalMcpServer): FormState {
  const oauth = server.serverConfig.oauth
  return {
    name: server.name,
    serverKey: server.serverKey,
    serverConfigText: JSON.stringify(server.serverConfig, null, 2),
    serverConfigError: null,
    enabled: server.enabled,
    oauthClientId: oauth?.clientId ?? '',
    oauthScopes: oauth?.scopes?.join(', ') ?? '',
    oauthAuthorizationUrl: oauth?.authorizationUrl ?? '',
    oauthTokenUrl: oauth?.tokenUrl ?? '',
    showOAuthSection: !!oauth?.clientId,
  }
}

function parseServerConfig(text: string): { value: McpServerEntry | null; error: string | null } {
  try {
    const parsed = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { value: null, error: 'Must be a JSON object' }
    }
    return { value: parsed as McpServerEntry, error: null }
  } catch (e) {
    return { value: null, error: e instanceof Error ? e.message : 'Invalid JSON' }
  }
}

function getServerType(config: McpServerEntry): string {
  return isUrlMcpServer(config) ? 'url' : 'stdio'
}

interface InlineFormProps {
  initial: FormState
  onSave: (form: FormState, parsedConfig: McpServerEntry) => void
  onCancel: () => void
  saving: boolean
  isDark: boolean
  /** Server-side save error (e.g. a duplicate MCP name) to surface in the form. */
  saveError?: string | null
}

function InlineForm({ initial, onSave, onCancel, saving, isDark, saveError }: InlineFormProps) {
  const [form, setForm] = useState<FormState>(initial)

  const handleConfigChange = useCallback((val: string) => {
    const { error } = parseServerConfig(val)
    setForm((f) => ({ ...f, serverConfigText: val, serverConfigError: error }))
  }, [])

  // Detect if the current JSON config is URL-type
  const parsedForType = parseServerConfig(form.serverConfigText)
  const isUrlType =
    parsedForType.value !== null &&
    (parsedForType.value.type === 'url' || !!parsedForType.value.url)

  const handleSubmit = () => {
    const { value, error } = parseServerConfig(form.serverConfigText)
    if (error || !value) {
      setForm((f) => ({ ...f, serverConfigError: error ?? 'Invalid JSON' }))
      return
    }
    if (!form.name.trim()) return
    if (!form.serverKey.trim()) return

    // Merge OAuth config into parsed server config if configured
    let finalConfig: McpServerEntry = value
    if (isUrlType && form.oauthClientId.trim()) {
      const oauthConfig: McpOAuthConfig = {
        clientId: form.oauthClientId.trim(),
        scopes: form.oauthScopes
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
        authorizationUrl: form.oauthAuthorizationUrl.trim(),
        tokenUrl: form.oauthTokenUrl.trim(),
      }
      finalConfig = { ...value, oauth: oauthConfig }
    } else if (!isUrlType) {
      // Remove oauth if server is no longer URL-type
      const { oauth: _removed, ...rest } = value as McpServerEntry & { oauth?: McpOAuthConfig }
      finalConfig = rest
    }

    onSave(form, finalConfig)
  }

  const isValid =
    form.name.trim().length > 0 &&
    form.serverKey.trim().length > 0 &&
    form.serverConfigError === null

  return (
    <div className="border border-[var(--border)] rounded-lg bg-[var(--bg-secondary)] p-4 space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <label className="block text-xs font-medium text-[var(--text-secondary)]">
            Display Name
          </label>
          <Input
            value={form.name}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            placeholder="File System Tools"
            autoFocus
          />
        </div>
        <div className="space-y-1">
          <label className="block text-xs font-medium text-[var(--text-secondary)]">
            Server Key
          </label>
          <Input
            value={form.serverKey}
            onChange={(e) =>
              setForm((f) => ({
                ...f,
                serverKey: e.target.value.replace(/\s+/g, '-').toLowerCase(),
              }))
            }
            placeholder="filesystem"
            className="font-mono"
          />
        </div>
      </div>

      <div className="space-y-1">
        <label className="block text-xs font-medium text-[var(--text-secondary)]">
          Server Config (JSON)
        </label>
        <div className="rounded-md border border-[var(--border)] overflow-hidden text-xs">
          <CodeMirror
            value={form.serverConfigText}
            height="160px"
            extensions={[json()]}
            theme={isDark ? oneDark : undefined}
            onChange={handleConfigChange}
            basicSetup={{
              lineNumbers: true,
              foldGutter: true,
              highlightActiveLine: true,
              autocompletion: true,
            }}
          />
        </div>
        {form.serverConfigError && (
          <p className="text-xs text-red-400">
            <span className="font-medium">JSON error:</span> {form.serverConfigError}
          </p>
        )}
      </div>

      {/* OAuth Configuration — only shown for URL-type servers */}
      {isUrlType && (
        <div className="border border-[var(--border)] rounded-md overflow-hidden">
          <button
            type="button"
            onClick={() => setForm((f) => ({ ...f, showOAuthSection: !f.showOAuthSection }))}
            className="w-full flex items-center gap-2 px-3 py-2 text-xs font-medium text-[var(--text-secondary)] hover:bg-[var(--bg-primary)] transition-colors"
          >
            {form.showOAuthSection ? (
              <ChevronDown className="h-3.5 w-3.5" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5" />
            )}
            OAuth Configuration
            <span className="ml-auto font-normal opacity-60">optional</span>
          </button>

          {form.showOAuthSection && (
            <div className="px-3 pb-3 pt-1 space-y-2.5 border-t border-[var(--border)]">
              <div className="space-y-1">
                <label className="block text-xs font-medium text-[var(--text-secondary)]">
                  Client ID
                </label>
                <Input
                  value={form.oauthClientId}
                  onChange={(e) => setForm((f) => ({ ...f, oauthClientId: e.target.value }))}
                  placeholder="your-client-id"
                  className="font-mono text-xs"
                />
              </div>
              <div className="space-y-1">
                <label className="block text-xs font-medium text-[var(--text-secondary)]">
                  Scopes{' '}
                  <span className="font-normal opacity-60">(comma-separated)</span>
                </label>
                <Input
                  value={form.oauthScopes}
                  onChange={(e) => setForm((f) => ({ ...f, oauthScopes: e.target.value }))}
                  placeholder="read write offline_access"
                  className="text-xs"
                />
              </div>
              <div className="space-y-1">
                <label className="block text-xs font-medium text-[var(--text-secondary)]">
                  Authorization URL{' '}
                  <span className="font-normal opacity-60">(override discovery)</span>
                </label>
                <Input
                  value={form.oauthAuthorizationUrl}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, oauthAuthorizationUrl: e.target.value }))
                  }
                  placeholder="https://auth.example.com/oauth/authorize"
                  className="font-mono text-xs"
                />
              </div>
              <div className="space-y-1">
                <label className="block text-xs font-medium text-[var(--text-secondary)]">
                  Token URL{' '}
                  <span className="font-normal opacity-60">(override discovery)</span>
                </label>
                <Input
                  value={form.oauthTokenUrl}
                  onChange={(e) => setForm((f) => ({ ...f, oauthTokenUrl: e.target.value }))}
                  placeholder="https://auth.example.com/oauth/token"
                  className="font-mono text-xs"
                />
              </div>
            </div>
          )}
        </div>
      )}

      <div className="flex items-center gap-2">
        <input
          type="checkbox"
          id="form-enabled"
          checked={form.enabled}
          onChange={(e) => setForm((f) => ({ ...f, enabled: e.target.checked }))}
          className="rounded border-[var(--border)] accent-[var(--accent)]"
        />
        <label htmlFor="form-enabled" className="text-xs text-[var(--text-secondary)] cursor-pointer">
          Enabled
        </label>
      </div>

      {saveError && (
        <div className="text-xs px-3 py-2 rounded-md bg-red-500/10 text-red-400 border border-red-500/20">
          {saveError}
        </div>
      )}

      <div className="flex items-center justify-end gap-2 pt-1">
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
        <Button size="sm" onClick={handleSubmit} disabled={!isValid || saving}>
          {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
          Save
        </Button>
      </div>
    </div>
  )
}

interface ServerRowProps {
  server: GlobalMcpServer
  isDark: boolean
  isOwner: boolean
  onShare: () => void
}

function McpToolCount({ serverId, serverConfig }: { serverId: string; serverConfig: McpServerEntry }) {
  const { data, isLoading } = useMcpTools(serverId, serverConfig)

  if (isLoading) return <span className="text-[10px] text-[var(--text-secondary)] opacity-50">loading tools…</span>
  if (!data || data.error) return null
  if (data.tools.length === 0) return null

  const toolNames = data.tools.map(t => t.name).join('\n')

  return (
    <span
      className="text-[10px] text-[var(--accent)] opacity-80"
      title={toolNames}
    >
      {data.tools.length} tool{data.tools.length !== 1 ? 's' : ''} available
    </span>
  )
}

function ServerRow({ server, isDark, isOwner, onShare }: ServerRowProps) {
  const [editing, setEditing] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)

  const updateMcp = useUpdateGlobalMcp()
  const deleteMcp = useDeleteGlobalMcp()
  const probe = useMcpOAuthProbe(server.serverConfig)

  const handleToggle = () => {
    updateMcp.mutate({ id: server.id, data: { enabled: !server.enabled } })
  }

  const handleSave = (form: FormState, parsedConfig: McpServerEntry) => {
    updateMcp.mutate(
      {
        id: server.id,
        data: {
          name: form.name.trim(),
          serverKey: form.serverKey.trim(),
          serverConfig: parsedConfig,
          enabled: form.enabled,
        },
      },
      {
        onSuccess: (saved) => {
          setEditing(false)
          void maybeKickOAuth(saved.id, saved.serverConfig)
        },
      }
    )
  }

  const handleDelete = () => {
    if (!confirmDelete) {
      setConfirmDelete(true)
      return
    }
    deleteMcp.mutate(server.id)
  }

  const serverType = getServerType(server.serverConfig)

  if (editing) {
    return (
      <InlineForm
        initial={formFromServer(server)}
        onSave={handleSave}
        onCancel={() => setEditing(false)}
        saving={updateMcp.isPending}
        isDark={isDark}
        saveError={updateMcp.error instanceof Error ? updateMcp.error.message : null}
      />
    )
  }

  return (
    <div
      className={cn(
        'flex items-center gap-3 px-3 py-2.5 rounded-lg border transition-colors',
        server.enabled
          ? 'border-[var(--border)] bg-[var(--bg-secondary)]'
          : 'border-[var(--border)] bg-[var(--bg-primary)] opacity-60'
      )}
    >
      {/* Toggle */}
      <button
        onClick={handleToggle}
        disabled={updateMcp.isPending}
        title={server.enabled ? 'Disable' : 'Enable'}
        className={cn(
          'w-4 h-4 rounded-full border-2 flex-shrink-0 transition-colors',
          server.enabled
            ? 'bg-[var(--accent)] border-[var(--accent)]'
            : 'bg-transparent border-[var(--text-secondary)]'
        )}
        aria-label={server.enabled ? 'Disable server' : 'Enable server'}
      />

      {/* Info */}
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-[var(--text-primary)] truncate">
          {server.name}
          {!server.enabled && (
            <span className="ml-2 text-xs text-[var(--text-secondary)] font-normal">(disabled)</span>
          )}
        </p>
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-[var(--text-secondary)] font-mono truncate">
            {server.serverKey} · {serverType}
          </span>
          {server.enabled && (
            <>
              <span className="text-[var(--text-secondary)] opacity-30">·</span>
              <McpToolCount serverId={server.id} serverConfig={server.serverConfig} />
            </>
          )}
        </div>
      </div>

      {/* Health indicator */}
      {server.enabled && (
        <McpHealthDot serverId={server.id} serverConfig={server.serverConfig} />
      )}

      {/* OAuth button for URL-type servers — shown when oauth block present or probe detects OAuth support */}
      {serverType === 'url' && server.serverConfig.url && (server.serverConfig.oauth || probe.data?.supportsOAuth) && (
        <McpOAuthButton
          serverId={server.id}
          isGlobal={true}
          serverUrl={server.serverConfig.url}
          serverName={server.name}
        />
      )}

      {/* Actions */}
      <div className="flex items-center gap-1 flex-shrink-0">
        {isOwner && (
          <button
            onClick={onShare}
            className="p-1.5 rounded-md text-[var(--text-secondary)] hover:bg-[var(--bg-primary)] hover:text-[var(--text-primary)] transition-colors"
            title="Share"
          >
            <Share2 className="h-3.5 w-3.5" />
          </button>
        )}
        <button
          onClick={() => { setEditing(true); setConfirmDelete(false) }}
          className="p-1.5 rounded-md text-[var(--text-secondary)] hover:bg-[var(--bg-primary)] hover:text-[var(--text-primary)] transition-colors"
          title="Edit"
        >
          <Pencil className="h-3.5 w-3.5" />
        </button>
        {confirmDelete ? (
          <>
            <span className="text-xs text-red-400 ml-1">Delete?</span>
            <button
              onClick={handleDelete}
              disabled={deleteMcp.isPending}
              className="p-1.5 rounded-md text-red-400 hover:bg-red-400/10 transition-colors"
              title="Confirm delete"
            >
              {deleteMcp.isPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Check className="h-3.5 w-3.5" />
              )}
            </button>
            <button
              onClick={() => setConfirmDelete(false)}
              className="p-1.5 rounded-md text-[var(--text-secondary)] hover:bg-[var(--bg-primary)] transition-colors"
              title="Cancel"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </>
        ) : (
          <button
            onClick={handleDelete}
            className="p-1.5 rounded-md text-[var(--text-secondary)] hover:bg-red-400/10 hover:text-red-400 transition-colors"
            title="Delete"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    </div>
  )
}

export function GlobalMcpManager() {
  const { theme } = useUIStore()
  const isDark =
    theme === 'dark' ||
    (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)

  const { data: servers = [], isLoading } = useGlobalMcps()
  const { user } = useAuth()
  const createMcp = useCreateGlobalMcp()

  const [showAddForm, setShowAddForm] = useState(false)
  const [shareServerId, setShareServerId] = useState<string | null>(null)

  const handleCreate = (form: FormState, parsedConfig: McpServerEntry) => {
    createMcp.mutate(
      {
        name: form.name.trim(),
        serverKey: form.serverKey.trim(),
        serverConfig: parsedConfig,
        enabled: form.enabled,
      },
      {
        onSuccess: (saved) => {
          setShowAddForm(false)
          void maybeKickOAuth(saved.id, saved.serverConfig)
        },
      }
    )
  }

  const myServers = servers.filter((s) => s.ownerId === user?.id)
  const sharedServers = servers.filter((s) => s.ownerId !== user?.id)

  return (
    <div className="flex flex-col h-full" style={{ background: 'var(--bg-primary)' }}>
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--border)] flex-shrink-0">
        <div>
          <h1 className="text-sm font-semibold text-[var(--text-primary)]">Global MCP Servers</h1>
          <p className="text-xs text-[var(--text-secondary)] mt-0.5">Shared across all agents</p>
        </div>
        <Button
          size="sm"
          onClick={() => setShowAddForm(true)}
          disabled={showAddForm}
          className="gap-1.5"
        >
          <Plus className="h-3.5 w-3.5" />
          Add
        </Button>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
        {/* Info banner */}
        <div className="flex items-start gap-2.5 px-3 py-2.5 rounded-lg bg-[var(--accent)]/10 border border-[var(--accent)]/20 text-xs text-[var(--text-secondary)]">
          <Info className="h-3.5 w-3.5 text-[var(--accent)] flex-shrink-0 mt-0.5" />
          <span>
            Global MCPs are merged with agent-specific MCPs on every run. Agent MCPs take priority
            if keys conflict.
          </span>
        </div>

        {/* Add form */}
        {showAddForm && (
          <InlineForm
            initial={emptyForm()}
            onSave={handleCreate}
            onCancel={() => setShowAddForm(false)}
            saving={createMcp.isPending}
            isDark={isDark}
            saveError={createMcp.error instanceof Error ? createMcp.error.message : null}
          />
        )}

        {/* Server list */}
        {isLoading ? (
          <div className="flex items-center justify-center py-10 text-sm text-[var(--text-secondary)]">
            <Loader2 className="h-4 w-4 animate-spin mr-2" />
            Loading…
          </div>
        ) : servers.length === 0 && !showAddForm ? (
          <div className="flex flex-col items-center justify-center py-12 gap-2 text-center">
            <p className="text-sm text-[var(--text-secondary)]">No global MCP servers configured.</p>
            <p className="text-xs text-[var(--text-secondary)] max-w-xs">
              Add shared MCP servers here and they&apos;ll be automatically available to every agent.
            </p>
            <Button size="sm" variant="outline" className="mt-2 gap-1.5" onClick={() => setShowAddForm(true)}>
              <Plus className="h-3.5 w-3.5" />
              Add your first global MCP
            </Button>
          </div>
        ) : (
          <div className="space-y-2">
            {myServers.length > 0 && (
              <>
                <div className="text-[10px] font-medium uppercase tracking-wider text-[var(--text-secondary)] px-3 py-1.5">
                  My Servers <span className="ml-1 opacity-60">{myServers.length}</span>
                </div>
                {myServers.map((server) => (
                  <ServerRow key={server.id} server={server} isDark={isDark} isOwner onShare={() => setShareServerId(server.id)} />
                ))}
              </>
            )}
            {sharedServers.length > 0 && (
              <>
                <div className="text-[10px] font-medium uppercase tracking-wider text-[var(--text-secondary)] px-3 py-1.5">
                  Shared with Me <span className="ml-1 opacity-60">{sharedServers.length}</span>
                </div>
                {sharedServers.map((server) => (
                  <ServerRow key={server.id} server={server} isDark={isDark} isOwner={false} onShare={() => {}} />
                ))}
              </>
            )}
          </div>
        )}
      </div>

      {shareServerId && (
        <ShareDialog
          entityType="globalMcpServer"
          entityId={shareServerId}
          isOpen={!!shareServerId}
          onClose={() => setShareServerId(null)}
        />
      )}
    </div>
  )
}
