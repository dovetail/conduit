import React, { useState, useEffect, useRef } from 'react'
import { Trash2, Save, CheckCircle2, Loader2 } from 'lucide-react'
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels'
import { useQueryClient } from '@tanstack/react-query'
import { Button } from '@renderer/components/ui/button'
import { AgentEditor, type AgentEditorHandle } from '@renderer/components/agents/AgentEditor'
import { RunControls } from '@renderer/components/runs/RunControls'
import { RunHistory } from '@renderer/components/runs/RunHistory'
import { RunDetail } from '@renderer/components/runs/RunDetail'
import { TerminalPane } from '@renderer/components/layout/TerminalPane'
import { useAgent, useDeleteAgent } from '@renderer/hooks/useAgents'
import { useRuns } from '@renderer/hooks/useRuns'
import { useAuth } from '@renderer/contexts/AuthContext'
import { useUIStore } from '@renderer/store/ui'
import { cn } from '@renderer/lib/utils'
import { api } from '@renderer/lib/ipc'
import type { RunStatus, RunStatusChangePayload } from '@shared/types'

type Tab = 'configure' | 'runs'

interface MainPanelProps {
  agentId: string
}

export function MainPanel({ agentId }: MainPanelProps) {
  const { data: agent } = useAgent(agentId)
  const { data: runs } = useRuns(agentId)
  const deleteAgent = useDeleteAgent()
  const { user } = useAuth()
  const { activeRunId, setActiveRun, selectAgent, viewedRunId, setViewedRun } = useUIStore()
  const isOwner = agent?.ownerId === user?.id
  const queryClient = useQueryClient()

  // Open on the runs tab when the URL deep-links a specific run.
  const [tab, setTab] = useState<Tab>(viewedRunId ? 'runs' : 'configure')

  // Track live run status locally so RunControls can react
  const [liveRunStatus, setLiveRunStatus] = useState<RunStatus | null>(null)
  const [liveRunStartedAt, setLiveRunStartedAt] = useState<number | null>(null)
  const editorRef = useRef<AgentEditorHandle>(null)
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')

  // When the active run changes, sync local status
  useEffect(() => {
    if (!activeRunId || !runs) {
      setLiveRunStatus(null)
      setLiveRunStartedAt(null)
      return
    }
    const run = runs.find((r) => r.id === activeRunId)
    if (run) {
      setLiveRunStatus(run.status)
      setLiveRunStartedAt(run.startedAt)
    }
  }, [activeRunId, runs])

  // Subscribe to global run status changes for the active run
  useEffect(() => {
    const unsub = api.onRunStatusChange((payload: RunStatusChangePayload) => {
      if (payload.runId === activeRunId) {
        setLiveRunStatus(payload.status)
        // Refresh the runs list so history shows updated status/duration
        queryClient.invalidateQueries({ queryKey: ['runs', agentId] })
      }
    })
    return () => unsub()
  }, [activeRunId, agentId, queryClient])

  const handleDeleteAgent = async () => {
    if (!window.confirm(`Delete agent "${agent?.name}"? This cannot be undone.`)) return
    await deleteAgent.mutateAsync(agentId)
    selectAgent(null)
  }

  const isLive =
    activeRunId !== null &&
    (liveRunStatus === 'running' || liveRunStatus === 'launched')

  // Which terminal to show in the runs tab
  const showLiveTerminal = isLive && tab === 'runs'
  const showReplayTerminal = !isLive && viewedRunId !== null && tab === 'runs'

  return (
    <div className="flex flex-col h-full" style={{ background: 'var(--bg-primary)' }}>
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-3 border-b border-[var(--border)] flex-shrink-0">
        <h1 className="text-sm font-semibold text-[var(--text-primary)] truncate">
          {agent?.name ?? 'Agent'}
        </h1>
        <div className="flex items-center gap-2">
          {saveState === 'saved' && (
            <span className="flex items-center gap-1 text-xs text-green-500">
              <CheckCircle2 className="h-3 w-3" />
              Saved
            </span>
          )}
          {saveState === 'error' && (
            <span className="text-xs text-red-400">Failed</span>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() => editorRef.current?.saveNow()}
            disabled={saveState === 'saving'}
            className="gap-1.5 text-xs"
            title="Save agent configuration"
          >
            {saveState === 'saving' ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Save className="h-3 w-3" />
            )}
            Save
          </Button>
          <RunControls
            agentId={agentId}
            activeRunId={activeRunId}
            activeRunStatus={liveRunStatus}
            activeRunStartedAt={liveRunStartedAt}
            onRunStarted={() => {
              // setActiveRun (in RunControls) already points viewedRunId + URL at the
              // new run; the live terminal takes precedence while it's running.
              setTab('runs')
            }}
          />
          {isOwner && (
            <Button
              variant="ghost"
              size="sm"
              onClick={handleDeleteAgent}
              className="text-[var(--text-secondary)] hover:text-red-400 px-1.5"
              title="Delete agent"
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-0 border-b border-[var(--border)] px-5 flex-shrink-0">
        {(['configure', 'runs'] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={cn(
              'px-3 py-2.5 text-sm font-medium border-b-2 transition-colors capitalize',
              tab === t
                ? 'border-[var(--accent)] text-[var(--text-primary)]'
                : 'border-transparent text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
            )}
          >
            {t}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="flex-1 min-h-0">
        {tab === 'configure' && (
          <div className="h-full overflow-y-auto">
            <AgentEditor ref={editorRef} agentId={agentId} onSaveStateChange={setSaveState} />
          </div>
        )}

        {tab === 'runs' && (
          <PanelGroup direction="vertical" className="h-full">
            {/* History list */}
            <Panel defaultSize={35} minSize={15}>
              <div className="h-full overflow-y-auto border-b border-[var(--border)]">
                <RunHistory
                  agentId={agentId}
                  selectedRunId={viewedRunId ?? activeRunId}
                  onSelectRun={(runId) => {
                    // Sets viewedRunId + updates the URL for deep-linking. When it's
                    // the active run and still live, showLiveTerminal takes precedence.
                    setViewedRun(runId)
                  }}
                />
              </div>
            </Panel>

            <PanelResizeHandle className="h-1 bg-[var(--border)] hover:bg-[var(--accent)]/50 transition-colors cursor-row-resize" />

            {/* Terminal area */}
            <Panel defaultSize={65} minSize={20}>
              <div className="h-full">
                {showLiveTerminal && (
                  <TerminalPane runId={activeRunId} />
                )}
                {showReplayTerminal && (
                  <RunDetail runId={viewedRunId!} />
                )}
                {!showLiveTerminal && !showReplayTerminal && (
                  <div className="flex items-center justify-center h-full text-sm text-[var(--text-secondary)]">
                    Select a run to view output
                  </div>
                )}
              </div>
            </Panel>
          </PanelGroup>
        )}
      </div>
    </div>
  )
}
