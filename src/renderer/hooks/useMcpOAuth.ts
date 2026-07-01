import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'
import { api } from '@renderer/lib/ipc'

const statusKey = (serverId: string) => ['mcpOAuthStatus', serverId] as const

export function useMcpStatus(serverId: string | undefined, isGlobal: boolean) {
  return useQuery({
    queryKey: statusKey(serverId ?? ''),
    queryFn: () => api.mcpOAuth.getStatus(serverId!, isGlobal),
    enabled: !!serverId,
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
