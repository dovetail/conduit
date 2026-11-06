import { useEffect } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@renderer/lib/ipc'
import type { McpAccessToken, McpAccessTokenInput } from '@shared/types'

const TOKENS_KEY = ['mcpTokens'] as const

export function useMcpTokens() {
  return useQuery<McpAccessToken[]>({
    queryKey: TOKENS_KEY,
    queryFn: () => api.mcpTokens.list(),
  })
}

export function useCreateMcpToken() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: McpAccessTokenInput) => api.mcpTokens.create(input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: TOKENS_KEY }),
  })
}

export function useRevokeMcpToken() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.mcpTokens.revoke(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: TOKENS_KEY }),
  })
}

/** Refresh cached agents/triggers when they change outside this tab (e.g. via MCP). */
export function useEntityChangeEvents() {
  const queryClient = useQueryClient()
  useEffect(() => {
    return api.onEntityChange((payload) => {
      if (payload.entity === 'agent') {
        queryClient.invalidateQueries({ queryKey: ['agents'] })
      } else if (payload.entity === 'trigger' && payload.agentId) {
        queryClient.invalidateQueries({ queryKey: ['triggers', payload.agentId] })
      }
    })
  }, [queryClient])
}
