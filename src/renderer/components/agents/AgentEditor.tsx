import React, { useEffect, useState, useCallback, useRef, useImperativeHandle, forwardRef } from 'react'
import { Loader2, Send } from 'lucide-react'
import { Input } from '@renderer/components/ui/input'
import { PromptEditor } from './PromptEditor'
import { EnvVarEditor } from './EnvVarEditor'
import { McpEditor } from './McpEditor'
import { TriggerEditor } from './TriggerEditor'
import { CollapsibleSection } from './CollapsibleSection'
import { useAgent, useUpdateAgent, useRunnerClis } from '@renderer/hooks/useAgents'
import { usePublishTargets } from '@renderer/hooks/usePublishTargets'
import { useRepositories, useRepoSyncEvents } from '@renderer/hooks/useRepositories'
import { useTriggers } from '@renderer/hooks/useTriggers'
import { useUIStore } from '@renderer/store/ui'
import { cn } from '@renderer/lib/utils'
import type { AgentConfig, RunnerType, RunnerEffort } from '@shared/types'

// Inline SVG logos for each runner
// Official brand marks, used only to identify each runner CLI in the picker.
// Rendered monochrome via `currentColor` so they read on both the selected
// (white) and unselected states. Sources: Claude/Cursor from Simple Icons,
// Amp from ampcode.com's brand mark.
const RunnerLogos: Record<RunnerType, React.FC<{ size?: number; active?: boolean }>> = {
  claude: ({ size = 18 }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z" />
    </svg>
  ),
  amp: ({ size = 18 }) => (
    <svg width={size} height={size} viewBox="0 0 21 21" fill="currentColor" aria-hidden="true">
      <path d="M3.76879 18.3015L8.49839 13.505L10.2196 20.0399L12.72 19.3561L10.2288 9.86749L0.890876 7.33844L0.22594 9.89331L6.65134 11.6388L1.94138 16.4282L3.76879 18.3015Z" />
      <path d="M17.4074 12.7414L19.9078 12.0575L17.4167 2.56897L8.07873 0.0399246L7.4138 2.5948L15.2992 4.73685L17.4074 12.7414Z" />
      <path d="M13.8184 16.3883L16.3188 15.7044L13.8276 6.21588L4.48971 3.68683L3.82477 6.24171L11.7101 8.38376L13.8184 16.3883Z" />
    </svg>
  ),
  cursor: ({ size = 18 }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M11.503.131 1.891 5.678a.84.84 0 0 0-.42.726v11.188c0 .3.162.575.42.724l9.609 5.55a1 1 0 0 0 .998 0l9.61-5.55a.84.84 0 0 0 .42-.724V6.404a.84.84 0 0 0-.42-.726L12.497.131a1.01 1.01 0 0 0-.996 0M2.657 6.338h18.55c.263 0 .43.287.297.515L12.23 22.918c-.062.107-.229.064-.229-.06V12.335a.59.59 0 0 0-.295-.51l-9.11-5.257c-.109-.063-.064-.23.061-.23" />
    </svg>
  ),
}

const RUNNER_OPTIONS: { value: RunnerType; label: string; description: string }[] = [
  { value: 'claude', label: 'Claude Code', description: 'Anthropic' },
  { value: 'amp',    label: 'Amp',         description: 'Sourcegraph' },
  { value: 'cursor', label: 'Cursor',      description: 'Anysphere' },
]

/** Common exact Cursor model identifiers — free text is allowed; this is a
 * convenience datalist. The account-specific list comes from `cursor-agent models`. */
const CURSOR_MODEL_SUGGESTIONS = [
  'auto',
  'composer-2.5',
  'composer-2.5-fast',
  'cursor-grok-4.6-high',
  'cursor-grok-4.6-high-fast',
  'claude-opus-5-high',
  'claude-opus-5-thinking-high',
  'gpt-5.6-sol-high',
  'gpt-5.5-high',
  'kimi-k3-high',
]

