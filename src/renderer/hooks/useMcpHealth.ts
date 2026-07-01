import { useQuery } from '@tanstack/react-query'
import { api } from '@renderer/lib/ipc'
import type { McpServerEntry } from '@shared/types'

export function useMcpHealth(serverId: string, serverConfig: McpServerEntry) {
  return useQuery({
    queryKey: ['mcpHealth', serverId],
    queryFn: () => api.globalMcps.checkHealth(serverConfig),
    staleTime: 30_000,
    gcTime: 60_000,
    retry: 0,
    // Re-check when the user returns to the app (e.g. after completing OAuth in a
    // popup tab), even within staleTime — the app disables focus refetch globally.
    refetchOnWindowFocus: 'always',
  })
}
