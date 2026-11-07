import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Loader2, ChevronRight, ChevronsDownUp, ChevronsUpDown, Download } from 'lucide-react'
import { cn, formatDuration } from '@renderer/lib/utils'
import { useRunEvents } from '@renderer/hooks/useRuns'
import { describeToolUse, runLogToText, summarizeEvent } from '@shared/runEvents'
import type { RunEvent } from '@shared/types'
import { TerminalPane } from '@renderer/components/layout/TerminalPane'

interface RunLogViewProps {
  runId: string
  /** True while the run is still executing — enables live streaming + footer. */
  live?: boolean
  /** Run start time (epoch ms) — drives the live elapsed timer. */
  startedAt?: number
}

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
}

/** Braille spinner; falls back to a static frame when reduced motion is set. */
function Spinner({ className }: { className?: string }) {
  const [i, setI] = useState(0)
  useEffect(() => {
    if (prefersReducedMotion()) return
    const id = setInterval(() => setI((x) => (x + 1) % SPINNER_FRAMES.length), 90)
    return () => clearInterval(id)
  }, [])
  return <span className={cn('inline-block w-[1ch]', className)}>{SPINNER_FRAMES[i]}</span>
}

function useElapsed(startedAt: number | undefined, active: boolean): number {
  const [ms, setMs] = useState(0)
  useEffect(() => {
    if (!active || !startedAt) return
    setMs(Date.now() - startedAt)
    const id = setInterval(() => setMs(Date.now() - startedAt), 1000)
    return () => clearInterval(id)
  }, [active, startedAt])
  return ms
}

function extractText(content: unknown): string {
  return typeof content === 'string' ? content : ''
}

/** One collapsed-by-default tool call. Expands to show its (monospace) output. */
function ToolRow({
  event,
  result,
  running,
  expanded,
  onToggle,
}: {
  event: RunEvent
  result: RunEvent | undefined
  running: boolean
  expanded: boolean
  onToggle: () => void
}) {
  const { title, subtitle } = describeToolUse(event.toolName, event.toolInput)
  const output = extractText(result?.content).trimEnd()
  const isError = result?.isError
  const hasOutput = output.length > 0

  return (
    <div className="my-0.5">
      <button
        type="button"
        onClick={onToggle}
        className={cn(
          'group flex w-full items-center gap-2 rounded px-1.5 py-1 text-left',
          'hover:bg-[var(--bg-secondary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]'
        )}
      >
        <ChevronRight
          className={cn(
            'h-3 w-3 flex-shrink-0 text-[var(--text-secondary)] transition-transform',
            expanded && 'rotate-90',
            !hasOutput && 'opacity-30'
          )}
        />
        <span className="flex-shrink-0 text-[var(--accent)]">❯</span>
        <span className="flex-shrink-0 font-semibold text-[var(--text-primary)]">{title}</span>
        {subtitle && (
          <span className="min-w-0 truncate text-[var(--text-secondary)]">{subtitle}</span>
        )}
        {running && (
          <span className="ml-auto flex flex-shrink-0 items-center gap-1.5 text-xs text-green-400">
            <Spinner /> running
          </span>
        )}
      </button>
      {expanded && hasOutput && (
        <div className="ml-[27px] mt-0.5 mb-2 max-h-64 overflow-auto rounded-r border-l-2 border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2">
          <pre
            className={cn(
              'whitespace-pre font-mono text-xs leading-relaxed',
              isError ? 'text-red-400' : 'text-[var(--text-secondary)]'
            )}
          >
            {output}
          </pre>
        </div>
      )}
    </div>
  )
}

