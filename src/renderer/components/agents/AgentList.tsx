import React, { useEffect } from 'react'
import { Bot, Loader2 } from 'lucide-react'
import { cn } from '@renderer/lib/utils'
import { useAgents } from '@renderer/hooks/useAgents'
import { useRuns } from '@renderer/hooks/useRuns'
import { useUIStore } from '@renderer/store/ui'
import { useAuth } from '@renderer/contexts/AuthContext'
import { StatusDot } from '@renderer/components/ui/badge'
import { api } from '@renderer/lib/ipc'
import { useQueryClient } from '@tanstack/react-query'
import type { AgentConfig, RunStatus } from '@shared/types'

const runnerLabels: Record<AgentConfig['runner'], string> = {
  claude: 'Claude Code',
  amp: 'Amp',
  cursor: 'Cursor',
}

// Compact inline SVG logos for sidebar
function RunnerIcon({ runner, size = 11 }: { runner: AgentConfig['runner']; size?: number }) {
  if (runner === 'claude') return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" style={{ flexShrink: 0 }}>
      <path d="M12 2L13.7 10.3L22 12L13.7 13.7L12 22L10.3 13.7L2 12L10.3 10.3Z" fill="#E97327"/>
    </svg>
  )
  if (runner === 'amp') return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" style={{ flexShrink: 0 }}>
      <path d="M13 2L4.5 13.5H11L10 22L19.5 10.5H13L13 2Z" strokeLinejoin="round"/>
    </svg>
  )
  // cursor
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" style={{ flexShrink: 0 }}>
      <path d="M4.5 2L4.5 18.5L7.5 15L10 21.5L12 20.5L9.5 14L15.5 14Z" fill="currentColor"/>
    </svg>
  )
}

interface AgentItemProps {
  agent: AgentConfig
  isSelected: boolean
  onClick: () => void
}

function AgentItem({ agent, isSelected, onClick }: AgentItemProps) {
  const { data: runs } = useRuns(agent.id)
  const latestRun = runs?.[0]
  const lastRunStatus = latestRun?.status as RunStatus | undefined

  return (
    <button
      onClick={onClick}
      className={cn(
        'w-full text-left px-3 py-2.5 rounded-lg flex items-start gap-2.5 transition-colors group',
        isSelected
          ? 'bg-[var(--accent)]/15 text-[var(--text-primary)]'
          : 'text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)] hover:text-[var(--text-primary)]'
      )}
    >
      <div className="mt-0.5 flex-shrink-0">
        {lastRunStatus ? (
          <StatusDot status={lastRunStatus} />
        ) : (
          <span className="inline-block h-2 w-2 rounded-full bg-[var(--border)]" />
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div
          className={cn(
            'text-sm font-medium truncate',
            isSelected ? 'text-[var(--text-primary)]' : ''
          )}
        >
          {agent.name || '(Untitled agent)'}
        </div>
        <div className="flex items-center gap-1 text-xs text-[var(--text-secondary)] mt-0.5">
          <RunnerIcon runner={agent.runner} />
          {runnerLabels[agent.runner]}
        </div>
      </div>
    </button>
  )
}

export function AgentList() {
  const { data: agents, isLoading, error } = useAgents()
  const { selectedAgentId, selectAgent } = useUIStore()
  const { user } = useAuth()
  const queryClient = useQueryClient()

  // Invalidate run queries when any run status changes so dots update in real-time
  useEffect(() => {
    const unsub = api.onRunStatusChange(() => {
      queryClient.invalidateQueries({ queryKey: ['runs'] })
    })
    return unsub
  }, [queryClient])

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8 text-[var(--text-secondary)]">
        <Loader2 className="h-4 w-4 animate-spin" />
      </div>
    )
  }

  if (error) {
    return (
      <div className="px-3 py-4 text-xs text-red-400">
        Failed to load agents
      </div>
    )
  }

  if (!agents || agents.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-10 px-4 text-center gap-3">
        <Bot className="h-8 w-8 text-[var(--border)]" />
        <p className="text-xs text-[var(--text-secondary)]">
          No agents yet. Create one to get started.
        </p>
      </div>
    )
  }

  const myAgents = agents.filter((a) => a.ownerId === user?.id)
  const sharedAgents = agents.filter((a) => a.ownerId !== user?.id)

  return (
    <div className="flex flex-col gap-0.5 px-2">
      {myAgents.length > 0 && (
        <>
          <div className="text-[10px] font-medium uppercase tracking-wider text-[var(--text-secondary)] px-3 py-1.5">
            My Agents <span className="ml-1 opacity-60">{myAgents.length}</span>
          </div>
          {myAgents.map((agent) => (
            <AgentItem
              key={agent.id}
              agent={agent}
              isSelected={agent.id === selectedAgentId}
              onClick={() => selectAgent(agent.id)}
            />
          ))}
        </>
      )}
      {sharedAgents.length > 0 && (
        <>
          <div className="text-[10px] font-medium uppercase tracking-wider text-[var(--text-secondary)] px-3 py-1.5">
            Shared Agents <span className="ml-1 opacity-60">{sharedAgents.length}</span>
          </div>
          {sharedAgents.map((agent) => (
            <AgentItem
              key={agent.id}
              agent={agent}
              isSelected={agent.id === selectedAgentId}
              onClick={() => selectAgent(agent.id)}
            />
          ))}
        </>
      )}
    </div>
  )
}
