import React, { useRef, useEffect } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { api } from '@renderer/lib/ipc'
import { useUIStore } from '@renderer/store/ui'
import type { LogEntry } from '@shared/types'

import '@xterm/xterm/css/xterm.css'

const darkTheme = {
  background: '#0d0d0d',
  foreground: '#e5e5e5',
  cursor: '#818cf8',
  cursorAccent: '#0d0d0d',
  selectionBackground: '#6366f130',
  black: '#1a1a1a',
  red: '#f87171',
  green: '#4ade80',
  yellow: '#facc15',
  blue: '#818cf8',
  magenta: '#c084fc',
  cyan: '#22d3ee',
  white: '#e5e5e5',
  brightBlack: '#404040',
  brightRed: '#fca5a5',
  brightGreen: '#86efac',
  brightYellow: '#fde047',
  brightBlue: '#a5b4fc',
  brightMagenta: '#d8b4fe',
  brightCyan: '#67e8f9',
  brightWhite: '#ffffff',
}

const lightTheme = {
  background: '#ffffff',
  foreground: '#1a1a1a',
  cursor: '#6366f1',
  cursorAccent: '#ffffff',
  selectionBackground: '#6366f120',
  black: '#1a1a1a',
  red: '#dc2626',
  green: '#16a34a',
  yellow: '#ca8a04',
  blue: '#6366f1',
  magenta: '#9333ea',
  cyan: '#0891b2',
  white: '#e5e5e5',
  brightBlack: '#737373',
  brightRed: '#ef4444',
  brightGreen: '#22c55e',
  brightYellow: '#eab308',
  brightBlue: '#818cf8',
  brightMagenta: '#a855f7',
  brightCyan: '#06b6d4',
  brightWhite: '#ffffff',
}

interface TerminalPaneProps {
  /** Active run ID — subscribes to live output */
  runId?: string | null
  /** Pre-fetched log entries for replay of a past run */
  logEntries?: LogEntry[]
  height?: number | string
}

export function TerminalPane({ runId, logEntries, height }: TerminalPaneProps) {
  const { theme } = useUIStore()
  const isDark =
    theme === 'dark' ||
    (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)

  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const currentModeRef = useRef<'live' | 'replay' | null>(null)

  // Mount terminal once
  useEffect(() => {
    if (!containerRef.current) return

    const term = new Terminal({
      theme: isDark ? darkTheme : lightTheme,
      fontFamily: 'JetBrains Mono, Fira Code, Cascadia Code, monospace',
      fontSize: 13,
      lineHeight: 1.5,
      cursorBlink: true,
      cursorStyle: 'bar',
      scrollback: 10000,
      convertEol: true,
      allowTransparency: true,
      disableStdin: true,
    })

    const fit = new FitAddon()
    const links = new WebLinksAddon((_, url) => {
      api.shell.openExternal(url).catch(console.error)
    })

    term.loadAddon(fit)
    term.loadAddon(links)
    term.open(containerRef.current)
    fit.fit()

    termRef.current = term
    fitRef.current = fit

    const ro = new ResizeObserver(() => fit.fit())
    ro.observe(containerRef.current)

    return () => {
      ro.disconnect()
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
    // Only run on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Update theme when it changes
  useEffect(() => {
    if (termRef.current) {
      termRef.current.options.theme = isDark ? darkTheme : lightTheme
    }
  }, [isDark])

  // Live mode: subscribe to output for the current runId
  useEffect(() => {
    if (!runId || !termRef.current) return

    // Clear the terminal whenever the live subscription (re)binds to a run.
    termRef.current.clear()
    currentModeRef.current = 'live'

    const unsub = api.onOutput((payload) => {
      if (payload.runId !== runId) return
      for (const chunk of payload.chunks) {
        termRef.current?.write(chunk)
      }
    })

    return () => unsub()
  }, [runId])

  // Replay mode: write log entries
  useEffect(() => {
    if (!logEntries || !termRef.current) return
    termRef.current.clear()
    currentModeRef.current = 'replay'
    for (const entry of logEntries) {
      termRef.current.write(entry.chunk)
    }
  }, [logEntries])

  return (
    <div
      ref={containerRef}
      style={{ height: height ?? '100%', minHeight: 0 }}
      className="w-full bg-[#0d0d0d] overflow-hidden"
    />
  )
}
