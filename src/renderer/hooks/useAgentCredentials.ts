import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@renderer/lib/ipc'
import type { AgentCredentialStatus, RunnerType } from '@shared/types'

const statusKey = ['agentCredentials', 'status'] as const

export function useAgentCredentialStatus() {
  return useQuery<AgentCredentialStatus>({
    queryKey: statusKey,
    queryFn: () => api.agentCredentials.getStatus(),
  })
}

export function useSetAgentCredential() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ runner, value }: { runner: RunnerType; value: string }) =>
      api.agentCredentials.set(runner, value),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: statusKey })
    },
  })
}
