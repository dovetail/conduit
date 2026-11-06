import React, { useState, useEffect } from 'react'
import { Info, Check, Loader2, KeyRound, HardDrive, Trash2, Timer } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { useAgentCredentialStatus, useSetAgentCredential } from '@renderer/hooks/useAgentCredentials'
import { useRunnerTimeouts, useSetRunnerTimeout } from '@renderer/hooks/useRunnerTimeouts'
import { useDataDirSweep } from '@renderer/hooks/useDataDirSweep'
import { useStorageUsage } from '@renderer/hooks/useStorageUsage'
import { formatBytes } from '@renderer/lib/utils'
import { McpAccessCard } from './McpAccessCard'
import type { RunnerType, SweepResult } from '@shared/types'

interface RunnerMeta {
  runner: RunnerType
  label: string
  envVar: string
  hint: string
}

const RUNNERS: RunnerMeta[] = [
  { runner: 'claude', label: 'Claude Code', envVar: 'ANTHROPIC_API_KEY', hint: 'Anthropic API key used to authenticate the Claude Code CLI.' },
  { runner: 'amp', label: 'Amp', envVar: 'AMP_API_KEY', hint: 'Sourcegraph Amp API key used to authenticate the Amp CLI.' },
  { runner: 'cursor', label: 'Cursor', envVar: 'CURSOR_API_KEY', hint: 'Cursor API key used to authenticate the cursor-agent CLI.' },
]

/**
 * One card per agent harness, holding both its credential (API key) and its
 * background-task timeout — the two per-harness settings live together instead of
 * in separate screen sections.
 */
function RunnerSettingsCard({
  meta,
  configured,
  seconds,
}: {
  meta: RunnerMeta
  configured: boolean
  seconds: number
}) {
  // Credential (API key) state.
  const [keyValue, setKeyValue] = useState('')
  const setCredential = useSetAgentCredential()
  const credBusy = setCredential.isPending

  const handleSaveKey = async () => {
    if (!keyValue.trim()) return
    try {
      await setCredential.mutateAsync({ runner: meta.runner, value: keyValue })
      setKeyValue('')
    } catch (err) {
      console.error('Failed to save credential:', err)
    }
  }

  const handleClearKey = async () => {
    try {
      await setCredential.mutateAsync({ runner: meta.runner, value: '' })
      setKeyValue('')
    } catch (err) {
      console.error('Failed to clear credential:', err)
    }
  }

  // Background-task timeout state.
  const [timeoutValue, setTimeoutValue] = useState(String(seconds))
  const saveTimeout = useSetRunnerTimeout()
  const timeoutBusy = saveTimeout.isPending
  const timeoutSupported = meta.runner === 'claude'

  // Keep the field in sync when the stored value changes (initial load / refetch).
  useEffect(() => {
    setTimeoutValue(String(seconds))
  }, [seconds])

  const timeoutDirty = String(seconds) !== timeoutValue.trim()

  const handleSaveTimeout = async () => {
    const n = Math.max(0, Math.floor(Number(timeoutValue) || 0))
    try {
      await saveTimeout.mutateAsync({ runner: meta.runner, seconds: n })
      setTimeoutValue(String(n))
    } catch (err) {
      console.error('Failed to save timeout:', err)
    }
  }

  return (
    <div className="rounded-lg border border-[var(--border)] px-4 py-3.5 space-y-3.5" style={{ background: 'var(--bg-secondary)' }}>
      {/* Header: harness name + env var + credential status */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <KeyRound className="h-4 w-4 flex-shrink-0 text-[var(--text-secondary)]" />
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-[var(--text-primary)]">{meta.label}</span>
              <code className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--bg-primary)] text-[var(--text-secondary)]">
                {meta.envVar}
              </code>
            </div>
            <p className="text-xs text-[var(--text-secondary)] mt-0.5">{meta.hint}</p>
          </div>
        </div>
        {configured ? (
          <span className="flex items-center gap-1 text-xs font-medium text-green-500 flex-shrink-0">
            <Check className="h-3.5 w-3.5" />
            Configured
          </span>
        ) : (
          <span className="text-xs text-[var(--text-secondary)] flex-shrink-0">Not set</span>
        )}
      </div>

      {/* API key input */}
      <div className="flex items-center gap-2">
        <Input
          type="password"
          value={keyValue}
          onChange={(e) => setKeyValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleSaveKey()
          }}
          placeholder={configured ? 'Enter a new key to replace the stored one…' : 'Paste API key…'}
          autoComplete="off"
          className="flex-1"
        />
        <Button size="sm" onClick={handleSaveKey} disabled={!keyValue.trim() || credBusy} className="gap-1.5">
          {credBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
          Save
        </Button>
        {configured && (
          <Button size="sm" variant="ghost" onClick={handleClearKey} disabled={credBusy}>
            Clear
          </Button>
        )}
      </div>

      {/* Background-task timeout — same harness, so it lives in the same card */}
      <div className="flex items-center justify-between gap-3 pt-3 border-t border-[var(--border)]">
        <div className="flex items-center gap-2.5 min-w-0">
          <Timer className="h-4 w-4 flex-shrink-0 text-[var(--text-secondary)]" />
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-[var(--text-primary)]">Background-task timeout</span>
              {!timeoutSupported && (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--bg-primary)] text-[var(--text-secondary)]">
                  no effect yet
                </span>
              )}
            </div>
            <p className="text-xs text-[var(--text-secondary)] mt-0.5">
              {timeoutSupported
                ? 'Injected as CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS. 0 = wait indefinitely.'
                : 'No known wait-ceiling env var for this CLI yet — stored, but not applied.'}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <Input
            type="number"
            min={0}
            value={timeoutValue}
            onChange={(e) => setTimeoutValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleSaveTimeout()
            }}
            className="w-24"
          />
          <span className="text-xs text-[var(--text-secondary)]">sec</span>
          <Button size="sm" onClick={handleSaveTimeout} disabled={timeoutBusy || !timeoutDirty} className="gap-1.5">
            {timeoutBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            Save
          </Button>
        </div>
      </div>
    </div>
  )
}

