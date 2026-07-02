import type { RunOutputPayload, RunStatusChangePayload, RepoSyncStatusPayload } from '@shared/types'

function getConduit() {
  if (typeof window === 'undefined' || !window.conduit) {
    throw new Error(
      'window.conduit is not available. Are you running outside of Electron? ' +
        'The conduit API is only available in the Electron renderer process.'
    )
  }
  return window.conduit
}

export const api = {
  get agents() {
    return getConduit().agents
  },
  get runs() {
    return getConduit().runs
  },
  get gist() {
    return getConduit().gist
  },
  get prefs() {
    return getConduit().prefs
  },
  get shell() {
    return getConduit().shell
  },
  get globalMcps() {
    return getConduit().globalMcps
  },
  get repos() {
    return getConduit().repos
  },
  get runners() {
    return getConduit().runners
  },
  get agentCredentials() {
    return getConduit().agentCredentials
  },
  onRepoSyncStatus: (cb: (payload: RepoSyncStatusPayload) => void): (() => void) => {
    return getConduit().onRepoSyncStatus(cb)
  },
  get publishTargets() {
    return getConduit().publishTargets
  },
  get triggers() {
    return getConduit().triggers
  },
  onTriggerFired: (cb: (payload: import('@shared/types').TriggerFiredPayload) => void): (() => void) => {
    return getConduit().onTriggerFired(cb)
  },
  get mcpOAuth() {
    return getConduit().mcpOAuth
  },
  onOutput: (cb: (payload: RunOutputPayload) => void): (() => void) => {
    return getConduit().onOutput(cb)
  },
  onRunStatusChange: (cb: (payload: RunStatusChangePayload) => void): (() => void) => {
    return getConduit().onRunStatusChange(cb)
  },
  onMcpOAuthComplete: (
    cb: (payload: { serverUrl: string; success: boolean; error?: string }) => void
  ): (() => void) => {
    return getConduit().onMcpOAuthComplete(cb)
  },
  get promptChat() {
    return getConduit().promptChat
  },
  onPromptChatToken: (
    cb: (payload: { sessionId: string; token: string }) => void
  ): (() => void) => {
    return getConduit().onPromptChatToken(cb)
  },
  onPromptChatDone: (
    cb: (payload: { sessionId: string; extractedPrompt?: string }) => void
  ): (() => void) => {
    return getConduit().onPromptChatDone(cb)
  },
  onPromptChatError: (
    cb: (payload: { sessionId: string; error: string }) => void
  ): (() => void) => {
    return getConduit().onPromptChatError(cb)
  },
  get shares() {
    return getConduit().shares
  },
  get users() {
    return getConduit().users
  },
  get groups() {
    return getConduit().groups
  },
  onShareChange: (
    cb: (payload: { entityType: import('@shared/types').ShareableEntityType; entityId: string }) => void
  ): (() => void) => {
    return getConduit().onShareChange(cb)
  },
}