function EffortPicker({
  value,
  onChange,
  disabled,
}: {
  value: RunnerEffort | undefined
  onChange: (level: RunnerEffort | undefined) => void
  disabled?: boolean
}) {
  return (
    <div
      className={cn(
        'flex gap-1 p-0.5 rounded-md bg-[var(--bg-primary)] border border-[var(--border)]',
        disabled && 'opacity-50 pointer-events-none'
      )}
      aria-disabled={disabled}
    >
      {([undefined, 'low', 'medium', 'high', 'xhigh', 'max'] as (RunnerEffort | undefined)[]).map((level) => {
        const active = (value ?? undefined) === level
        return (
          <button
            key={level ?? 'default'}
            type="button"
            disabled={disabled}
            onClick={() => onChange(level)}
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
  )
}

function RunnerPicker({
  value,
  onChange,
}: {
  value: RunnerType
  onChange: (r: RunnerType) => void
}) {
  const { data: clis } = useRunnerClis()
  return (
    <div className="flex gap-2">
      {RUNNER_OPTIONS.map((opt) => {
        const Logo = RunnerLogos[opt.value]
        const active = value === opt.value
        const cli = clis?.find((c) => c.runner === opt.value)
        const cliTitle = !cli
          ? 'Checking CLI availability…'
          : cli.installed
          ? `${cli.binary} CLI found${cli.path ? ` at ${cli.path}` : ''}`
          : `${cli.binary} CLI not found in PATH — this runner won't work`
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => onChange(opt.value)}
            className="relative flex flex-col items-center gap-0.5 rounded-lg px-3 py-2 transition-all duration-150 flex-1 group"
            style={{
              background: active ? 'var(--accent)' : 'var(--bg-secondary)',
              border: `1.5px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
              color: active ? '#fff' : 'var(--text-secondary)',
              boxShadow: active ? '0 2px 12px rgba(129,140,248,0.35)' : 'none',
            }}
          >
            {/* CLI availability indicator */}
            {cli && (
              <span
                title={cliTitle}
                className="absolute top-1.5 right-1.5 w-2 h-2 rounded-full"
                style={{ backgroundColor: cli.installed ? '#22C55E' : '#EF4444' }}
              />
            )}
            <span style={{ opacity: active ? 1 : 0.6 }} className="transition-opacity group-hover:opacity-100">
              <Logo size={18} active={active} />
            </span>
            <span className="text-[10px] font-semibold tracking-wide leading-tight" style={{ fontFamily: 'monospace' }}>
              {opt.label}
            </span>
            <span className="text-[9px] opacity-60 leading-none">{opt.description}</span>
            {cli && !cli.installed && (
              <span className="text-[8px] leading-none text-red-400 font-medium">not installed</span>
            )}
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
  const { data: triggers = [] } = useTriggers(agentId)
  useRepoSyncEvents()
  const { setShowPublishTargets, setShowRepositories } = useUIStore()

  const [draft, setDraft] = useState<Partial<AgentConfig>>({})
  const [saveState, setSaveState] = useState<SaveState>('idle')
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const initializedRef = useRef<string | null>(null)
  const nameInputRef = useRef<HTMLInputElement>(null)
  const focusedForRef = useRef<string | null>(null)

  // The agent's updatedAt the draft was last loaded from, and whether a save is
  // in flight — together they tell an external change (another tab, an MCP
  // client) apart from the echo of our own autosave.
  const syncedUpdatedAtRef = useRef<number | null>(null)
  const savingRef = useRef(false)

  // Initialize draft from agent data, and re-sync it when the agent changes
  // elsewhere while there are no unsaved local edits — otherwise the next
  // autosave of the stale draft would silently revert the external change.
  useEffect(() => {
    if (!agent) return
    const isNewAgent = initializedRef.current !== agent.id
    const changedElsewhere =
      !isNewAgent &&
      syncedUpdatedAtRef.current !== agent.updatedAt &&
      !debounceRef.current &&
      !savingRef.current
    if (isNewAgent || changedElsewhere) {
      initializedRef.current = agent.id
      syncedUpdatedAtRef.current = agent.updatedAt
      setDraft({
        name: agent.name,
        description: agent.description,
        runner: agent.runner,
        prompt: agent.prompt,
        envVars: agent.envVars,
        mcpConfig: agent.mcpConfig,
        gistId: agent.gistId,
        workingDir: agent.workingDir,
        publishTargetIds: agent.publishTargetIds,
        repositoryId: agent.repositoryId,
        effort: agent.effort,
        model: agent.model,
        bgTaskTimeoutSeconds: agent.bgTaskTimeoutSeconds,
        memoryCapMb: agent.memoryCapMb,
        workerMemoryMib: agent.workerMemoryMib,
        enableRepoMcps: agent.enableRepoMcps ?? false,
      })
    }
  }, [agent])

  // Land ready to type when opening an unnamed agent (e.g. a fresh clone). Focus
  // once per agent id so re-renders and manual edits don't steal focus back.
  useEffect(() => {
    if (agent && agent.name === '' && focusedForRef.current !== agent.id) {
      focusedForRef.current = agent.id
      nameInputRef.current?.focus()
    }
  }, [agent])

  const setSaveStateAndNotify = useCallback((state: SaveState) => {
    setSaveState(state)
    onSaveStateChange?.(state)
  }, [onSaveStateChange])

  const save = useCallback(
    async (updates: Partial<Omit<AgentConfig, 'id' | 'createdAt' | 'updatedAt'>>) => {
      setSaveStateAndNotify('saving')
      savingRef.current = true
      try {
        const saved = await updateAgent.mutateAsync({ id: agentId, data: updates })
        syncedUpdatedAtRef.current = saved.updatedAt
        setSaveStateAndNotify('saved')
        setTimeout(() => setSaveStateAndNotify('idle'), 2000)
      } catch {
        setSaveStateAndNotify('error')
        setTimeout(() => setSaveStateAndNotify('idle'), 3000)
      } finally {
        savingRef.current = false
      }
    },
    [agentId, updateAgent, setSaveStateAndNotify]
  )

  const scheduleSave = useCallback(
    (updates: Partial<Omit<AgentConfig, 'id' | 'createdAt' | 'updatedAt'>>) => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
      debounceRef.current = setTimeout(() => {
        debounceRef.current = null
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
    const { name, description, runner, prompt, envVars, mcpConfig, gistId, workingDir, publishTargetIds, repositoryId } = draft
    save({ name, description, runner, prompt, envVars, mcpConfig, gistId, workingDir, publishTargetIds, repositoryId })
  }, [draft, save])

  // Flush the pending debounced save and wait for it to land. The per-agent MCP
  // OAuth flow needs the latest `mcpConfig` persisted so the server can resolve
  // "{agentId}:{serverKey}" — otherwise a just-added URL server isn't found.
  const flushSave = useCallback(async () => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current)
      debounceRef.current = null
    }
    const { name, description, runner, prompt, envVars, mcpConfig, gistId, workingDir, publishTargetIds, repositoryId, effort, model, bgTaskTimeoutSeconds, memoryCapMb, workerMemoryMib, enableRepoMcps } = draft
    await save({ name, description, runner, prompt, envVars, mcpConfig, gistId, workingDir, publishTargetIds, repositoryId, effort, model, bgTaskTimeoutSeconds, memoryCapMb, workerMemoryMib, enableRepoMcps })
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
      const { name, description, runner, prompt, envVars, mcpConfig, gistId, workingDir, publishTargetIds, repositoryId, effort, model, bgTaskTimeoutSeconds, memoryCapMb, workerMemoryMib, enableRepoMcps } = updated
      scheduleSave({ name, description, runner, prompt, envVars, mcpConfig, gistId, workingDir, publishTargetIds, repositoryId, effort, model, bgTaskTimeoutSeconds, memoryCapMb, workerMemoryMib, enableRepoMcps })
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

  // Collapsed-section summaries — keep each section's state visible at a glance.
  const runnerLabel =
    RUNNER_OPTIONS.find((o) => o.value === (draft.runner ?? 'claude'))?.label ?? draft.runner
  const identitySummary = `${draft.name?.trim() || 'Unnamed'} · ${runnerLabel}`

  const promptLen = (draft.prompt ?? '').length
  const promptSummary = promptLen > 0 ? `${promptLen} chars` : 'empty'

  const selectedRepo = allRepos.find((r) => r.id === draft.repositoryId)
  const workspaceLabel = selectedRepo
    ? `${selectedRepo.name} (${selectedRepo.defaultBranch})`
    : draft.workingDir
    ? 'custom dir'
    : 'ephemeral'
  const timeoutLabel =
    draft.bgTaskTimeoutSeconds != null ? `timeout ${draft.bgTaskTimeoutSeconds}s` : 'default timeout'
  const capLabel = draft.memoryCapMb != null ? `cap ${draft.memoryCapMb}MB` : 'default cap'
  const workspaceSummary = `${workspaceLabel} · ${timeoutLabel} · ${capLabel} · repo MCPs ${draft.enableRepoMcps ? 'on' : 'off'}`

  const mcpCount = Object.keys(draft.mcpConfig?.mcpServers ?? {}).length
  const envCount = Object.keys(draft.envVars ?? {}).length
  const publishCount = (draft.publishTargetIds ?? []).length
  const toolsParts = [
    mcpCount ? `${mcpCount} MCP server${mcpCount === 1 ? '' : 's'}` : null,
    envCount ? `${envCount} env var${envCount === 1 ? '' : 's'}` : null,
    publishCount ? `${publishCount} publish target${publishCount === 1 ? '' : 's'}` : null,
  ].filter(Boolean)
  const toolsSummary = toolsParts.length > 0 ? toolsParts.join(' · ') : 'not configured'

  const triggerCount = triggers.length
  const automationSummary =
    triggerCount > 0 ? `${triggerCount} trigger${triggerCount === 1 ? '' : 's'}` : 'no triggers — runs on demand'

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      <div className="flex-1 px-6 py-5 space-y-3 max-w-3xl">
        {/* Identity */}
        <CollapsibleSection title="Identity" summary={identitySummary}>
          <div className="space-y-1.5">
            <label className="block text-xs font-medium text-[var(--text-secondary)]">
              Name
            </label>
            <Input
              ref={nameInputRef}
              value={draft.name ?? ''}
              onChange={(e) => handleChange('name', e.target.value)}
              placeholder="My Agent"
            />
          </div>

          <div className="space-y-1.5">
            <label className="block text-xs font-medium text-[var(--text-secondary)]">
              Description
            </label>
            <Input
              value={draft.description ?? ''}
              onChange={(e) => handleChange('description', e.target.value || undefined)}
              placeholder="What does this agent do?"
            />
          </div>

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
              <EffortPicker
                value={draft.effort}
                onChange={(level) => handleChange('effort', level)}
              />
              <p className="text-[10px] text-[var(--text-secondary)] opacity-70">
                Higher effort lets Claude reason longer. Default uses the CLI's built-in setting.
              </p>
            </div>
          )}

          {/* Exact model identifier — Cursor only (`cursor-agent --model <id>`) */}
          {(draft.runner ?? 'claude') === 'cursor' && (
            <div className="space-y-1.5">
              <label className="block text-xs font-medium text-[var(--text-secondary)]">
                Model
              </label>
              <Input
                value={draft.model ?? ''}
                onChange={(e) => handleChange('model', e.target.value || undefined)}
                placeholder="auto"
                list="cursor-model-suggestions"
                spellCheck={false}
              />
              <datalist id="cursor-model-suggestions">
                {CURSOR_MODEL_SUGGESTIONS.map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
              <p className="text-[10px] text-[var(--text-secondary)] opacity-70">
                Exact identifier passed to <code>cursor-agent --model</code>, including its effort
                suffix. Empty uses <code>auto</code>. Run <code>cursor-agent models</code> to list
                the models available to your account.
              </p>
            </div>
          )}
        </CollapsibleSection>

        {/* Prompt — the heart of the agent */}
        <CollapsibleSection title="Prompt" hero summary={promptSummary}>
          <PromptEditor
            value={draft.prompt ?? ''}
            onChange={(v) => handleChange('prompt', v)}
            gistId={draft.gistId}
            onGistIdChange={(gistId) => handleChange('gistId', gistId)}
            agentId={agentId}
            runner={draft.runner ?? agent.runner}
          />
        </CollapsibleSection>

        {/* Workspace & execution */}
        <CollapsibleSection title="Workspace & execution" defaultOpen={false} summary={workspaceSummary}>
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

          {/* Background-task timeout — per-agent override (0 = run indefinitely) */}
          <div className="space-y-1.5">
            <label className="block text-xs font-medium text-[var(--text-secondary)]">
              Background Task Timeout (seconds)
            </label>
            <Input
              type="number"
              min={0}
              value={draft.bgTaskTimeoutSeconds ?? ''}
              onChange={(e) => {
                const raw = e.target.value.trim()
                handleChange(
                  'bgTaskTimeoutSeconds',
                  raw === '' ? undefined : Math.max(0, Math.floor(Number(raw) || 0))
                )
              }}
              placeholder="Inherit default (0 = run indefinitely)"
            />
            <p className="text-[10px] text-[var(--text-secondary)] opacity-70">
              How long to wait for background tasks before terminating them. 0 waits indefinitely.
              Leave blank to inherit your per-provider default from Settings.
              {(draft.runner ?? 'claude') !== 'claude' && ' Currently only the Claude runner acts on this.'}
            </p>
          </div>

          {/* Memory cap — per-agent Node heap ceiling (0 = uncapped) */}
          <div className="space-y-1.5">
            <label className="block text-xs font-medium text-[var(--text-secondary)]">
              Memory Cap (MB per Node process)
            </label>
            <Input
              type="number"
              min={0}
              value={draft.memoryCapMb ?? ''}
              onChange={(e) => {
                const raw = e.target.value.trim()
                handleChange(
                  'memoryCapMb',
                  raw === '' ? undefined : Math.max(0, Math.floor(Number(raw) || 0))
                )
              }}
              placeholder="Inherit server default (0 = uncapped)"
            />
            <p className="text-[10px] text-[var(--text-secondary)] opacity-70">
              Heap ceiling injected as --max-old-space-size for every Node process the run spawns
              (agent CLI, tsc, test workers). Caps each process, not the whole run. 0 is uncapped.
              Leave blank to inherit the server-wide default.
            </p>
          </div>

          {/* Fargate task memory — whole-task size, distinct from the Node heap cap */}
          <div className="space-y-1.5">
            <label className="block text-xs font-medium text-[var(--text-secondary)]">
              Fargate task memory (MiB)
            </label>
            <Input
              type="number"
              min={4096}
              max={16384}
              step={1024}
              value={draft.workerMemoryMib ?? ''}
              onChange={(e) => {
                const raw = e.target.value.trim()
                handleChange(
                  'workerMemoryMib',
                  raw === '' ? undefined : Math.max(0, Math.floor(Number(raw) || 0))
                )
              }}
              placeholder="8192 (2 vCPU default)"
            />
            <p className="text-[10px] text-[var(--text-secondary)] opacity-70">
              Memory of the Fargate task this agent runs in, at 2 vCPU. 4096–16384 MiB, in steps of
              1024. Leave blank for 8192. Ignored when the run executes locally.
            </p>
          </div>

          {/* Repository-configured MCPs toggle */}
          <div className="space-y-1.5">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={draft.enableRepoMcps ?? false}
                onChange={(e) => handleChange('enableRepoMcps', e.target.checked)}
                className="rounded border-[var(--border)] accent-[var(--accent)]"
              />
              <span className="text-xs font-medium text-[var(--text-primary)]">
                Enable repository-configured MCP servers
              </span>
            </label>
            <p className="text-[10px] text-[var(--text-secondary)] opacity-70 pl-6">
              When on, MCP servers defined in the repository's own <code className="font-mono">.mcp.json</code> (and the
              host's personal Claude connectors) load alongside Conduit's managed MCPs. When off, runs use only Conduit's
              global and agent MCP servers for a clean, reproducible environment.
            </p>
          </div>
        </CollapsibleSection>

        {/* Tools & integrations */}
        <CollapsibleSection title="Tools & integrations" defaultOpen={false} summary={toolsSummary}>
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
              agentId={agentId}
              flushSave={flushSave}
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
        </CollapsibleSection>

        {/* Automation */}
        <CollapsibleSection title="Automation" defaultOpen={false} summary={automationSummary}>
          <TriggerEditor agentId={agentId} />
        </CollapsibleSection>
      </div>
    </div>
  )
})