function sweepSummary(r: SweepResult): string {
  const parts: string[] = []
  if (r.worktreesRemoved) parts.push(`${r.worktreesRemoved} worktree${r.worktreesRemoved === 1 ? '' : 's'}`)
  if (r.workspacesRemoved) parts.push(`${r.workspacesRemoved} workspace${r.workspacesRemoved === 1 ? '' : 's'}`)
  if (r.mcpConfigsRemoved) parts.push(`${r.mcpConfigsRemoved} MCP config${r.mcpConfigsRemoved === 1 ? '' : 's'}`)
  if (r.logsRemoved) parts.push(`${r.logsRemoved} old log${r.logsRemoved === 1 ? '' : 's'}`)
  if (r.bareClonesRemoved) parts.push(`${r.bareClonesRemoved} orphaned clone${r.bareClonesRemoved === 1 ? '' : 's'}`)
  if (r.cloningTmpRemoved) parts.push(`${r.cloningTmpRemoved} clone temp${r.cloningTmpRemoved === 1 ? '' : 's'}`)
  const removed = parts.length ? `Removed ${parts.join(', ')}.` : ''
  const compacted = r.reposCompacted ? `Compacted ${r.reposCompacted} clone${r.reposCompacted === 1 ? '' : 's'}.` : ''
  return [removed, compacted].filter(Boolean).join(' ') || 'Nothing to clean up — already tidy.'
}

