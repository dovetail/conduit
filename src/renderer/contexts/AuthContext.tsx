import React, { createContext, useContext, useState, useEffect } from 'react'
import type { User, Group, AuthState } from '@shared/types'
import { reporter } from '@renderer/observability'

const AuthContext = createContext<AuthState & { logout: () => Promise<void> }>({
  user: null,
  groups: [],
  isAuthenticated: false,
  isDevMode: false,
  logout: async () => {},
})

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<AuthState & { isLoading: boolean }>({
    user: null,
    groups: [],
    isAuthenticated: false,
    isDevMode: false,
    isLoading: true,
  })

  useEffect(() => {
    fetch('/auth/me')
      .then((res) => {
        if (!res.ok) throw new Error('Not authenticated')
        return res.json()
      })
      .then((data: { user: User; groups: Group[]; isDevMode: boolean }) => {
        setState({
          user: data.user,
          groups: data.groups,
          isAuthenticated: true,
          isDevMode: data.isDevMode,
          isLoading: false,
        })
      })
      .catch(() => {
        setState((prev) => ({ ...prev, isLoading: false }))
      })
  }, [])

  // Attach the authenticated user to the error reporter (and clear it on logout)
  // so captured events are attributed to whoever hit them.
  useEffect(() => {
    if (state.user) {
      reporter.setUser({ id: state.user.id, email: state.user.email })
    } else {
      reporter.setUser(null)
    }
  }, [state.user])

  const logout = async () => {
    await fetch('/auth/logout', { method: 'POST' })
    window.location.reload()
  }

  if (state.isLoading) {
    return (
      <div
        className="flex items-center justify-center h-screen w-screen"
        style={{ background: 'var(--bg-primary)', color: 'var(--text-secondary)' }}
      >
        <span className="text-sm">Loading...</span>
      </div>
    )
  }

  return (
    <AuthContext.Provider value={{ ...state, logout }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  return useContext(AuthContext)
}
