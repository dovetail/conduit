import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type {
  AgentConfig,
  ExecutionRun,
  PromptRevision,
  Repository,
  RunLog,
  Trigger,
} from '../../shared/types'
import type { RepoWriteData } from '../../main/db/queries/repositories'
import type { McpCaller, McpDeps } from './context'

// ── In-memory fake of the data layer ─────────────────────────────────────────
const db = vi.hoisted(() => ({
  agents: new Map<string, AgentConfig>(),
  runs: new Map<string, ExecutionRun>(),
  triggers: new Map<string, Trigger>(),
  revisions: [] as PromptRevision[],
  logs: new Map<string, RunLog>(),
  repos: new Map<string, Repository>(),
  /** repoId → stored (encrypted) GitHub App key. */
  repoKeys: new Map<string, string>(),
  /** agentId → userIds allowed to see it (besides the owner). */
  sharedWith: new Map<string, string[]>(),
  seq: 0,
}))

function visible(agentId: string, userId: string): boolean {
  const a = db.agents.get(agentId)
  return !!a && (a.ownerId === userId || (db.sharedWith.get(agentId) ?? []).includes(userId))
}

vi.mock('../../main/db/queries/agents', () => ({
  listAgents: async (userId: string) => [...db.agents.values()].filter((a) => visible(a.id, userId)),
  getAgent: async (id: string) => db.agents.get(id) ?? null,
  createAgent: async (data: Omit<AgentConfig, 'id' | 'createdAt' | 'updatedAt'>, ownerId: string) => {
    const agent = { ...data, id: `agent-${++db.seq}`, ownerId, createdAt: 1, updatedAt: 1 } as AgentConfig
    db.agents.set(agent.id, agent)
    return agent
  },
  updateAgent: async (id: string, patch: Partial<AgentConfig>) => {
    const next = { ...db.agents.get(id)!, ...patch, updatedAt: db.agents.get(id)!.updatedAt + 1 }
    db.agents.set(id, next)
    return next
  },
  deleteAgent: async (id: string) => void db.agents.delete(id),
}))
vi.mock('../../main/db/queries/access', () => ({
  canAccessEntity: async (type: string, id: string, userId: string) => (type === 'agent' ? visible(id, userId) : true),
  isEntityOwner: async (_t: string, id: string, userId: string) => db.agents.get(id)?.ownerId === userId,
}))
vi.mock('../../main/db/queries/runs', () => ({
  listRuns: async (agentId: string) => [...db.runs.values()].filter((r) => r.agentId === agentId),
  getRun: async (id: string) => db.runs.get(id) ?? null,
  listRecentRuns: async (o: { agentIds: string[]; status?: string; limit: number }) =>
    [...db.runs.values()]
      .filter((r) => o.agentIds.includes(r.agentId) && (!o.status || r.status === o.status))
      .slice(0, o.limit),
}))
vi.mock('../../main/db/queries/triggers', () => ({
  listTriggers: async (agentId: string) => [...db.triggers.values()].filter((t) => t.agentId === agentId),
  getTrigger: async (id: string) => db.triggers.get(id) ?? null,
  createTrigger: async (data: Omit<Trigger, 'id' | 'createdAt' | 'updatedAt'>) => {
    const t = { ...data, id: `trigger-${++db.seq}`, createdAt: 1, updatedAt: 1 } as Trigger
    db.triggers.set(t.id, t)
    return t
  },
  updateTrigger: async (id: string, patch: Partial<Trigger>) => {
    const t = { ...db.triggers.get(id)!, ...patch }
    db.triggers.set(id, t)
    return t
  },
  deleteTrigger: async (id: string) => void db.triggers.delete(id),
}))
vi.mock('../../main/db/queries/promptRevisions', () => ({
  listPromptRevisions: async (agentId: string) =>
    db.revisions.filter((r) => r.agentId === agentId).sort((a, b) => b.createdAt - a.createdAt),
  getPromptRevision: async (agentId: string, id: string) =>
    db.revisions.find((r) => r.id === id && r.agentId === agentId) ?? null,
  recordPromptChange: async (c: { agentId: string; nextPrompt: string; source: 'mcp'; note?: string; userId?: string }) => {
    const rev = { id: `rev-${++db.seq}`, agentId: c.agentId, prompt: c.nextPrompt, source: c.source, note: c.note, createdBy: c.userId, createdAt: db.seq }
    db.revisions.push(rev)
    return rev
  },
}))
vi.mock('../../main/db/queries/repositories', () => ({
  getRepository: async (id: string) => db.repos.get(id) ?? null,
  listRepositories: async () => [...db.repos.values()],
  createRepository: async (data: RepoWriteData, ownerId: string) => {
    const { githubPrivateKeyEnc, ...rest } = data
    const repo: Repository = {
      ...rest,
      id: `repo-${++db.seq}`,
      ownerId,
      syncStatus: 'pending',
      hasGithubKey: !!githubPrivateKeyEnc,
      createdAt: 1,
      updatedAt: 1,
    }
    db.repos.set(repo.id, repo)
    if (githubPrivateKeyEnc) db.repoKeys.set(repo.id, githubPrivateKeyEnc)
    return repo
  },
}))
vi.mock('../crypto', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../crypto')>()),
  encryptSecret: (s: string) => `enc:${s.length}`,
}))
vi.mock('../githubApp', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../githubApp')>()),
  resolveRepoToken: vi.fn(async () => 'ghs_installation'),
}))
vi.mock('../gitOps', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../gitOps')>()),
  testRepoConnection: vi.fn(async () => 'Connected — 3 branches found'),
}))
vi.mock('../../main/db/queries/publishTargets', () => ({
  getPublishTarget: async () => null,
  listPublishTargets: async () => [],
}))
vi.mock('../../main/db/queries/globalMcps', () => ({ listGlobalMcps: async () => [] }))
vi.mock('../../main/db/queries/agentCredentials', () => ({
  getCredentialStatus: async () => ({ claude: true, amp: false, cursor: false }),
}))
vi.mock('../../main/db/queries/users', () => ({
  getUser: async (id: string) => ({ id, name: 'Ada', email: 'ada@example.com' }),
}))
vi.mock('../utils', () => ({
  readRunLog: (runId: string) => db.logs.get(runId) ?? { format: 'events', events: [] },
}))
vi.mock('../runnerCli', () => ({
  checkRunnerClis: async () => [{ runner: 'claude', binary: 'claude', installed: true }],
}))
vi.mock('../mcpServerProbe', () => ({
  checkMcpServerHealth: async () => ({ status: 'healthy', message: 'ok' }),
  listMcpServerTools: async () => ({ tools: [{ name: 'search' }] }),
}))

