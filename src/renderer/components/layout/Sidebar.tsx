import React from 'react'
import { Plus, Sun, Moon, Monitor, Server, Send, FolderGit2, Settings } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { AgentList } from '@renderer/components/agents/AgentList'
import { UserMenu } from '@renderer/components/UserMenu'
import { useUIStore } from '@renderer/store/ui'
import { useCreateAgent } from '@renderer/hooks/useAgents'
import { useGlobalMcps } from '@renderer/hooks/useGlobalMcps'
import { usePublishTargets } from '@renderer/hooks/usePublishTargets'
import { useRepositories } from '@renderer/hooks/useRepositories'
import { cn } from '@renderer/lib/utils'

export function Sidebar() {
  const { theme, setTheme, selectAgent, showGlobalMcpManager, setShowGlobalMcpManager, showPublishTargets, setShowPublishTargets, showRepositories, setShowRepositories, showSettings, setShowSettings } = useUIStore()
  const createAgent = useCreateAgent()
  const { data: globalMcps = [] } = useGlobalMcps()
  const { data: publishTargets = [] } = usePublishTargets()
  const { data: repositories = [] } = useRepositories()
  const enabledGlobalCount = globalMcps.filter((m) => m.enabled).length
  const enabledPublishCount = publishTargets.filter((t) => t.enabled).length
  const readyRepoCount = repositories.filter((r) => r.syncStatus === 'ready').length

  const handleNewAgent = async () => {
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

  const cycleTheme = () => {
    if (theme === 'dark') setTheme('light')
    else if (theme === 'light') setTheme('system')
    else setTheme('dark')
  }

  const ThemeIcon =
    theme === 'dark' ? Moon : theme === 'light' ? Sun : Monitor

  return (
    <div
      className="flex flex-col h-full select-none"
      style={{ background: 'var(--bg-sidebar)' }}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border)]">
        <span className="text-xl font-bold tracking-wide text-[var(--accent)]" style={{ fontFamily: 'monospace' }}>
          &gt;_conduit
        </span>
        <div className="flex items-center gap-1">
          <UserMenu />
          <button
            onClick={cycleTheme}
            className="rounded-md p-1.5 text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)] hover:text-[var(--text-primary)] transition-colors"
            title={`Theme: ${theme}`}
          >
            <ThemeIcon className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* New Agent button */}
      <div className="px-3 py-2 border-b border-[var(--border)]">
        <Button
          variant="ghost"
          size="sm"
          onClick={handleNewAgent}
          disabled={createAgent.isPending}
          className="w-full justify-start gap-2 text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
        >
          <Plus className="h-4 w-4" />
          New Agent
        </Button>
      </div>

      {/* Agent list */}
      <div className="flex-1 overflow-y-auto py-2">
        <AgentList />
      </div>

      {/* Footer: Repos + Global MCPs + Publish Targets */}
      <div className="border-t border-[var(--border)] px-3 py-2 space-y-1">
        <button
          onClick={() => setShowRepositories(true)}
          className={cn(
            'w-full flex items-center gap-2 px-2.5 py-2 rounded-md text-xs font-medium transition-colors',
            showRepositories
              ? 'bg-[var(--accent)]/15 text-[var(--accent)]'
              : 'text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)] hover:text-[var(--text-primary)]'
          )}
        >
          <FolderGit2 className="h-3.5 w-3.5 flex-shrink-0" />
          <span className="flex-1 text-left">Repositories</span>
          {readyRepoCount > 0 && (
            <span
              className={cn(
                'px-1.5 py-0.5 rounded text-[10px] font-medium',
                showRepositories
                  ? 'bg-[var(--accent)]/20 text-[var(--accent)]'
                  : 'bg-[var(--bg-secondary)] text-[var(--text-secondary)]'
              )}
            >
              {readyRepoCount}
            </span>
          )}
        </button>
        <button
          onClick={() => setShowGlobalMcpManager(true)}
          className={cn(
            'w-full flex items-center gap-2 px-2.5 py-2 rounded-md text-xs font-medium transition-colors',
            showGlobalMcpManager
              ? 'bg-[var(--accent)]/15 text-[var(--accent)]'
              : 'text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)] hover:text-[var(--text-primary)]'
          )}
        >
          <Server className="h-3.5 w-3.5 flex-shrink-0" />
          <span className="flex-1 text-left">Global MCPs</span>
          {enabledGlobalCount > 0 && (
            <span
              className={cn(
                'px-1.5 py-0.5 rounded text-[10px] font-medium',
                showGlobalMcpManager
                  ? 'bg-[var(--accent)]/20 text-[var(--accent)]'
                  : 'bg-[var(--bg-secondary)] text-[var(--text-secondary)]'
              )}
            >
              {enabledGlobalCount}
            </span>
          )}
        </button>
        <button
          onClick={() => setShowPublishTargets(true)}
          className={cn(
            'w-full flex items-center gap-2 px-2.5 py-2 rounded-md text-xs font-medium transition-colors',
            showPublishTargets
              ? 'bg-[var(--accent)]/15 text-[var(--accent)]'
              : 'text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)] hover:text-[var(--text-primary)]'
          )}
        >
          <Send className="h-3.5 w-3.5 flex-shrink-0" />
          <span className="flex-1 text-left">Publish Targets</span>
          {enabledPublishCount > 0 && (
            <span
              className={cn(
                'px-1.5 py-0.5 rounded text-[10px] font-medium',
                showPublishTargets
                  ? 'bg-[var(--accent)]/20 text-[var(--accent)]'
                  : 'bg-[var(--bg-secondary)] text-[var(--text-secondary)]'
              )}
            >
              {enabledPublishCount}
            </span>
          )}
        </button>
        <button
          onClick={() => setShowSettings(true)}
          className={cn(
            'w-full flex items-center gap-2 px-2.5 py-2 rounded-md text-xs font-medium transition-colors',
            showSettings
              ? 'bg-[var(--accent)]/15 text-[var(--accent)]'
              : 'text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)] hover:text-[var(--text-primary)]'
          )}
        >
          <Settings className="h-3.5 w-3.5 flex-shrink-0" />
          <span className="flex-1 text-left">Settings</span>
        </button>
      </div>
    </div>
  )
}
