import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'
import { api } from '@renderer/lib/ipc'
import type { McpServerEntry } from '@shared/types'

const statusKey = (serverId: string) => ['mcpOAuthStatus', serverId] as const

export function useMcpStatus(serverId: string | undefined, isGlobal: boolean) {
  return useQuery({
    queryKey: statusKey(serverId ?? ''),
    queryFn: () => api.mcpOAuth.getStatus(serverId!, isGlobal),
    enabled: !!serverId,
    // Refresh when the user returns from the OAuth popup tab (focus refetch is
    // disabled app-wide, so opt in here).
    refetchOnWindowFocus: 'always',
  })
}

export function useStartMcpAuth() {
  return useMutation({
    mutationFn: async ({ serverId, isGlobal }: { serverId: string; isGlobal: boolean }) => {
      const { authUrl } = await api.mcpOAuth.startAuth(serverId, isGlobal)
      window.open(authUrl, '_blank', 'noopener,noreferrer')
    },
  })
}

export function useRevokeMcpToken() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ serverId, isGlobal }: { serverId: string; isGlobal: boolean }) =>
      api.mcpOAuth.revoke(serverId, isGlobal),
    onSuccess: (_d, { serverId }) => {
      queryClient.invalidateQueries({ queryKey: statusKey(serverId) })
    },
  })
}

export function useMcpOAuthProbe(entry: McpServerEntry | undefined) {
  const isUrl = !!entry && (entry.type === 'url' || !!entry.url) && !!entry.url
  return useQuery({
    queryKey: ['mcpOAuthProbe', entry?.url ?? ''] as const,
    queryFn: () => api.mcpOAuth.probe(entry!),
    enabled: isUrl,
    staleTime: 5 * 60 * 1000,
  })
}

/** Invalidate status when the server broadcasts completion (matched by serverUrl). */
export function useMcpOAuthListener(
  onComplete?: (result: { serverUrl: string; success: boolean; error?: string }) => void
) {
  const queryClient = useQueryClient()
  useEffect(() => {
    return api.onMcpOAuthComplete((payload) => {
      queryClient.invalidateQueries({ queryKey: ['mcpOAuthStatus'] })
      onComplete?.(payload)
    })
  }, [queryClient, onComplete])
}
