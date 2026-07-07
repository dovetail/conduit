import React from 'react'
import ReactDOM from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { AuthProvider } from './contexts/AuthContext'
import { reporter, initObservability } from './observability'
import App from './App'
import './styles/globals.css'

interface RuntimeConfig {
  sentryDsn: string | null
  sentryEnvironment: string | null
  sentryRelease: string | null
  errorReporters: string[]
}

async function loadRuntimeConfig(): Promise<RuntimeConfig> {
  try {
    const res = await fetch('/api/runtime-config', { credentials: 'same-origin' })
    if (!res.ok)
      return { sentryDsn: null, sentryEnvironment: null, sentryRelease: null, errorReporters: [] }
    return (await res.json()) as RuntimeConfig
  } catch {
    return { sentryDsn: null, sentryEnvironment: null, sentryRelease: null, errorReporters: [] }
  }
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 0,
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
})

async function bootstrapConduit(): Promise<void> {
  if (typeof window === 'undefined') return
  if (window.conduit) return // Already set by Electron preload

  const { createWsConduitClient } = await import('./lib/ws-client')
  // Match the page's protocol — Firefox throws "The operation is insecure"
  // and Chrome throws "Mixed Content" when a secure origin opens a ws://
  // connection. When served over HTTPS we must use wss://.
  const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  const wsUrl = `${wsProtocol}//${window.location.host}/ws`
  window.conduit = createWsConduitClient(wsUrl)

  await Promise.resolve()
}

class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean; error: Error | null }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('Conduit renderer error:', error, info)
    reporter.captureException(error, { extra: { componentStack: info.componentStack } })
  }

  render() {
    if (this.state.hasError) {
      return (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            height: '100vh',
            background: '#0d0d0d',
            color: '#fafafa',
            fontFamily: 'monospace',
            padding: '2rem',
            textAlign: 'center',
          }}
        >
          <h2 style={{ color: '#f87171', marginBottom: '1rem' }}>Something went wrong</h2>
          <pre
            style={{
              background: '#171717',
              padding: '1rem',
              borderRadius: '6px',
              maxWidth: '600px',
              overflow: 'auto',
              fontSize: '0.875rem',
              color: '#a3a3a3',
            }}
          >
            {this.state.error?.message}
          </pre>
          <button
            style={{
              marginTop: '1.5rem',
              padding: '0.5rem 1.25rem',
              background: '#818cf8',
              color: '#fff',
              border: 'none',
              borderRadius: '6px',
              cursor: 'pointer',
              fontSize: '0.875rem',
            }}
            onClick={() => this.setState({ hasError: false, error: null })}
          >
            Try again
          </button>
        </div>
      )
    }

    return this.props.children
  }
}

;(async () => {
  const config = await loadRuntimeConfig()
  initObservability({
    errorReporters: config.errorReporters,
    sentryDsn: config.sentryDsn,
    sentryEnvironment: config.sentryEnvironment,
    sentryRelease: config.sentryRelease,
  })

  await bootstrapConduit()

  const root = document.getElementById('root')
  if (!root) throw new Error('Root element not found')

  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      <ErrorBoundary>
        <QueryClientProvider client={queryClient}>
          <AuthProvider>
            <App />
          </AuthProvider>
        </QueryClientProvider>
      </ErrorBoundary>
    </React.StrictMode>
  )
})()