function StorageUsageSummary() {
  const usage = useStorageUsage()

  if (usage.isLoading) {
    return (
      <div className="flex items-center gap-1.5 text-sm text-[var(--text-secondary)] mt-1">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Calculating storage usage…
      </div>
    )
  }

  if (usage.isError || !usage.data) {
    return (
      <div className="text-xs text-[var(--text-secondary)] mt-1">
        Couldn't measure storage usage.
      </div>
    )
  }

  const { totalBytes, reclaimableBytes } = usage.data
  return (
    <div className="mt-1">
      <div className="flex items-center gap-1.5">
        <span className="text-sm font-semibold text-[var(--text-primary)]">
          {formatBytes(totalBytes)}
        </span>
        <span className="text-sm text-[var(--text-secondary)]">in use</span>
        {usage.isFetching && <Loader2 className="h-3 w-3 animate-spin text-[var(--text-secondary)]" />}
      </div>
      {reclaimableBytes > 0 && (
        <div className="text-xs text-[var(--text-secondary)] mt-0.5">
          {formatBytes(reclaimableBytes)} reclaimable from finished runs
        </div>
      )}
    </div>
  )
}

function StorageMaintenanceCard() {
  const sweep = useDataDirSweep()

  return (
    <div className="rounded-lg border border-[var(--border)] px-4 py-3.5" style={{ background: 'var(--bg-secondary)' }}>
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-start gap-2.5 min-w-0">
          <HardDrive className="h-4 w-4 flex-shrink-0 text-[var(--text-secondary)] mt-0.5" />
          <div className="min-w-0">
            <div className="text-sm font-medium text-[var(--text-primary)]">Data directory</div>
            <StorageUsageSummary />
            <p className="text-xs text-[var(--text-secondary)] mt-2">
              Reclaim disk from finished runs — orphaned git worktrees, temp workspaces, and per-run
              MCP configs. This happens automatically after each run and on a timer; run it now to
              clean up immediately. Runs currently executing are never touched.
            </p>
          </div>
        </div>
        <Button
          size="sm"
          onClick={() => sweep.mutate()}
          disabled={sweep.isPending}
          className="gap-1.5 flex-shrink-0"
        >
          {sweep.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
          Clean up now
        </Button>
      </div>
      {sweep.data && !sweep.isPending && (
        <p className="text-xs text-green-500 mt-3">{sweepSummary(sweep.data)}</p>
      )}
      {sweep.isError && (
        <p className="text-xs text-red-400 mt-3">
          Cleanup failed: {sweep.error instanceof Error ? sweep.error.message : String(sweep.error)}
        </p>
      )}
    </div>
  )
}

export function SettingsManager() {
  const { data: status } = useAgentCredentialStatus()
  const { data: timeouts } = useRunnerTimeouts()

  return (
    <div className="flex flex-col h-full" style={{ background: 'var(--bg-primary)' }}>
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--border)] flex-shrink-0">
        <div>
          <h1 className="text-sm font-semibold text-[var(--text-primary)]">Settings</h1>
          <p className="text-xs text-[var(--text-secondary)] mt-0.5">
            Agent authentication, MCP access, and storage maintenance
          </p>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto px-5 py-4">
        <div className="max-w-2xl space-y-3">
          <div className="flex items-start gap-2.5 px-3 py-2.5 rounded-lg bg-[var(--accent)]/10 border border-[var(--accent)]/20 text-xs text-[var(--text-secondary)]">
            <Info className="h-3.5 w-3.5 text-[var(--accent)] flex-shrink-0 mt-0.5" />
            <span>
              Keys and the background-task timeout are stored per agent harness and scoped to your
              account — every agent you own uses them. Keys are encrypted at rest and injected as the
              runner's environment variable. An explicit env var or timeout set on an individual agent
              overrides what you store here.
            </span>
          </div>

          <h2 className="text-xs font-medium text-[var(--text-secondary)] pt-1">Agent harnesses</h2>
          {RUNNERS.map((meta) => (
            <RunnerSettingsCard
              key={meta.runner}
              meta={meta}
              configured={!!status?.[meta.runner]}
              seconds={timeouts?.[meta.runner] ?? 0}
            />
          ))}

          <h2 className="text-xs font-medium text-[var(--text-secondary)] pt-3">MCP access</h2>
          <McpAccessCard />

          <h2 className="text-xs font-medium text-[var(--text-secondary)] pt-3">Storage maintenance</h2>
          <StorageMaintenanceCard />
        </div>
      </div>
    </div>
  )
}
