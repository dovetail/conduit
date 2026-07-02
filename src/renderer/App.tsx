import React, { useEffect, useCallback } from 'react'
import { PanelGroup, Panel, PanelResizeHandle } from 'react-resizable-panels'
import { Sidebar } from './components/layout/Sidebar'
import { MainPanel } from './components/layout/MainPanel'
import { GlobalMcpManager } from './components/settings/GlobalMcpManager'
import { PublishTargetManager } from './components/settings/PublishTargetManager'
import { RepositoryManager } from './components/settings/RepositoryManager'
import { SettingsManager } from './components/settings/SettingsManager'
import { LoginPage } from './components/LoginPage'
import { useAuth } from './contexts/AuthContext'
import { useUIStore } from './store/ui'
import { useCreateAgent } from './hooks/useAgents'
import { cn } from './lib/utils'

function EmptyState() {
  const createAgent = useCreateAgent()
  const { selectAgent } = useUIStore()

  const handleCreate = async () => {
    try {
      const agent = await createAgent.mutateAsync({
        name: 'New Agent',
        runner: 'claude',
        prompt: '',
        envVars: {},
        mcpConfig: { mcpServers: {} },
      })
      selectAgent(agent.id)
    } catch (e) {
      console.error('Failed to create agent:', e)
    }
  }

  return (
    <div className="flex flex-col items-center justify-center h-full gap-4 text-center px-8">
      <div className="space-y-2">
        <h2 className="text-lg font-semibold text-[var(--text-primary)]">
          Welcome to Conduit
        </h2>
        <p className="text-sm text-[var(--text-secondary)] max-w-xs">
          Manage and run AI CLI agents from one place. Create an agent to get started.
        </p>
      </div>
      <button
        onClick={handleCreate}
        disabled={createAgent.isPending}
        className={cn(
          'px-4 py-2 rounded-lg text-sm font-medium transition-colors',
          'bg-[var(--accent)] text-[var(--accent-fg)] hover:bg-[var(--accent-hover)]',
          'disabled:opacity-50 disabled:pointer-events-none'
        )}
      >
        Create Agent
      </button>
      <p className="text-xs text-[var(--text-secondary)]">
        Or press{' '}
        <kbd className="px-1 py-0.5 rounded bg-[var(--bg-secondary)] border border-[var(--border)] text-[var(--text-primary)] font-mono text-xs">
          Cmd+N
        </kbd>{' '}
        to create an agent
      </p>
    </div>
  )
}

export default function App() {
  const { isAuthenticated } = useAuth()
  const { selectedAgentId, selectAgent, showGlobalMcpManager, showPublishTargets, showRepositories, showSettings } = useUIStore()
  const createAgent = useCreateAgent()

  const handleNewAgent = useCallback(async () => {
    try {
      const agent = await createAgent.mutateAsync({
        name: 'New Agent',
        runner: 'claude',
        prompt: '',
        envVars: {},
        mcpConfig: { mcpServers: {} },
      })
      selectAgent(agent.id)
    } catch (e) {
      console.error('Failed to create agent:', e)
    }
  }, [createAgent, selectAgent])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const isMac = navigator.platform.toLowerCase().includes('mac')
      const modKey = isMac ? e.metaKey : e.ctrlKey

      // Cmd/Ctrl+N → new agent
      if (modKey && e.key === 'n') {
        e.preventDefault()
        handleNewAgent()
      }

      // Cmd/Ctrl+, → settings (placeholder)
      if (modKey && e.key === ',') {
        e.preventDefault()
        // Settings panel - future feature
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [handleNewAgent])

  if (!isAuthenticated) {
    return <LoginPage />
  }

  return (
    <div className="flex h-screen w-screen overflow-hidden" style={{ background: 'var(--bg-primary)' }}>
      <PanelGroup direction="horizontal" className="h-full w-full">
        {/* Sidebar */}
        <Panel
          defaultSize={22}
          minSize={14}
          maxSize={40}
          style={{ minWidth: 180, maxWidth: 480 }}
        >
          <div className="h-full border-r border-[var(--border)]">
            <Sidebar />
          </div>
        </Panel>

        <PanelResizeHandle className="w-1 bg-[var(--border)] hover:bg-[var(--accent)]/50 transition-colors cursor-col-resize" />

        {/* Main content */}
        <Panel defaultSize={78} minSize={40}>
          <div className="h-full">
            {showSettings ? (
              <SettingsManager />
            ) : showRepositories ? (
              <RepositoryManager />
            ) : showGlobalMcpManager ? (
              <GlobalMcpManager />
            ) : showPublishTargets ? (
              <PublishTargetManager />
            ) : selectedAgentId ? (
              <MainPanel agentId={selectedAgentId} />
            ) : (
              <EmptyState />
            )}
          </div>
        </Panel>
      </PanelGroup>
    </div>
  )
}
