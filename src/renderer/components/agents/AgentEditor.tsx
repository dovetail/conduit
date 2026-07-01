import React, { useEffect, useState, useCallback, useRef, useImperativeHandle, forwardRef } from 'react'
import { Loader2, Send, Share2 } from 'lucide-react'
import { Input } from '@renderer/components/ui/input'
import { Button } from '@renderer/components/ui/button'
import { PromptEditor } from './PromptEditor'
import { EnvVarEditor } from './EnvVarEditor'
import { McpEditor } from './McpEditor'
import { TriggerEditor } from './TriggerEditor'
import { ShareDialog } from '@renderer/components/ShareDialog'
import { useAgent, useUpdateAgent } from '@renderer/hooks/useAgents'
import { usePublishTargets } from '@renderer/hooks/usePublishTargets'
import { useRepositories, useRepoSyncEvents } from '@renderer/hooks/useRepositories'
import { useUIStore } from '@renderer/store/ui'
import { useAuth } from '@renderer/contexts/AuthContext'
import { cn } from '@renderer/lib/utils'
import type { AgentConfig, RunnerType, RunnerEffort } from '@shared/types'

// Inline SVG logos for each runner
const RunnerLogos: Record<RunnerType, React.FC<{ size?: number; active?: boolean }>> = {
  claude: ({ size = 22, active }) => (
    // Anthropic Claude mark — starburst / 4-pointed star in brand orange
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <path d="M12 2L13.7 10.3L22 12L13.7 13.7L12 22L10.3 13.7L2 12L10.3 10.3Z" fill={active ? 'currentColor' : '#E97327'}/>
    </svg>
  ),
  amp: ({ size = 22 }) => (
    // Amp "lightning bolt" style mark
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <path d="M13 2L4.5 13.5H11L10 22L19.5 10.5H13L13 2Z" fill="currentColor" strokeLinejoin="round"/>
    </svg>
  ),
  cursor: ({ size = 22 }) => (
    // Cursor — stylised mouse pointer cursor with tail notch
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <path d="M4.5 2L4.5 18.5L7.5 15L10 21.5L12 20.5L9.5 14L15.5 14Z" fill="currentColor"/>
    </svg>
  ),
}

const RUNNER_OPTIONS: { value: RunnerType; label: string; description: string }[] = [
  { value: 'claude', label: 'Claude Code', description: 'Anthropic' },
  { value: 'amp',    label: 'Amp',         description: 'Sourcegraph' },
  { value: 'cursor', label: 'Cursor',      description: 'Anysphere' },
]

