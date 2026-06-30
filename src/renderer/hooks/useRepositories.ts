import { useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '@renderer/lib/ipc'
import type { RepositoryInput, RepoTestConnectionInput } from '@shared/types'

const REPOS_KEY = ['repositories'] as const

export function useRepositories() {
  return useQuery({
    queryKey: REPOS_KEY,
    queryFn: () => api.repos.list(),
  })
}

export function useRepository(id: string | undefined) {
  return useQuery({
    queryKey: [...REPOS_KEY, id],
    queryFn: () => api.repos.get(id!),
    enabled: !!id,
  })
}

export function useCreateRepository() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (data: RepositoryInput) =>
      api.repos.create(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: REPOS_KEY })
    },
  })
}

export function useUpdateRepository() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({
      id,
      data,
    }: {
      id: string
      data: Partial<RepositoryInput>
    }) => api.repos.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: REPOS_KEY })
    },
  })
}

export function useDeleteRepository() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.repos.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: REPOS_KEY })
    },
  })
}

export function useTriggerRepoSync() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.repos.triggerSync(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: REPOS_KEY })
    },
  })
}

export function useTestRepoConnection() {
  return useMutation({
    mutationFn: (data: RepoTestConnectionInput) =>
      api.repos.testConnection(data),
  })
}

/** Subscribe to real-time repo sync status events and invalidate the cache. */
export function useRepoSyncEvents() {
  const queryClient = useQueryClient()
  useEffect(() => {
    const unsub = api.onRepoSyncStatus(() => {
      queryClient.invalidateQueries({ queryKey: REPOS_KEY })
    })
    return unsub
  }, [queryClient])
}
