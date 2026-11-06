/**
 * @vitest-environment jsdom
 */
import React from 'react'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, cleanup, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { CreatedMcpAccessToken } from '@shared/types'

const {
  getStatus,
  setCredential,
  getTimeouts,
  setTimeout_,
  sweep,
  storageUsage,
  listTokens,
  createToken,
  revokeToken,
} = vi.hoisted(() => ({
  getStatus: vi.fn(),
  setCredential: vi.fn(),
  getTimeouts: vi.fn(),
  setTimeout_: vi.fn(),
  sweep: vi.fn(),
  storageUsage: vi.fn(),
  listTokens: vi.fn(),
  createToken: vi.fn(),
  revokeToken: vi.fn(),
}))

vi.mock('@renderer/lib/ipc', () => ({
  api: {
    agentCredentials: { getStatus, set: setCredential },
    runnerSettings: { getTimeouts, setTimeout: setTimeout_ },
    maintenance: { sweep, storageUsage },
    mcpTokens: { list: listTokens, create: createToken, revoke: revokeToken },
  },
}))

import { SettingsManager } from '@renderer/components/settings/SettingsManager'

function renderSettings() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <SettingsManager />
    </QueryClientProvider>
  )
}

describe('SettingsManager', () => {
  beforeEach(() => {
    cleanup()
    vi.clearAllMocks()
    getStatus.mockResolvedValue({})
    setCredential.mockResolvedValue(undefined)
    getTimeouts.mockResolvedValue({})
    setTimeout_.mockResolvedValue(undefined)
    sweep.mockResolvedValue({})
    storageUsage.mockResolvedValue({ totalBytes: 0, reclaimableBytes: 0 })
    listTokens.mockResolvedValue([])
    createToken.mockResolvedValue({
      token: { id: 'tok-1', name: 'placeholder', scope: 'read', tokenPrefix: 'cdt_abcd', createdAt: Date.now() },
      plaintext: 'cdt_abcdefghijklmnopqrstuvwxyz',
    } satisfies CreatedMcpAccessToken)
    revokeToken.mockResolvedValue(undefined)
  })

  it('keeps the scroll container full-width so the scrollbar sits at the window edge, not the content edge', async () => {
    const { container } = renderSettings()

    await waitFor(() => {
      expect(getStatus).toHaveBeenCalled()
      expect(getTimeouts).toHaveBeenCalled()
      expect(listTokens).toHaveBeenCalled()
      expect(storageUsage).toHaveBeenCalled()
    })

    const scrollEls = container.querySelectorAll('.overflow-y-auto')
    expect(scrollEls.length).toBe(1)
    const scrollEl = scrollEls[0] as HTMLElement

    // The scroll container itself must never be width-capped — a max-w-* class
    // here is exactly what pulls the scrollbar away from the window's edge.
    expect(scrollEl.className).not.toMatch(/\bmax-w-/)

    // The content-width constraint should still exist, just on an inner wrapper.
    const maxWEl = container.querySelector('.max-w-2xl')
    expect(maxWEl).not.toBeNull()
    expect(scrollEl.contains(maxWEl)).toBe(true)
  })
})
