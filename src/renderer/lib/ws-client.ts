import type {
  ConduitAPI,
  RunOutputPayload,
  RunStatusChangePayload,
  RepoSyncStatusPayload,
  AgentConfig,
  ExecutionRun,
  LogEntry,
  GlobalMcpServer,
  PublishTarget,
  Repository,
  RepositoryInput,
  RepoTestConnectionInput,
  Trigger,
  TriggerFiredPayload,
  McpOAuthStatus,
  RunnerType,
  SlackPublishConfig,
  Share,
  ShareableEntityType,
  User,
  Group,
} from '@shared/types'

/**
 * Creates a ConduitAPI implementation backed by a WebSocket connection to the
 * Conduit server. This is used when running in browser/Docker mode where
 * window.conduit is not pre-populated by the Electron preload script.
 */
export function createWsConduitClient(wsUrl: string): ConduitAPI {
  const ws = new WebSocket(wsUrl)

  // If WS is closed due to auth failure, redirect to login
  ws.addEventListener('close', (event) => {
    // 4401 is our custom close code for auth failure; also handle HTTP 401 during upgrade
    // which manifests as a close without ever opening (code 1006)
    if (event.code === 4401 || (event.code === 1006 && !event.wasClean)) {
      // Check if we're actually unauthenticated by hitting /auth/me
      fetch('/auth/me').then((res) => {
        if (res.status === 401) {
          window.location.href = '/auth/login'
        }
      }).catch(() => {})
    }
  })
  const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  const outputListeners = new Set<(p: RunOutputPayload) => void>()
  const statusListeners = new Set<(p: RunStatusChangePayload) => void>()
  const oauthCompleteListeners = new Set<(p: { serverUrl: string; success: boolean; error?: string }) => void>()
  const promptTokenListeners = new Set<(p: { sessionId: string; token: string }) => void>()
  const promptDoneListeners = new Set<(p: { sessionId: string; extractedPrompt?: string }) => void>()
  const promptErrorListeners = new Set<(p: { sessionId: string; error: string }) => void>()
  const repoSyncStatusListeners = new Set<(p: RepoSyncStatusPayload) => void>()
  const triggerFiredListeners = new Set<(p: TriggerFiredPayload) => void>()
  const shareChangeListeners = new Set<(p: { entityType: ShareableEntityType; entityId: string }) => void>()
  let idCounter = 0

  ws.onmessage = (event) => {
    let msg: {
      type: 'response' | 'error' | 'event'
      id?: string
      result?: unknown
      error?: string
      channel?: string
      payload?: unknown
    }
    try {
      msg = JSON.parse(event.data as string)
    } catch {
      return
    }

    if (msg.type === 'response' || msg.type === 'error') {
      if (!msg.id) return
      const p = pending.get(msg.id)
      if (!p) return
      pending.delete(msg.id)
      if (msg.type === 'error') {
        p.reject(new Error(msg.error ?? 'Unknown server error'))
      } else {
        p.resolve(msg.result)
      }
    } else if (msg.type === 'event') {
      if (msg.channel === 'run:output') {
        outputListeners.forEach((cb) => cb(msg.payload as RunOutputPayload))
      } else if (msg.channel === 'run:statusChange') {
        statusListeners.forEach((cb) => cb(msg.payload as RunStatusChangePayload))
      } else if (msg.channel === 'mcp:oauth:complete') {
        oauthCompleteListeners.forEach((cb) =>
          cb(msg.payload as { serverUrl: string; success: boolean; error?: string })
        )
      } else if (msg.channel === 'promptChat:token') {
        promptTokenListeners.forEach((cb) =>
          cb(msg.payload as { sessionId: string; token: string })
        )
      } else if (msg.channel === 'promptChat:done') {
        promptDoneListeners.forEach((cb) =>
          cb(msg.payload as { sessionId: string; extractedPrompt?: string })
        )
      } else if (msg.channel === 'promptChat:error') {
        promptErrorListeners.forEach((cb) =>
          cb(msg.payload as { sessionId: string; error: string })
        )
      } else if (msg.channel === 'repo:syncStatus') {
        repoSyncStatusListeners.forEach((cb) =>
          cb(msg.payload as RepoSyncStatusPayload)
        )
      } else if (msg.channel === 'trigger:fired') {
        triggerFiredListeners.forEach((cb) =>
          cb(msg.payload as TriggerFiredPayload)
        )
      } else if (msg.channel === 'share:changed') {
        shareChangeListeners.forEach((cb) =>
          cb(msg.payload as { entityType: ShareableEntityType; entityId: string })
        )
      }
    }
  }

  function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const id = String(idCounter++)
      pending.set(id, {
        resolve: (v) => resolve(v as T),
        reject,
      })

      const send = () =>
        ws.send(JSON.stringify({ type: 'invoke', id, channel, args }))

      if (ws.readyState === WebSocket.OPEN) {
        send()
      } else {
        ws.addEventListener('open', send, { once: true })
      }
    })
  }

  return {
    agents: {
      list: () => invoke<AgentConfig[]>('agents:list'),
      get: (id: string) => invoke<AgentConfig | null>('agents:get', id),
      create: (data: Omit<AgentConfig, 'id' | 'createdAt' | 'updatedAt'>) =>
        invoke<AgentConfig>('agents:create', data),
      update: (
        id: string,
        data: Partial<Omit<AgentConfig, 'id' | 'createdAt' | 'updatedAt'>>
      ) => invoke<AgentConfig>('agents:update', id, data),
      delete: (id: string) => invoke<void>('agents:delete', id),
    },

    runs: {
      list: (agentId: string) => invoke<ExecutionRun[]>('runs:list', agentId),
      start: (agentId: string) => invoke<ExecutionRun>('runs:start', agentId),
      stop: (runId: string) => invoke<void>('runs:stop', runId),
      getLog: (runId: string) => invoke<LogEntry[]>('runs:getLog', runId),
    },

    onOutput: (cb: (payload: RunOutputPayload) => void): (() => void) => {
      outputListeners.add(cb)
      return () => outputListeners.delete(cb)
    },

    onRunStatusChange: (cb: (payload: RunStatusChangePayload) => void): (() => void) => {
      statusListeners.add(cb)
      return () => statusListeners.delete(cb)
    },

    gist: {
      save: (content: string, gistId?: string) =>
        invoke<string>('gist:save', content, gistId),
      load: (gistId: string) => invoke<string>('gist:load', gistId),
      list: () => invoke('gist:list') as any,
    },

    prefs: {
      get: <T>(key: string) => invoke<T | undefined>('prefs:get', key),
      set: (key: string, value: unknown) => invoke<void>('prefs:set', key, value),
    },

    shell: {
      openExternal: async (url: string): Promise<void> => {
        window.open(url, '_blank', 'noopener,noreferrer')
      },
    },

    globalMcps: {
      list: () => invoke<GlobalMcpServer[]>('globalMcps:list'),
      create: (data: Omit<GlobalMcpServer, 'id' | 'createdAt' | 'updatedAt'>) =>
        invoke<GlobalMcpServer>('globalMcps:create', data),
      update: (
        id: string,
        data: Partial<Omit<GlobalMcpServer, 'id' | 'createdAt' | 'updatedAt'>>
      ) => invoke<GlobalMcpServer>('globalMcps:update', id, data),
      delete: (id: string) => invoke<void>('globalMcps:delete', id),
      checkHealth: (serverConfig: import('@shared/types').McpServerEntry) =>
        invoke<import('@shared/types').McpHealthResult>('globalMcps:checkHealth', serverConfig),
      listTools: (serverConfig: import('@shared/types').McpServerEntry) =>
        invoke<import('@shared/types').McpToolsResult>('globalMcps:listTools', serverConfig),
    },

    repos: {
      list: () => invoke<Repository[]>('repos:list'),
      get: (id: string) => invoke<Repository | null>('repos:get', id),
      create: (data: RepositoryInput) =>
        invoke<Repository>('repos:create', data),
      update: (id: string, data: Partial<RepositoryInput>) =>
        invoke<Repository>('repos:update', id, data),
      delete: (id: string) => invoke<void>('repos:delete', id),
      triggerSync: (id: string) => invoke<void>('repos:triggerSync', id),
      testConnection: (data: RepoTestConnectionInput) =>
        invoke<{ success: boolean; message: string }>('repos:testConnection', data),
    },

    onRepoSyncStatus: (cb: (payload: RepoSyncStatusPayload) => void): (() => void) => {
      repoSyncStatusListeners.add(cb)
      return () => repoSyncStatusListeners.delete(cb)
    },

    publishTargets: {
      list: () => invoke<PublishTarget[]>('publishTargets:list'),
      get: (id: string) => invoke<PublishTarget | null>('publishTargets:get', id),
      create: (data: Omit<PublishTarget, 'id' | 'createdAt' | 'updatedAt'>) =>
        invoke<PublishTarget>('publishTargets:create', data),
      update: (
        id: string,
        data: Partial<Omit<PublishTarget, 'id' | 'createdAt' | 'updatedAt'>>
      ) => invoke<PublishTarget>('publishTargets:update', id, data),
      delete: (id: string) => invoke<void>('publishTargets:delete', id),
      test: (type: import('@shared/types').PublishTargetType, config: import('@shared/types').PublishConfig) =>
        invoke<{ success: boolean; error?: string }>('publishTargets:test', type, config),
    },

    triggers: {
      list: (agentId: string) => invoke<Trigger[]>('triggers:list', agentId),
      get: (id: string) => invoke<Trigger | null>('triggers:get', id),
      create: (data: Omit<Trigger, 'id' | 'createdAt' | 'updatedAt'>) =>
        invoke<Trigger>('triggers:create', data),
      update: (id: string, data: Partial<Omit<Trigger, 'id' | 'createdAt' | 'updatedAt'>>) =>
        invoke<Trigger>('triggers:update', id, data),
      delete: (id: string) => invoke<void>('triggers:delete', id),
    },

    onTriggerFired: (cb: (payload: TriggerFiredPayload) => void): (() => void) => {
      triggerFiredListeners.add(cb)
      return () => triggerFiredListeners.delete(cb)
    },

    mcpOAuth: {
      getStatus: (serverId: string, isGlobal: boolean) =>
        invoke<McpOAuthStatus>('mcp:oauth:getStatus', serverId, isGlobal),
      startAuth: (serverId: string, isGlobal: boolean) =>
        invoke<{ authUrl: string }>('mcp:oauth:startAuth', serverId, isGlobal),
      revoke: (serverId: string, isGlobal: boolean) =>
        invoke<void>('mcp:oauth:revoke', serverId, isGlobal),
    },

    onMcpOAuthComplete: (
      cb: (payload: { serverUrl: string; success: boolean; error?: string }) => void
    ): (() => void) => {
      oauthCompleteListeners.add(cb)
      return () => oauthCompleteListeners.delete(cb)
    },

    promptChat: {
      start: (agentId: string, runner: RunnerType): Promise<string> =>
        invoke<string>('promptChat:start', agentId, runner),
      send: (sessionId: string, message: string): Promise<void> =>
        invoke<void>('promptChat:send', sessionId, message),
      close: (sessionId: string): Promise<void> =>
        invoke<void>('promptChat:close', sessionId),
    },

    onPromptChatToken: (
      cb: (payload: { sessionId: string; token: string }) => void
    ): (() => void) => {
      promptTokenListeners.add(cb)
      return () => promptTokenListeners.delete(cb)
    },

    onPromptChatDone: (
      cb: (payload: { sessionId: string; extractedPrompt?: string }) => void
    ): (() => void) => {
      promptDoneListeners.add(cb)
      return () => promptDoneListeners.delete(cb)
    },

    onPromptChatError: (
      cb: (payload: { sessionId: string; error: string }) => void
    ): (() => void) => {
      promptErrorListeners.add(cb)
      return () => promptErrorListeners.delete(cb)
    },

    shares: {
      list: (entityType: ShareableEntityType, entityId: string) =>
        invoke<Share[]>('shares:list', entityType, entityId),
      create: (data: { entityType: ShareableEntityType; entityId: string; targetType: 'user' | 'group' | 'everyone'; targetId?: string }) =>
        invoke<Share>('shares:create', data),
      delete: (shareId: string) => invoke<void>('shares:delete', shareId),
    },

    users: {
      list: () => invoke<User[]>('users:list'),
      search: (query: string) => invoke<User[]>('users:search', query),
    },

    groups: {
      list: () => invoke<Group[]>('groups:list'),
    },

    onShareChange: (
      cb: (payload: { entityType: ShareableEntityType; entityId: string }) => void
    ): (() => void) => {
      shareChangeListeners.add(cb)
      return () => shareChangeListeners.delete(cb)
    },
  }
}
