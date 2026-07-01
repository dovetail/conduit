import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '@renderer/lib/ipc'
import type { PublishTarget, PublishTargetType, PublishConfig } from '@shared/types'

const PUBLISH_TARGETS_KEY = ['publishTargets'] as const

export function usePublishTargets() {
  return useQuery({
    queryKey: PUBLISH_TARGETS_KEY,
    queryFn: () => api.publishTargets.list(),
  })
}

export function usePublishTarget(id: string) {
  return useQuery({
    queryKey: [...PUBLISH_TARGETS_KEY, id],
    queryFn: () => api.publishTargets.get(id),
    enabled: !!id,
  })
}

export function useCreatePublishTarget() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (data: Omit<PublishTarget, 'id' | 'createdAt' | 'updatedAt'>) =>
      api.publishTargets.create(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: PUBLISH_TARGETS_KEY })
    },
  })
}

export function useUpdatePublishTarget() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({
      id,
      data,
    }: {
      id: string
      data: Partial<Omit<PublishTarget, 'id' | 'createdAt' | 'updatedAt'>>
    }) => api.publishTargets.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: PUBLISH_TARGETS_KEY })
    },
  })
}

export function useDeletePublishTarget() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.publishTargets.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: PUBLISH_TARGETS_KEY })
    },
  })
}

export function useTestPublishTarget() {
  return useMutation({
    mutationFn: ({ type, config }: { type: PublishTargetType; config: PublishConfig }) =>
      api.publishTargets.test(type, config),
  })
}

/**
 * Connection/health check for a publish target (mirrors useMcpHealth). Keyed by
 * a caller-supplied id so the list and detail views can each cache their own.
 */
export function usePublishTargetHealth(id: string, type: PublishTargetType, config: PublishConfig, enabled = true) {
  return useQuery({
    queryKey: ['publishTargetHealth', id],
    queryFn: () => api.publishTargets.checkHealth(type, config),
    staleTime: 30_000,
    gcTime: 60_000,
    retry: 0,
    enabled,
  })
}
