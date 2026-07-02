import { create } from 'zustand'

type Theme = 'dark' | 'light' | 'system'

interface UIState {
  selectedAgentId: string | null
  activeRunId: string | null
  /** The run currently shown in the runs tab, reflected in the URL for deep-linking. */
  viewedRunId: string | null
  theme: Theme
  sidebarWidth: number
  showGlobalMcpManager: boolean
  showPublishTargets: boolean
  showRepositories: boolean
  showSettings: boolean
  // Actions
  selectAgent: (id: string | null) => void
  setActiveRun: (id: string | null) => void
  setViewedRun: (id: string | null) => void
  setTheme: (theme: Theme) => void
  setSidebarWidth: (w: number) => void
  setShowGlobalMcpManager: (show: boolean) => void
  setShowPublishTargets: (show: boolean) => void
  setShowRepositories: (show: boolean) => void
  setShowSettings: (show: boolean) => void
}

function applyTheme(theme: Theme) {
  const root = document.documentElement
  if (theme === 'dark') {
    root.classList.add('dark')
  } else if (theme === 'light') {
    root.classList.remove('dark')
  } else {
    // system
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
    if (prefersDark) {
      root.classList.add('dark')
    } else {
      root.classList.remove('dark')
    }
  }
}

function getStoredTheme(): Theme {
  try {
    const stored = localStorage.getItem('conduit-theme')
    if (stored === 'dark' || stored === 'light' || stored === 'system') {
      return stored
    }
  } catch {
    // ignore
  }
  return 'dark'
}

function getStoredSidebarWidth(): number {
  try {
    const stored = localStorage.getItem('conduit-sidebar-width')
    if (stored) {
      const w = parseInt(stored, 10)
      if (!isNaN(w) && w >= 180 && w <= 480) return w
    }
  } catch {
    // ignore
  }
  return 260
}

const initialTheme = getStoredTheme()
// Apply theme immediately on module load
if (typeof document !== 'undefined') {
  applyTheme(initialTheme)
}

// ── URL routing helpers ───────────────────────────────────────────────────────

interface UrlState {
  agentId: string | null
  runId: string | null
  globalMcps: boolean
  publishTargets: boolean
  repositories: boolean
  settings: boolean
}

function readUrlState(): UrlState {
  const empty: UrlState = { agentId: null, runId: null, globalMcps: false, publishTargets: false, repositories: false, settings: false }
  if (typeof window === 'undefined') return empty
  const path = window.location.pathname
  const globalMcps = path === '/global-mcps'
  const publishTargets = path === '/publish-targets'
  const repositories = path === '/repositories'
  const settings = path === '/settings'
  // /agents/:agentId/runs/:runId (deep link to a run) or /agents/:agentId
  const runMatch = path.match(/^\/agents\/([^/]+)\/runs\/([^/]+)$/)
  if (runMatch) return { ...empty, agentId: runMatch[1], runId: runMatch[2] }
  const agentMatch = path.match(/^\/agents\/([^/]+)$/)
  return { ...empty, agentId: agentMatch ? agentMatch[1] : null, globalMcps, publishTargets, repositories, settings }
}

function pushUrl(path: string) {
  if (typeof window !== 'undefined' && window.location.pathname !== path) {
    window.history.pushState(null, '', path)
  }
}

const initialUrl = readUrlState()

export const useUIStore = create<UIState>((set, get) => ({
  selectedAgentId: initialUrl.agentId,
  activeRunId: null,
  viewedRunId: initialUrl.runId,
  theme: initialTheme,
  sidebarWidth: getStoredSidebarWidth(),
  showGlobalMcpManager: initialUrl.globalMcps,
  showPublishTargets: initialUrl.publishTargets,
  showRepositories: initialUrl.repositories,
  showSettings: initialUrl.settings,

  selectAgent: (id) => {
    pushUrl(id ? `/agents/${id}` : '/')
    set({ selectedAgentId: id, viewedRunId: null, showGlobalMcpManager: false, showPublishTargets: false, showRepositories: false, showSettings: false })
  },

  setViewedRun: (id) => {
    const agentId = get().selectedAgentId
    if (agentId) pushUrl(id ? `/agents/${agentId}/runs/${id}` : `/agents/${agentId}`)
    set({ viewedRunId: id })
  },

  // A run becoming active (e.g. just started) is also the run we navigate to.
  setActiveRun: (id) => {
    if (id) {
      const agentId = get().selectedAgentId
      if (agentId) pushUrl(`/agents/${agentId}/runs/${id}`)
      set({ activeRunId: id, viewedRunId: id })
    } else {
      set({ activeRunId: null })
    }
  },

  setShowGlobalMcpManager: (show) => {
    pushUrl(show ? '/global-mcps' : '/')
    set({ showGlobalMcpManager: show, showPublishTargets: false, showRepositories: false, showSettings: false })
  },

  setShowPublishTargets: (show) => {
    pushUrl(show ? '/publish-targets' : '/')
    set({ showPublishTargets: show, showGlobalMcpManager: false, showRepositories: false, showSettings: false })
  },

  setShowRepositories: (show) => {
    pushUrl(show ? '/repositories' : '/')
    set({ showRepositories: show, showGlobalMcpManager: false, showPublishTargets: false, showSettings: false })
  },

  setShowSettings: (show) => {
    pushUrl(show ? '/settings' : '/')
    set({ showSettings: show, showGlobalMcpManager: false, showPublishTargets: false, showRepositories: false })
  },

  setTheme: (theme) => {
    try {
      localStorage.setItem('conduit-theme', theme)
    } catch {
      // ignore
    }
    applyTheme(theme)
    set({ theme })
  },

  setSidebarWidth: (w) => {
    try {
      localStorage.setItem('conduit-sidebar-width', String(w))
    } catch {
      // ignore
    }
    set({ sidebarWidth: w })
  },
}))

// Keep store state in sync with browser back/forward navigation. popstate fires
// after the URL has already changed, so we read it and update state without
// pushing a new history entry.
if (typeof window !== 'undefined') {
  window.addEventListener('popstate', () => {
    const s = readUrlState()
    useUIStore.setState({
      selectedAgentId: s.agentId,
      viewedRunId: s.runId,
      showGlobalMcpManager: s.globalMcps,
      showPublishTargets: s.publishTargets,
      showRepositories: s.repositories,
      showSettings: s.settings,
    })
  })
}