function RunnerPicker({
  value,
  onChange,
}: {
  value: RunnerType
  onChange: (r: RunnerType) => void
}) {
  return (
    <div className="flex gap-2">
      {RUNNER_OPTIONS.map((opt) => {
        const Logo = RunnerLogos[opt.value]
        const active = value === opt.value
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => onChange(opt.value)}
            className="flex flex-col items-center gap-1.5 rounded-xl px-4 py-3 transition-all duration-150 flex-1 group"
            style={{
              background: active ? 'var(--accent)' : 'var(--bg-secondary)',
              border: `1.5px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
              color: active ? '#fff' : 'var(--text-secondary)',
              boxShadow: active ? '0 2px 12px rgba(129,140,248,0.35)' : 'none',
            }}
          >
            <span style={{ opacity: active ? 1 : 0.6 }} className="transition-opacity group-hover:opacity-100">
              <Logo size={20} active={active} />
            </span>
            <span className="text-[10px] font-semibold tracking-wide leading-tight" style={{ fontFamily: 'monospace' }}>
              {opt.label}
            </span>
            <span className="text-[9px] opacity-60 leading-none">{opt.description}</span>
          </button>
        )
      })}
    </div>
  )
}

interface AgentEditorProps {
  agentId: string
  onSaveStateChange?: (state: SaveState) => void
}

export type SaveState = 'idle' | 'saving' | 'saved' | 'error'

export interface AgentEditorHandle {
  saveNow: () => void
  saveState: SaveState
}

export const AgentEditor = forwardRef<AgentEditorHandle, AgentEditorProps>(function AgentEditor({ agentId, onSaveStateChange }, ref) {
  const { data: agent, isLoading } = useAgent(agentId)
  const updateAgent = useUpdateAgent()
  const { data: allPublishTargets = [] } = usePublishTargets()
  const { data: allRepos = [] } = useRepositories()
  useRepoSyncEvents()
  const { setShowPublishTargets, setShowRepositories } = useUIStore()
  const { user } = useAuth()
  const [showShareDialog, setShowShareDialog] = useState(false)
  const isOwner = agent?.ownerId === user?.id

  const [draft, setDraft] = useState<Partial<AgentConfig>>({})
  const [saveState, setSaveState] = useState<SaveState>('idle')
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const initializedRef = useRef<string | null>(null)

  // Initialize draft from agent data
  useEffect(() => {
    if (agent && initializedRef.current !== agent.id) {
      initializedRef.current = agent.id
      setDraft({
        name: agent.name,
        runner: agent.runner,
        prompt: agent.prompt,
        envVars: agent.envVars,
        mcpConfig: agent.mcpConfig,
        gistId: agent.gistId,
        workingDir: agent.workingDir,
        publishTargetIds: agent.publishTargetIds,
        repositoryId: agent.repositoryId,
        effort: agent.effort,
      })
    }
  }, [agent])

  const setSaveStateAndNotify = useCallback((state: SaveState) => {
    setSaveState(state)
    onSaveStateChange?.(state)
  }, [onSaveStateChange])

  const save = useCallback(
    async (updates: Partial<Omit<AgentConfig, 'id' | 'createdAt' | 'updatedAt'>>) => {
      setSaveStateAndNotify('saving')
      try {
        await updateAgent.mutateAsync({ id: agentId, data: updates })
        setSaveStateAndNotify('saved')
        setTimeout(() => setSaveStateAndNotify('idle'), 2000)
      } catch {
        setSaveStateAndNotify('error')
        setTimeout(() => setSaveStateAndNotify('idle'), 3000)
      }
    },
    [agentId, updateAgent, setSaveStateAndNotify]
  )

  const scheduleSave = useCallback(
    (updates: Partial<Omit<AgentConfig, 'id' | 'createdAt' | 'updatedAt'>>) => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
      debounceRef.current = setTimeout(() => {
        save(updates)
      }, 500)
    },
    [save]
  )

  const saveNow = useCallback(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current)
      debounceRef.current = null
    }
    const { name, runner, prompt, envVars, mcpConfig, gistId, workingDir, publishTargetIds, repositoryId } = draft
    save({ name, runner, prompt, envVars, mcpConfig, gistId, workingDir, publishTargetIds, repositoryId })
  }, [draft, save])

  useImperativeHandle(ref, () => ({
    saveNow,
    saveState,
  }), [saveNow, saveState])

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [])

  const handleChange = useCallback(
    (field: keyof typeof draft, value: unknown) => {
      const updated = { ...draft, [field]: value }
      setDraft(updated)
      const { name, runner, prompt, envVars, mcpConfig, gistId, workingDir, publishTargetIds, repositoryId, effort } = updated
      scheduleSave({ name, runner, prompt, envVars, mcpConfig, gistId, workingDir, publishTargetIds, repositoryId, effort })
    },
    [draft, scheduleSave]
  )

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12 text-[var(--text-secondary)]">
        <Loader2 className="h-5 w-5 animate-spin" />
      </div>
    )
  }

  if (!agent) {
    return (
      <div className="px-6 py-8 text-sm text-[var(--text-secondary)]">
        Agent not found.
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      <div className="flex-1 px-6 py-5 space-y-6 max-w-2xl">
        {/* Name + Share */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <label className="block text-xs font-medium text-[var(--text-secondary)]">
              Name
            </label>
            {isOwner && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setShowShareDialog(true)}
                className="gap-1.5 text-xs h-7 px-2"
              >
                <Share2 className="h-3.5 w-3.5" />
                Share
              </Button>
            )}
          </div>
          <Input
            value={draft.name ?? ''}
            onChange={(e) => handleChange('name', e.target.value)}
            placeholder="My Agent"
          />
        </div>

        {/* Runner */}
        <div className="space-y-1.5">
          <label className="block text-xs font-medium text-[var(--text-secondary)]">
            Runner
          </label>
          <RunnerPicker
            value={draft.runner ?? 'claude'}
            onChange={(r) => handleChange('runner', r)}
          />
        </div>

        {/* Reasoning effort — Claude only (maps to `claude --effort`) */}
        {(draft.runner ?? 'claude') === 'claude' && (
          <div className="space-y-1.5">
            <label className="block text-xs font-medium text-[var(--text-secondary)]">
              Reasoning Effort
            </label>
            <div className="flex gap-1 p-0.5 rounded-md bg-[var(--bg-primary)] border border-[var(--border)]">
              {([undefined, 'low', 'medium', 'high', 'xhigh', 'max'] as (RunnerEffort | undefined)[]).map((level) => {
                const active = (draft.effort ?? undefined) === level
                return (
                  <button
                    key={level ?? 'default'}
                    type="button"
                    onClick={() => handleChange('effort', level)}
                    className={cn(
                      'flex-1 text-xs py-1.5 rounded-md transition-colors font-medium capitalize',
                      active
                        ? 'bg-[var(--bg-secondary)] text-[var(--text-primary)] shadow-sm'
                        : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                    )}
                  >
                    {level ?? 'Default'}
                  </button>
                )
              })}
            </div>
            <p className="text-[10px] text-[var(--text-secondary)] opacity-70">
              Higher effort lets Claude reason longer. Default uses the CLI's built-in setting.
            </p>
          </div>
        )}

        {/* Repository */}
        <div className="space-y-1.5">
          <label className="block text-xs font-medium text-[var(--text-secondary)]">
            Repository
          </label>
          <select
            value={draft.repositoryId ?? ''}
            onChange={(e) => handleChange('repositoryId', e.target.value || undefined)}
            className="w-full h-9 rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-3 text-sm text-[var(--text-primary)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]"
          >
            <option value="">None (ephemeral workspace)</option>
            {allRepos.map((repo) => (
              <option key={repo.id} value={repo.id}>
                {repo.name} ({repo.defaultBranch}) — {repo.syncStatus === 'ready' ? 'ready' : repo.syncStatus}
              </option>
            ))}
          </select>
          {draft.repositoryId && (() => {
            const repo = allRepos.find((r) => r.id === draft.repositoryId)
            if (!repo) return null
            return (
              <div className="flex items-center gap-2 text-xs">
                <div className={cn(
                  'w-2 h-2 rounded-full',
                  repo.syncStatus === 'ready' ? 'bg-green-500' :
                  repo.syncStatus === 'error' ? 'bg-red-500' :
                  repo.syncStatus === 'cloning' || repo.syncStatus === 'syncing' ? 'bg-yellow-500' :
                  'bg-[var(--text-secondary)]'
                )} />
                <span className="text-[var(--text-secondary)]">
                  {repo.syncStatus === 'ready' ? 'Ready' : repo.syncStatus === 'error' ? `Error: ${repo.syncError}` : repo.syncStatus}
                </span>
              </div>
            )
          })()}
          <p className="text-xs text-[var(--text-secondary)]">
            Assign a managed repository to give the agent an isolated worktree per run.{' '}
            <button
              onClick={() => setShowRepositories(true)}
              className="text-[var(--accent)] hover:underline"
            >
              Manage repositories
            </button>
          </p>
        </div>

        {/* Working Directory (hidden when repo is selected) */}
        {!draft.repositoryId && (
          <div className="space-y-1.5">
            <label className="block text-xs font-medium text-[var(--text-secondary)]">
              Working Directory
            </label>
            <Input
              value={draft.workingDir ?? ''}
              onChange={(e) => handleChange('workingDir', e.target.value || undefined)}
              placeholder="Leave blank for ephemeral workspace (e.g. /Users/you/code/myrepo)"
              className="font-mono text-xs"
            />
            <p className="text-xs text-[var(--text-secondary)]">
              If set, the agent runs inside this directory instead of a temporary workspace.
            </p>
          </div>
        )}

        {/* Prompt */}
        <div className="space-y-1.5">
          <label className="block text-xs font-medium text-[var(--text-secondary)]">
            Prompt
          </label>
          <PromptEditor
            value={draft.prompt ?? ''}
            onChange={(v) => handleChange('prompt', v)}
            gistId={draft.gistId}
            onGistIdChange={(gistId) => handleChange('gistId', gistId)}
            agentId={agentId}
            runner={draft.runner ?? agent.runner}
          />
        </div>

        {/* Environment Variables */}
        <div className="space-y-1.5">
          <label className="block text-xs font-medium text-[var(--text-secondary)]">
            Environment Variables
          </label>
          <EnvVarEditor
            value={draft.envVars ?? {}}
            onChange={(v) => handleChange('envVars', v)}
          />
        </div>

        {/* MCP Config */}
        <div className="space-y-1.5">
          <label className="block text-xs font-medium text-[var(--text-secondary)]">
            MCP Configuration
          </label>
          <McpEditor
            value={draft.mcpConfig ?? { mcpServers: {} }}
            onChange={(v) => handleChange('mcpConfig', v)}
          />
        </div>

        {/* Publish Targets */}
        <div className="space-y-1.5">
          <label className="block text-xs font-medium text-[var(--text-secondary)]">
            Publish Targets
          </label>
          {allPublishTargets.length === 0 ? (
            <div className="rounded-lg border border-dashed border-[var(--border)] px-4 py-3 text-center">
              <p className="text-xs text-[var(--text-secondary)]">
                No publish targets configured.
              </p>
              <button
                onClick={() => setShowPublishTargets(true)}
                className="text-xs text-[var(--accent)] hover:underline mt-1"
              >
                Create a publish target
              </button>
            </div>
          ) : (
            <div className="space-y-1.5">
              {allPublishTargets.map((target) => {
                const selected = (draft.publishTargetIds ?? []).includes(target.id)
                return (
                  <button
                    key={target.id}
                    type="button"
                    onClick={() => {
                      const current = draft.publishTargetIds ?? []
                      const next = selected
                        ? current.filter((id) => id !== target.id)
                        : [...current, target.id]
                      handleChange('publishTargetIds', next.length > 0 ? next : undefined)
                    }}
                    className={cn(
                      'w-full flex items-center gap-2.5 px-3 py-2 rounded-lg border text-left transition-all',
                      selected
                        ? 'border-[var(--accent)] bg-[var(--accent)]/10'
                        : 'border-[var(--border)] bg-[var(--bg-secondary)] hover:border-[var(--text-secondary)]'
                    )}
                  >
                    <div
                      className={cn(
                        'w-4 h-4 rounded border-2 flex-shrink-0 flex items-center justify-center transition-colors',
                        selected
                          ? 'bg-[var(--accent)] border-[var(--accent)]'
                          : 'border-[var(--text-secondary)]'
                      )}
                    >
                      {selected && (
                        <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                          <path d="M2 5L4 7L8 3" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      )}
                    </div>
                    <Send className="h-3 w-3 flex-shrink-0 text-[var(--text-secondary)]" />
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-medium text-[var(--text-primary)] truncate">
                        {target.name}
                      </p>
                      <p className="text-[10px] text-[var(--text-secondary)] truncate">
                        {target.type === 'slack' ? ((target.config as any).webhookUrl ? 'Slack Webhook' : `Slack → #${(target.config as any).channel}`) : target.type === 'email' ? `Email → ${(target.config as any).to}` : `Webhook → ${(target.config as any).url}`}
                      </p>
                    </div>
                    {!target.enabled && (
                      <span className="text-[10px] text-amber-400 flex-shrink-0">disabled</span>
                    )}
                  </button>
                )
              })}
            </div>
          )}
        </div>

        {/* Triggers */}
        <TriggerEditor agentId={agentId} />
      </div>

      {showShareDialog && agent && (
        <ShareDialog
          entityType="agent"
          entityId={agent.id}
          isOpen={showShareDialog}
          onClose={() => setShowShareDialog(false)}
        />
      )}
    </div>
  )
})