import { createConduitMcpServer } from './server'
import { resolveRepoToken } from '../githubApp'
import { testRepoConnection } from '../gitOps'

const PEM = '-----BEGIN RSA PRIVATE KEY-----\nMIIEsecretkeymaterial\n-----END RSA PRIVATE KEY-----\n'

// ── Helpers ──────────────────────────────────────────────────────────────────
const deps: McpDeps = {
  startRun: vi.fn(async (agentId: string, startedBy: string) => ({
    id: 'run-new', agentId, status: 'running', startedAt: 0, logPath: '', startedBy,
  }) as ExecutionRun),
  stopRun: vi.fn(async () => {}),
  registerTrigger: vi.fn(),
  unregisterTrigger: vi.fn(),
  triggerRepoSync: vi.fn(async () => {}),
  broadcast: vi.fn(),
  workerStatus: () => ({ factory: 'local' }),
  baseUrl: 'https://conduit.example',
}

function caller(userId: string, scope: 'read' | 'write'): McpCaller {
  return { userId, userGroupIds: [], scope, authKind: 'token', tokenId: 't', tokenName: 'test' }
}

async function connect(c: McpCaller): Promise<Client> {
  const server = createConduitMcpServer(c, deps)
  const [clientT, serverT] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test', version: '1' })
  await Promise.all([server.connect(serverT), client.connect(clientT)])
  return client
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const res = (await client.callTool({ name, arguments: args })) as {
    isError?: boolean
    content: Array<{ type: string; text: string }>
  }
  const text = res.content[0]!.text
  return { isError: !!res.isError, text, json: res.isError ? undefined : JSON.parse(text) }
}

