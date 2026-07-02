import React, { useState } from 'react'
import { Info, Check, Loader2, KeyRound } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { useAgentCredentialStatus, useSetAgentCredential } from '@renderer/hooks/useAgentCredentials'
import type { RunnerType } from '@shared/types'

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

function CredentialRow({ meta, configured }: { meta: RunnerMeta; configured: boolean }) {
  const [value, setValue] = useState('')
  const setCredential = useSetAgentCredential()
  const busy = setCredential.isPending

  const handleSave = async () => {
    if (!value.trim()) return
    try {
      await setCredential.mutateAsync({ runner: meta.runner, value })
      setValue('')
    } catch (err) {
      console.error('Failed to save credential:', err)
    }
  }

  const handleClear = async () => {
    try {
      await setCredential.mutateAsync({ runner: meta.runner, value: '' })
      setValue('')
    } catch (err) {
      console.error('Failed to clear credential:', err)
    }
  }

  return (
    <div className="rounded-lg border border-[var(--border)] px-4 py-3.5" style={{ background: 'var(--bg-secondary)' }}>
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

      <div className="flex items-center gap-2 mt-3">
        <Input
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleSave()
          }}
          placeholder={configured ? 'Enter a new key to replace the stored one…' : 'Paste API key…'}
          autoComplete="off"
          className="flex-1"
        />
        <Button size="sm" onClick={handleSave} disabled={!value.trim() || busy} className="gap-1.5">
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
          Save
        </Button>
        {configured && (
          <Button size="sm" variant="ghost" onClick={handleClear} disabled={busy}>
            Clear
          </Button>
        )}
      </div>
    </div>
  )
}

export function SettingsManager() {
  const { data: status } = useAgentCredentialStatus()

  return (
    <div className="flex flex-col h-full" style={{ background: 'var(--bg-primary)' }}>
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--border)] flex-shrink-0">
        <div>
          <h1 className="text-sm font-semibold text-[var(--text-primary)]">Settings</h1>
          <p className="text-xs text-[var(--text-secondary)] mt-0.5">
            Authentication for the coding-agent CLIs
          </p>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3 max-w-2xl">
        <div className="flex items-start gap-2.5 px-3 py-2.5 rounded-lg bg-[var(--accent)]/10 border border-[var(--accent)]/20 text-xs text-[var(--text-secondary)]">
          <Info className="h-3.5 w-3.5 text-[var(--accent)] flex-shrink-0 mt-0.5" />
          <span>
            API keys are encrypted at rest and injected into each run as the runner's environment
            variable. They're scoped to your account — every agent you own uses your keys. An
            explicit env var set on an agent overrides the key you store here.
          </span>
        </div>

        <h2 className="text-xs font-medium text-[var(--text-secondary)] pt-1">Agent credentials</h2>
        {RUNNERS.map((meta) => (
          <CredentialRow key={meta.runner} meta={meta} configured={!!status?.[meta.runner]} />
        ))}
      </div>
    </div>
  )
}
