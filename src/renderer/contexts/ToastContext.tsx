import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { X } from 'lucide-react'
import { cn } from '@renderer/lib/utils'

/**
 * Minimal, dependency-free toast system.
 *
 * Toasts render fixed to the top-right, stack vertically, auto-dismiss after
 * ~5s, and can be dismissed manually. Use via the `useToast()` hook:
 *
 *   const toast = useToast()
 *   toast.error('Something went wrong')
 *   toast.success('Saved')
 */

type ToastVariant = 'error' | 'success'

interface ToastItem {
  id: string
  message: string
  variant: ToastVariant
}

interface ToastApi {
  error: (message: string) => void
  success: (message: string) => void
}

const AUTO_DISMISS_MS = 5000

const ToastContext = createContext<ToastApi | null>(null)

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([])

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id))
  }, [])

  const push = useCallback((message: string, variant: ToastVariant) => {
    const id =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random()}`
    setToasts((prev) => [...prev, { id, message, variant }])
  }, [])

  const api = useMemo<ToastApi>(
    () => ({
      error: (message: string) => push(message, 'error'),
      success: (message: string) => push(message, 'success'),
    }),
    [push]
  )

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div
        className="fixed top-4 right-4 z-50 flex flex-col gap-2 pointer-events-none"
        aria-live="polite"
        aria-relevant="additions"
      >
        {toasts.map((t) => (
          <ToastCard key={t.id} toast={t} onDismiss={dismiss} />
        ))}
      </div>
    </ToastContext.Provider>
  )
}

function ToastCard({ toast, onDismiss }: { toast: ToastItem; onDismiss: (id: string) => void }) {
  useEffect(() => {
    const timer = setTimeout(() => onDismiss(toast.id), AUTO_DISMISS_MS)
    return () => clearTimeout(timer)
  }, [toast.id, onDismiss])

  const isError = toast.variant === 'error'

  return (
    <div
      role="alert"
      className={cn(
        'pointer-events-auto flex items-start gap-2.5 rounded-lg border px-3 py-2.5 text-xs shadow-lg',
        'min-w-[240px] max-w-sm bg-[var(--bg-secondary)]',
        isError
          ? 'border-red-500/40 text-red-400'
          : 'border-[var(--border)] text-[var(--text-primary)]'
      )}
    >
      <span className="flex-1 leading-snug break-words">{toast.message}</span>
      <button
        type="button"
        onClick={() => onDismiss(toast.id)}
        className="p-0.5 -m-0.5 rounded text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors flex-shrink-0"
        aria-label="Dismiss notification"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error('useToast must be used within a ToastProvider')
  return ctx
}