function seed() {
  db.agents.clear(); db.runs.clear(); db.triggers.clear(); db.logs.clear(); db.sharedWith.clear()
  db.repos.clear(); db.repoKeys.clear()
  db.revisions.length = 0
  db.agents.set('a1', {
    id: 'a1', name: 'Triage bot', runner: 'claude', prompt: 'Triage issues.\nBe brief.',
    envVars: { GITHUB_TOKEN: 'ghp_real' },
    mcpConfig: { mcpServers: { linear: { type: 'http', url: 'https://mcp.linear.app/mcp', headers: { Authorization: 'Bearer real' } } } },
    ownerId: 'alice', createdAt: 1, updatedAt: 10,
  })
  db.agents.set('a2', {
    id: 'a2', name: 'Private', runner: 'amp', prompt: 'secret work', envVars: {},
    mcpConfig: { mcpServers: {} }, ownerId: 'bob', createdAt: 1, updatedAt: 1,
  })
  db.runs.set('r1', {
    id: 'r1', agentId: 'a1', status: 'failed', startedAt: 100, logPath: '', exitCode: 1,
    lastLine: 'Error: invalid api key',
  })
  db.logs.set('r1', {
    format: 'events',
    events: [
      { t: 100, kind: 'tool_use', toolName: 'Bash', toolUseId: 'u', toolInput: { command: 'gh issue list' } },
      { t: 101, kind: 'tool_result', toolUseId: 'u', content: 'HTTP 401', isError: true },
      { t: 102, kind: 'result', isError: true, text: 'failed' },
    ],
  })
}

beforeEach(() => {
  seed()
  vi.clearAllMocks()
})

