import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { WorkerHandle } from '../shared/worker'

const resolvePushCredential = vi.fn()
const captureException = vi.fn()

vi.mock('./githubApp', () => ({
  resolvePushCredential: (...args: unknown[]) => resolvePushCredential(...args),
  githubTokenEnvEntry: vi.fn(() => ({})),
}))

vi.mock('../main/db/queries/runs', () => ({
  updateRunIfRunning: vi.fn(),
  createRun: vi.fn(),
  updateRun: vi.fn(),
  getRunningRunForAgent: vi.fn(),
}))

vi.mock('./observability', () => ({
  reporter: {
    captureMessage: vi.fn(),
    captureException: (...args: unknown[]) => captureException(...args),
    setUser: vi.fn(),
    addBreadcrumb: vi.fn(),
    flush: vi.fn(async () => {}),
  },
}))

const resolveRunMcpAuth = vi.fn()

vi.mock('../main/utils/mcp', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../main/utils/mcp')>()),
  resolveRunMcpAuth: (...args: unknown[]) => resolveRunMcpAuth(...args),
}))

import { startRepoTokenRefresh, startMcpAuthRefresh } from './runner'

const REPO = { id: 'repo-1', url: 'https://github.com/acme/widgets.git', authMethod: 'githubapp' as const }

describe('startRepoTokenRefresh', () => {
  let finalizers: Array<() => void>
  let messages: string[]
  let updateRepoToken: ReturnType<typeof vi.fn>
  let handle: WorkerHandle

  beforeEach(() => {
    vi.useFakeTimers()
    finalizers = []
    messages = []
    resolvePushCredential.mockReset()
    captureException.mockReset()
    updateRepoToken = vi.fn(async () => {})
    handle = { runId: 'run-1', ephemeral: false, cancel: async () => {}, updateRepoToken }
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function start(): void {
    startRepoTokenRefresh(
      'run-1',
      REPO,
      handle,
      { emitSystemMessage: (t) => messages.push(t), onFinalized: (cb) => finalizers.push(cb) },
      1000
    )
  }

  it('hands each freshly minted token to the worker', async () => {
    resolvePushCredential.mockResolvedValueOnce({ token: 'ghs_1' }).mockResolvedValueOnce({ token: 'ghs_2' })
    start()
    await vi.advanceTimersByTimeAsync(1000)
    await vi.advanceTimersByTimeAsync(1000)
    expect(updateRepoToken.mock.calls).toEqual([['ghs_1'], ['ghs_2']])
    expect(messages).toEqual([])
  })

  it('stops once the run is finalized', async () => {
    resolvePushCredential.mockResolvedValue({ token: 'ghs_1' })
    start()
    for (const cb of finalizers) cb()
    await vi.advanceTimersByTimeAsync(5000)
    expect(resolvePushCredential).not.toHaveBeenCalled()
  })

  it('warns in the run log and reports when minting fails, then keeps trying', async () => {
    resolvePushCredential
      .mockResolvedValueOnce({ error: new Error('GitHub App is not installed') })
      .mockResolvedValueOnce({ token: 'ghs_2' })
    start()
    await vi.advanceTimersByTimeAsync(1000)
    expect(messages[0]).toContain('Could not refresh GitHub credentials: GitHub App is not installed')
    expect(captureException).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1000)
    expect(updateRepoToken).toHaveBeenCalledWith('ghs_2')
  })

  it('reports a worker that fails to apply the token', async () => {
    resolvePushCredential.mockResolvedValue({ token: 'ghs_1' })
    updateRepoToken.mockRejectedValueOnce(new Error('git remote set-url failed'))
    start()
    await vi.advanceTimersByTimeAsync(1000)
    expect(messages[0]).toContain('git remote set-url failed')
    expect(captureException).toHaveBeenCalledOnce()
  })
})

describe('startMcpAuthRefresh', () => {
  const SERVERS = [
    { key: 'buildkite', url: 'https://mcp.buildkite.com/mcp', owner: 'u1', authorization: 'Bearer bk_1' },
    { key: 'linear', url: 'https://mcp.linear.app/mcp', owner: '__global__', authorization: 'Bearer lin_1' },
  ]
  let finalizers: Array<() => void>
  let messages: string[]
  let updateMcpAuth: ReturnType<typeof vi.fn>
  let handle: WorkerHandle

  beforeEach(() => {
    vi.useFakeTimers()
    finalizers = []
    messages = []
    resolveRunMcpAuth.mockReset()
    captureException.mockReset()
    updateMcpAuth = vi.fn(async () => {})
    handle = { runId: 'run-1', ephemeral: false, cancel: async () => {}, updateMcpAuth }
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function start(): void {
    startMcpAuthRefresh(
      'run-1',
      SERVERS,
      handle,
      { emitSystemMessage: (t) => messages.push(t), onFinalized: (cb) => finalizers.push(cb) },
      1000
    )
  }

  it('sends only tokens that changed since the worker last heard', async () => {
    resolveRunMcpAuth
      .mockResolvedValueOnce({ buildkite: 'Bearer bk_1', linear: 'Bearer lin_1' })
      .mockResolvedValueOnce({ buildkite: 'Bearer bk_2', linear: 'Bearer lin_1' })
      .mockResolvedValueOnce({ buildkite: 'Bearer bk_2', linear: 'Bearer lin_1' })
    start()
    await vi.advanceTimersByTimeAsync(3000)
    expect(updateMcpAuth.mock.calls).toEqual([[{ buildkite: 'Bearer bk_2' }]])
  })

  it('resends a token the worker failed to apply, warning once', async () => {
    resolveRunMcpAuth.mockResolvedValue({ buildkite: 'Bearer bk_2' })
    updateMcpAuth.mockRejectedValueOnce(new Error('socket gone')).mockRejectedValueOnce(new Error('socket gone'))
    start()
    await vi.advanceTimersByTimeAsync(3000)
    expect(updateMcpAuth).toHaveBeenCalledTimes(3)
    expect(messages).toHaveLength(1)
    expect(messages[0]).toContain('Could not refresh MCP OAuth credentials: socket gone')
    expect(captureException).toHaveBeenCalledTimes(2)
  })

  it('stops once the run is finalized', async () => {
    start()
    for (const cb of finalizers) cb()
    await vi.advanceTimersByTimeAsync(5000)
    expect(resolveRunMcpAuth).not.toHaveBeenCalled()
  })
})
