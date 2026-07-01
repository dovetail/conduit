import React from 'react'
import { Loader2 } from 'lucide-react'
import { cn } from '@renderer/lib/utils'
import { formatDuration, formatRelativeTime } from '@renderer/lib/utils'
import { StatusBadge } from '@renderer/components/ui/badge'
import { useRuns } from '@renderer/hooks/useRuns'
import type { ExecutionRun } from '@shared/types'

interface RunHistoryProps {
  agentId: string
  selectedRunId: string | null
  onSelectRun: (runId: string) => void
}

interface RunRowProps {
  run: ExecutionRun
  index: number
  isSelected: boolean
  onClick: () => void
}

function RunRow({ run, index, isSelected, onClick }: RunRowProps) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'w-full text-left px-4 py-3 flex items-center gap-3 transition-colors border-b border-[var(--border)] last:border-0',
        isSelected
          ? 'bg-[var(--accent)]/10'
          : 'hover:bg-[var(--bg-secondary)]'
      )}
    >
      <span className="text-xs text-[var(--text-secondary)] tabular-nums w-12 flex-shrink-0">
        #{index + 1}
      </span>
      <div className="flex-1 min-w-0 flex items-center gap-2">
        <StatusBadge status={run.status} />
        {run.lastLine && (
          <span
            className="text-xs text-[var(--text-secondary)] font-mono truncate min-w-0"
            title={run.lastLine}
          >
            {run.lastLine}
          </span>
        )}
      </div>
      <span className="text-xs text-[var(--text-secondary)] font-mono tabular-nums flex-shrink-0">
        {formatDuration(run.durationMs)}
      </span>
      <span className="text-xs text-[var(--text-secondary)] flex-shrink-0 min-w-[80px] text-right">
        {formatRelativeTime(run.startedAt)}
      </span>
    </button>
  )
}

export function RunHistory({ agentId, selectedRunId, onSelectRun }: RunHistoryProps) {
  const { data: runs, isLoading, error } = useRuns(agentId)

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8 text-[var(--text-secondary)]">
        <Loader2 className="h-4 w-4 animate-spin" />
      </div>
    )
  }

  if (error) {
    return (
      <div className="px-4 py-4 text-xs text-red-400">Failed to load runs</div>
    )
  }

  if (!runs || runs.length === 0) {
    return (
      <div className="px-4 py-8 text-center text-sm text-[var(--text-secondary)]">
        No runs yet. Click Run to start.
      </div>
    )
  }

  const sorted = [...runs].sort((a, b) => b.startedAt - a.startedAt)

  return (
    <div className="flex flex-col divide-y divide-[var(--border)]">
      {sorted.map((run, idx) => (
        <RunRow
          key={run.id}
          run={run}
          index={sorted.length - 1 - idx}
          isSelected={run.id === selectedRunId}
          onClick={() => onSelectRun(run.id)}
        />
      ))}
    </div>
  )
}