// ── Tests ────────────────────────────────────────────────────────────────────
describe('Conduit MCP server', () => {
  it('advertises tools, prompts, and resource templates', async () => {
    const client = await connect(caller('alice', 'write'))
    const tools = (await client.listTools()).tools.map((t) => t.name)
    expect(tools).toEqual(expect.arrayContaining([
      'get_conduit_status', 'list_agents', 'get_agent', 'create_agent', 'update_agent', 'delete_agent',
      'set_agent_mcp_server', 'remove_agent_mcp_server', 'check_mcp_server', 'list_triggers', 'create_trigger',
      'update_trigger', 'delete_trigger', 'list_runs', 'get_run', 'get_run_log', 'start_run', 'stop_run',
      'get_agent_prompt', 'update_agent_prompt', 'edit_agent_prompt', 'list_prompt_revisions',
      'get_prompt_revision', 'restore_prompt_revision', 'get_prompt_performance', 'list_repositories',
      'sync_repository', 'create_repository', 'test_repository_connection', 'list_publish_targets',
      'list_global_mcp_servers',
    ]))
    const prompts = (await client.listPrompts()).prompts.map((p) => p.name)
    expect(prompts).toEqual(['investigate-run', 'improve-agent-prompt', 'triage-failures', 'design-agent'])
    const templates = (await client.listResourceTemplates()).resourceTemplates.map((t) => t.uriTemplate)
    expect(templates).toEqual(['conduit://agents/{agentId}', 'conduit://agents/{agentId}/prompt', 'conduit://runs/{runId}', 'conduit://runs/{runId}/log'])
    expect(client.getInstructions()).toContain('get_conduit_status')
  })

  it('hides write tools from read-scoped tokens and marks the rest read-only', async () => {
    const client = await connect(caller('alice', 'read'))
    const tools = (await client.listTools()).tools
    const names = tools.map((t) => t.name)
    for (const w of ['create_agent', 'update_agent', 'delete_agent', 'edit_agent_prompt', 'start_run', 'create_trigger', 'create_repository']) {
      expect(names).not.toContain(w)
    }
    expect(names).toContain('get_run_log')
    expect(tools.every((t) => t.annotations?.readOnlyHint === true)).toBe(true)
  })

  it('only lists agents visible to the caller and hides others by id', async () => {
    const client = await connect(caller('alice', 'read'))
    const list = await call(client, 'list_agents')
    expect(list.json.agents.map((a: AgentConfig) => a.id)).toEqual(['a1'])
    const denied = await call(client, 'get_agent', { agentId: 'a2' })
    expect(denied.isError).toBe(true)
    expect(denied.text).toMatch(/not found or is not accessible/)
  })

  it('redacts secrets in get_agent', async () => {
    const client = await connect(caller('alice', 'read'))
    const { json, text } = await call(client, 'get_agent', { agentId: 'a1' })
    expect(json.envVars).toEqual({ GITHUB_TOKEN: '[redacted]' })
    expect(json.mcpConfig.mcpServers.linear.headers).toEqual({ Authorization: '[redacted]' })
    expect(text).not.toContain('ghp_real')
    expect(text).not.toContain('Bearer real')
    expect(json.recentRuns[0].id).toBe('r1')
  })

  it('edits a prompt, records a revision with the note, and notifies the UI', async () => {
    const client = await connect(caller('alice', 'write'))
    const res = await call(client, 'edit_agent_prompt', {
      agentId: 'a1', oldText: 'Be brief.', newText: 'Link the issue in every comment.', note: 'r1 missed links',
    })
    expect(res.json.diff).toBe('@@ line 2 @@\n- Be brief.\n+ Link the issue in every comment.')
    expect(db.agents.get('a1')!.prompt).toBe('Triage issues.\nLink the issue in every comment.')
    expect(db.revisions).toHaveLength(1)
    expect(db.revisions[0]).toMatchObject({ source: 'mcp', note: 'r1 missed links', createdBy: 'alice' })
    expect(deps.broadcast).toHaveBeenCalledWith('entity:changed', { entity: 'agent', id: 'a1' })
  })

  it('rejects a stale full prompt replacement', async () => {
    const client = await connect(caller('alice', 'write'))
    const res = await call(client, 'update_agent_prompt', { agentId: 'a1', prompt: 'new', note: 'x', expectedUpdatedAt: 3 })
    expect(res.isError).toBe(true)
    expect(res.text).toMatch(/changed since you read it/)
    expect(db.agents.get('a1')!.prompt).toBe('Triage issues.\nBe brief.')
  })

  it('restores an earlier prompt revision', async () => {
    const client = await connect(caller('alice', 'write'))
    db.revisions.push({ id: 'old', agentId: 'a1', prompt: 'Original prompt', source: 'baseline', createdAt: 1 })
    const res = await call(client, 'restore_prompt_revision', { agentId: 'a1', revisionId: 'old' })
    expect(res.isError).toBe(false)
    expect(db.agents.get('a1')!.prompt).toBe('Original prompt')
    expect(db.revisions.at(-1)).toMatchObject({ source: 'restore' })
  })

  it('round-trips a redacted MCP server definition without losing its secret', async () => {
    const client = await connect(caller('alice', 'write'))
    const res = await call(client, 'set_agent_mcp_server', {
      agentId: 'a1', key: 'linear',
      server: { type: 'http', url: 'https://mcp.linear.app/mcp', headers: { Authorization: '[redacted]', 'X-Team': 'eng' } },
    })
    expect(res.json.server.headers).toEqual({ Authorization: '[redacted]', 'X-Team': '[redacted]' })
    expect(db.agents.get('a1')!.mcpConfig.mcpServers.linear!.headers).toEqual({ Authorization: 'Bearer real', 'X-Team': 'eng' })
  })

  it('patches env vars, keeping redacted values', async () => {
    const client = await connect(caller('alice', 'write'))
    await call(client, 'update_agent', { agentId: 'a1', envVars: { GITHUB_TOKEN: '[redacted]', LOG_LEVEL: 'debug' } })
    expect(db.agents.get('a1')!.envVars).toEqual({ GITHUB_TOKEN: 'ghp_real', LOG_LEVEL: 'debug' })
  })

  it('only lets the owner delete, and requires the name to confirm', async () => {
    db.sharedWith.set('a1', ['carol'])
    const shared = await connect(caller('carol', 'write'))
    expect((await call(shared, 'delete_agent', { agentId: 'a1', confirmName: 'Triage bot' })).text).toMatch(/Only the owner/)
    const owner = await connect(caller('alice', 'write'))
    expect((await call(owner, 'delete_agent', { agentId: 'a1', confirmName: 'nope' })).text).toMatch(/does not match/)
    expect((await call(owner, 'delete_agent', { agentId: 'a1', confirmName: 'Triage bot' })).json).toEqual({ deleted: true, agentId: 'a1' })
  })

  it('creates a cron trigger, validates expressions, and schedules it', async () => {
    const client = await connect(caller('alice', 'write'))
    const bad = await call(client, 'create_trigger', { agentId: 'a1', name: 'nightly', type: 'cron', cronExpression: 'every night' })
    expect(bad.text).toMatch(/Invalid cron expression/)
    const ok = await call(client, 'create_trigger', { agentId: 'a1', name: 'nightly', type: 'cron', cronExpression: '0 2 * * *', timezone: 'UTC' })
    expect(ok.json.config).toEqual({ expression: '0 2 * * *', timezone: 'UTC' })
    expect(deps.registerTrigger).toHaveBeenCalledTimes(1)
    const hook = await call(client, 'create_trigger', { agentId: 'a1', name: 'gh', type: 'webhook', webhookSecret: 's3cret' })
    expect(hook.json.webhookUrl).toBe(`https://conduit.example/api/triggers/webhook/${hook.json.id}`)
    expect(hook.json.config).toEqual({ secret: '[redacted]' })
  })

  it('digests a failed run and pages its log', async () => {
    const client = await connect(caller('alice', 'read'))
    const run = await call(client, 'get_run', { runId: 'r1' })
    expect(run.json.failureKind).toBe('authentication')
    expect(run.json.digest.toolErrors).toEqual([{ index: 1, toolName: 'Bash', excerpt: 'HTTP 401' }])
    const page = await call(client, 'get_run_log', { runId: 'r1', onlyErrors: true })
    expect(page.json.events.map((e: { index: number }) => e.index)).toEqual([1, 2])
    const failed = await call(client, 'list_runs', { status: 'failed' })
    expect(failed.json.runs[0]).toMatchObject({ id: 'r1', agentName: 'Triage bot', failureKind: 'authentication' })
  })

  it('creates a GitHub App repository, stores only the encrypted key, and starts its first sync', async () => {
    const client = await connect(caller('alice', 'write'))
    const res = await call(client, 'create_repository', {
      name: 'platform (Arbiter)', url: 'https://github.com/acme/platform.git', defaultBranch: 'master',
      authMethod: 'githubapp', githubAppId: '5563623', githubPrivateKey: PEM,
    })
    expect(res.isError).toBe(false)
    expect(res.json).toMatchObject({
      name: 'platform (Arbiter)', defaultBranch: 'master', authMethod: 'githubapp',
      githubAppId: '5563623', hasGithubKey: true, syncStatus: 'pending',
    })
    expect(res.text).not.toContain('PRIVATE KEY')
    expect(res.text).not.toContain('secretkeymaterial')
    expect(db.repos.get(res.json.id)).toMatchObject({ ownerId: 'alice' })
    expect(db.repoKeys.get(res.json.id)).toBe(`enc:${PEM.trim().length}`)
    expect(deps.triggerRepoSync).toHaveBeenCalledWith(res.json.id)
  })

  it('rejects repository input the sync path cannot use', async () => {
    const client = await connect(caller('alice', 'write'))
    const base = { name: 'r', url: 'https://github.com/acme/r.git', authMethod: 'githubapp', githubAppId: '1' }
    expect((await call(client, 'create_repository', base)).text).toMatch(/needs githubPrivateKey/)
    expect((await call(client, 'create_repository', { ...base, githubPrivateKey: 'not a pem' })).text).toMatch(/needs githubPrivateKey/)
    expect((await call(client, 'create_repository', { ...base, githubAppId: 'abc', githubPrivateKey: PEM })).text).toMatch(/numeric githubAppId/)
    expect((await call(client, 'create_repository', { ...base, url: 'git@github.com:acme/r.git', githubPrivateKey: PEM })).text).toMatch(/https:\/\/ clone URL/)
    expect((await call(client, 'create_repository', { ...base, url: 'https://x:ghp_t@github.com/acme/r.git', githubPrivateKey: PEM })).text).toMatch(/embed credentials/)
    expect((await call(client, 'create_repository', { name: 'r', url: 'https://github.com/acme/r.git', authMethod: 'none', githubAppId: '1' })).text).toMatch(/only used with authMethod "githubapp"/)
    expect(db.repos.size).toBe(0)
    expect(deps.triggerRepoSync).not.toHaveBeenCalled()
  })

  it('tests a stored repository credential without returning the token', async () => {
    const client = await connect(caller('alice', 'write'))
    const created = await call(client, 'create_repository', {
      name: 'p', url: 'https://github.com/acme/p.git', authMethod: 'githubapp', githubAppId: '7', githubPrivateKey: PEM,
    })
    const ok = await call(client, 'test_repository_connection', { repositoryId: created.json.id })
    expect(ok.json).toEqual({ repositoryId: created.json.id, success: true, message: 'Connected — 3 branches found' })
    expect(resolveRepoToken).toHaveBeenCalledWith({ id: created.json.id, url: 'https://github.com/acme/p.git', authMethod: 'githubapp' })
    expect(testRepoConnection).toHaveBeenCalledWith('https://github.com/acme/p.git', 'ghs_installation')
    expect(ok.text).not.toContain('ghs_installation')

    vi.mocked(resolveRepoToken).mockRejectedValueOnce(new Error('GitHub App (id 7) is not installed for acme/p'))
    const failed = await call(client, 'test_repository_connection', { repositoryId: created.json.id })
    expect(failed.json).toMatchObject({ success: false, message: 'GitHub App (id 7) is not installed for acme/p' })

    expect((await call(client, 'test_repository_connection', { repositoryId: 'nope' })).text).toMatch(/not found or is not accessible/)
  })

  it('starts runs attributed to the caller', async () => {
    const client = await connect(caller('alice', 'write'))
    const res = await call(client, 'start_run', { agentId: 'a1' })
    expect(deps.startRun).toHaveBeenCalledWith('a1', 'alice')
    expect(res.json.id).toBe('run-new')
  })

  it('reports status for the caller', async () => {
    const client = await connect(caller('alice', 'read'))
    const { json } = await call(client, 'get_conduit_status')
    expect(json.caller).toMatchObject({ userId: 'alice', name: 'Ada', scope: 'read', tokenName: 'test' })
    expect(json.failuresLast24h.byKind).toEqual({ authentication: 1 })
  })

  it('renders prompts with embedded context and enforces access', async () => {
    const client = await connect(caller('alice', 'read'))
    const p = await client.getPrompt({ name: 'improve-agent-prompt', arguments: { agentId: 'a1', goal: 'fewer failures' } })
    const text = (p.messages[0]!.content as { text: string }).text
    expect(text).toContain('<prompt>\nTriage issues.\nBe brief.\n</prompt>')
    expect(text).toContain('Goal: fewer failures')
    await expect(client.getPrompt({ name: 'investigate-run', arguments: { runId: 'nope' } })).rejects.toThrow()
  })

  it('serves agent and run resources', async () => {
    const client = await connect(caller('alice', 'read'))
    const listed = (await client.listResources()).resources.map((r) => r.uri)
    expect(listed).toEqual(['conduit://agents/a1', 'conduit://agents/a1/prompt'])
    const prompt = await client.readResource({ uri: 'conduit://agents/a1/prompt' })
    expect((prompt.contents[0] as { text: string }).text).toBe('Triage issues.\nBe brief.')
    const log = await client.readResource({ uri: 'conduit://runs/r1/log' })
    expect((log.contents[0] as { text: string }).text).toContain('tool_result Bash [error]: HTTP 401')
    await expect(client.readResource({ uri: 'conduit://agents/a2/prompt' })).rejects.toThrow()
  })
})