export function RunLogView({ runId, live = false, startedAt }: RunLogViewProps) {
  const { events, format, terminalEntries, isLoading, error } = useRunEvents(runId, { live })
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const scrollRef = useRef<HTMLDivElement>(null)
  const stickRef = useRef(true)

  // Correlate tool results to their calls, and find the tool still running.
  const { resultByToolUse, runningKey } = useMemo(() => {
    const map = new Map<string, RunEvent>()
    for (const e of events) if (e.kind === 'tool_result' && e.toolUseId) map.set(e.toolUseId, e)
    let running: string | null = null
    if (live) {
      for (let i = events.length - 1; i >= 0; i--) {
        const e = events[i]
        if (e.kind === 'result') break
        if (e.kind === 'tool_use') {
          const key = e.toolUseId ?? `idx-${i}`
          if (!(e.toolUseId && map.has(e.toolUseId))) running = key
          break
        }
      }
    }
    return { resultByToolUse: map, runningKey: running }
  }, [events, live])

  const toolKeys = useMemo(
    () =>
      events
        .map((e, i) => (e.kind === 'tool_use' ? e.toolUseId ?? `idx-${i}` : null))
        .filter((k): k is string => k !== null),
    [events]
  )
  const allExpanded = toolKeys.length > 0 && toolKeys.every((k) => expanded.has(k))

  const currentActivity = useMemo(() => {
    for (let i = events.length - 1; i >= 0; i--) {
      const s = summarizeEvent(events[i])
      if (s) return s
    }
    return ''
  }, [events])

  const elapsedMs = useElapsed(startedAt, live)

  // Auto-scroll to the newest output while the user is pinned to the bottom.
  useEffect(() => {
    if (!stickRef.current) return
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [events.length])

  const onScroll = () => {
    const el = scrollRef.current
    if (!el) return
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
  }

  const toggle = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  const toggleAll = () =>
    setExpanded(allExpanded ? new Set() : new Set(toolKeys))

  // Download the run's log as a fully-expanded plain-text transcript. Client-side
  // only — the events are already loaded, so no server round-trip is needed.
  const downloadLog = () => {
    const blob = new Blob([runLogToText(events)], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `conduit-run-${runId}.log`
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
  }

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center text-[var(--text-secondary)]">
        <Loader2 className="h-4 w-4 animate-spin" />
      </div>
    )
  }
  if (error) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-red-400">
        Failed to load run log
      </div>
    )
  }

  // Old runs stored ANSI text — render them in the terminal, unchanged.
  if (format === 'terminal') {
    return <TerminalPane logEntries={terminalEntries} />
  }

  return (
    <div className="flex h-full flex-col bg-[var(--bg-primary)]">
      <div className="flex flex-shrink-0 items-center gap-2 border-b border-[var(--border)] px-3 py-1.5">
        <span className="text-xs text-[var(--text-secondary)]">
          {toolKeys.length > 0 ? `${toolKeys.length} tool call${toolKeys.length === 1 ? '' : 's'}` : 'Log'}
        </span>
        <div className="ml-auto flex items-center gap-2">
          {events.length > 0 && (
            <button
              type="button"
              onClick={downloadLog}
              title="Download this run's log as a text file"
              className="flex items-center gap-1.5 rounded border border-[var(--border)] px-2 py-1 text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
            >
              <Download className="h-3 w-3" />
              Download log
            </button>
          )}
          {toolKeys.length > 0 && (
            <button
              type="button"
              onClick={toggleAll}
              className="flex items-center gap-1.5 rounded border border-[var(--border)] px-2 py-1 text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
            >
              {allExpanded ? <ChevronsDownUp className="h-3 w-3" /> : <ChevronsUpDown className="h-3 w-3" />}
              {allExpanded ? 'Collapse all' : 'Expand all'}
            </button>
          )}
        </div>
      </div>

      <div ref={scrollRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        <div className="font-mono text-[13px]">
          {events.length === 0 && (
            <div className="flex items-center gap-2 text-[var(--text-secondary)]">
              {live ? (
                <>
                  <Spinner className="text-green-400" />
                  <span>Starting run — waiting for the agent’s first output…</span>
                </>
              ) : (
                'No output.'
              )}
            </div>
          )}
          {events.map((e, i) => {
            if (e.kind === 'assistant') {
              return (
                <div key={i} className="flex gap-2 py-1">
                  <span className="flex-shrink-0 text-[var(--accent)]">●</span>
                  <span className="whitespace-pre-wrap text-[var(--text-primary)]">{e.text}</span>
                </div>
              )
            }
            if (e.kind === 'tool_use') {
              const key = e.toolUseId ?? `idx-${i}`
              return (
                <ToolRow
                  key={i}
                  event={e}
                  result={e.toolUseId ? resultByToolUse.get(e.toolUseId) : undefined}
                  running={runningKey === key}
                  expanded={expanded.has(key)}
                  onToggle={() => toggle(key)}
                />
              )
            }
            if (e.kind === 'raw') {
              if (!e.text?.trim()) return null
              return (
                <div
                  key={i}
                  className={cn(
                    'whitespace-pre-wrap px-1.5 py-0.5 text-xs',
                    e.stream === 'stderr' ? 'text-red-400' : 'italic text-[var(--text-secondary)]'
                  )}
                >
                  {e.text.trimEnd()}
                </div>
              )
            }
            if (e.kind === 'result') {
              return (
                <div
                  key={i}
                  className={cn(
                    'mt-2.5 flex items-center gap-2 border-t border-dashed border-[var(--border)] pt-2.5',
                    e.isError ? 'text-red-400' : 'text-green-500'
                  )}
                >
                  {e.isError ? '✗ Failed' : '✓ Completed'}
                </div>
              )
            }
            if (e.kind === 'metering') {
              if (!e.text?.trim()) return null
              return (
                <div key={i} className="px-1.5 py-0.5 font-mono text-xs tabular-nums text-[var(--text-secondary)]">
                  {e.text.replace(/^\[Conduit metering\]\s*/, '')}
                </div>
              )
            }
            return null
          })}
        </div>
      </div>

      {live && (
        <div className="flex flex-shrink-0 items-center gap-2.5 border-t border-[var(--border)] bg-[var(--bg-primary)] px-3 py-2 font-mono text-[13px]">
          <Spinner className="text-green-400" />
          <span className="font-semibold text-green-400">Working</span>
          <span className="min-w-0 flex-1 truncate text-[var(--text-secondary)]">{currentActivity}</span>
          <span className="flex-shrink-0 tabular-nums text-[var(--text-secondary)]">
            {formatDuration(elapsedMs)}
          </span>
        </div>
      )}
    </div>
  )
}
