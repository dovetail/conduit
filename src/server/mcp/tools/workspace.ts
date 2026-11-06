import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { listAgents } from '../../../main/db/queries/agents'
import { listRecentRuns } from '../../../main/db/queries/runs'
import { createRepository, getRepository, listRepositories } from '../../../main/db/queries/repositories'
import { listPublishTargets } from '../../../main/db/queries/publishTargets'
import { listGlobalMcps } from '../../../main/db/queries/globalMcps'
import { getCredentialStatus } from '../../../main/db/queries/agentCredentials'
import { getUser } from '../../../main/db/queries/users'
import { canAccessEntity } from '../../../main/db/queries/access'
import { isAuthEnabled } from '../../auth/config'
import { ClientError } from '../../errors'
import { checkRunnerClis } from '../../runnerCli'
import { testRepoConnection } from '../../gitOps'
import { resolveTestToken, withEncryptedKey } from '../../repoCredentials'
import { redactGlobalMcp, redactPublishTarget, redactUrl } from '../redact'
import { errorMessage, registerTool, type ToolEnv } from '../registry'
import { failureKind, summarizeRun } from './runs'
import type { Repository, RepositoryInput } from '../../../shared/types'

const PEM_RE = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]+-----END [A-Z ]*PRIVATE KEY-----/

/** Reject combinations the repo-sync and run paths cannot use, before anything is stored. */
function assertRepositoryInput(input: RepositoryInput): void {
  let parsed: URL | undefined
  try {
    parsed = new URL(input.url)
  } catch {
    if (!/^[\w.-]+@[\w.-]+:.+/.test(input.url)) {
      throw new ClientError(`"${input.url}" is not a valid clone URL.`)
    }
  }
  if (parsed && (parsed.username || parsed.password)) {
    throw new ClientError('Do not embed credentials in the URL; set authMethod and its credentials instead.')
  }
  if ((input.authMethod === 'githubapp' || input.authMethod === 'pat') && parsed?.protocol !== 'https:') {
    throw new ClientError(`authMethod "${input.authMethod}" needs an https:// clone URL.`)
  }
  if (input.authMethod === 'githubapp') {
    if (!input.githubAppId || !/^\d+$/.test(input.githubAppId)) {
      throw new ClientError('GitHub App auth needs a numeric githubAppId.')
    }
    if (!input.githubPrivateKey || !PEM_RE.test(input.githubPrivateKey)) {
      throw new ClientError('GitHub App auth needs githubPrivateKey: the full PEM, including its BEGIN/END lines.')
    }
  } else if (input.githubAppId || input.githubPrivateKey) {
    throw new ClientError('githubAppId and githubPrivateKey are only used with authMethod "githubapp".')
  }
}

function presentRepository(repo: Repository) {
  return {
    id: repo.id,
    name: repo.name,
    url: redactUrl(repo.url),
    defaultBranch: repo.defaultBranch,
    authMethod: repo.authMethod,
    syncStatus: repo.syncStatus,
    syncError: repo.syncError,
    lastSyncedAt: repo.lastSyncedAt ? new Date(repo.lastSyncedAt).toISOString() : undefined,
    githubAppId: repo.githubAppId,
    hasGithubKey: repo.hasGithubKey,
  }
}

export function registerWorkspaceTools(server: McpServer, env: ToolEnv): void {
  registerTool(server, env, {
    name: 'get_conduit_status',
    title: 'Conduit status overview',
    description:
      'Start here when investigating. Who you are and your token scope, the auth mode, the worker factory and connected workers, which runner CLIs are installed, which runner credentials you have stored, runs in progress, failures in the last 24h, and repositories with sync errors.',
    access: 'read',
    input: {},
    run: async (_args, { caller, deps }) => {
      const agents = await listAgents(caller.userId, caller.userGroupIds)
      const agentIds = agents.map((a) => a.id)
      const names = new Map(agents.map((a) => [a.id, a.name]))
      const [user, clis, credentials, running, failed, repos] = await Promise.all([
        getUser(caller.userId),
        checkRunnerClis(),
        getCredentialStatus(caller.userId),
        listRecentRuns({ agentIds, status: 'running', limit: 50 }),
        listRecentRuns({ agentIds, status: 'failed', since: Date.now() - 86_400_000, limit: 50 }),
        listRepositories(caller.userId, caller.userGroupIds),
      ])
      const failuresByKind: Record<string, number> = {}
      for (const run of failed) {
        const kind = failureKind(run) ?? 'unknown'
        failuresByKind[kind] = (failuresByKind[kind] ?? 0) + 1
      }
      return {
        caller: {
          userId: caller.userId,
          name: user?.name,
          email: user?.email,
          scope: caller.scope,
          auth: caller.authKind,
          tokenName: caller.tokenName,
        },
        authMode: isAuthEnabled() ? 'okta' : 'dev-bypass',
        workers: deps.workerStatus(),
        runnerClis: clis,
        storedCredentials: credentials,
        visibleAgents: agents.length,
        runsInProgress: running.map((r) => ({ ...summarizeRun(r), agentName: names.get(r.agentId) })),
        failuresLast24h: {
          total: failed.length,
          byKind: failuresByKind,
          recent: failed.slice(0, 10).map((r) => ({
            ...summarizeRun(r),
            agentName: names.get(r.agentId),
            failureKind: failureKind(r),
          })),
        },
        repositoriesWithErrors: repos.filter((r) => r.syncStatus === 'error').map(presentRepository),
      }
    },
  })

  registerTool(server, env, {
    name: 'list_repositories',
    title: 'List repositories',
    description: 'Managed git repositories visible to you, with sync status. Use the id as an agent repositoryId.',
    access: 'read',
    input: {},
    run: async (_args, { caller }) =>
      (await listRepositories(caller.userId, caller.userGroupIds)).map(presentRepository),
  })

  registerTool(server, env, {
    name: 'sync_repository',
    title: 'Sync repository',
    description: "Fetch a managed repository's latest commits now (clones it if it was never cloned).",
    access: 'write',
    idempotent: true,
    input: { repositoryId: z.string() },
    run: async ({ repositoryId }, { caller, deps }) => {
      const repo = await getRepository(repositoryId)
      if (!repo || !(await canAccessEntity('repository', repositoryId, caller.userId, caller.userGroupIds))) {
        throw new ClientError(`Repository "${repositoryId}" was not found or is not accessible to you.`)
      }
      await deps.triggerRepoSync(repositoryId)
      const after = await getRepository(repositoryId)
      return presentRepository(after ?? repo)
    },
  })

  registerTool(server, env, {
    name: 'create_repository',
    title: 'Create repository',
    description:
      'Add a managed git repository owned by you, then start its first sync in the background (poll list_repositories for syncStatus). For authMethod "githubapp" pass githubAppId and githubPrivateKey (the PEM). The key is encrypted at rest and never returned; responses only report hasGithubKey. Use test_repository_connection to check the credential.',
    access: 'write',
    openWorld: true,
    input: {
      name: z.string().min(1),
      url: z.string().min(1).describe('Clone URL, e.g. "https://github.com/org/repo.git". No embedded credentials.'),
      defaultBranch: z.string().min(1).optional().describe("Default 'main'."),
      authMethod: z
        .enum(['none', 'pat', 'ssh', 'githubapp'])
        .describe("'none' (public), 'pat' (the server's GitHub PAT), 'ssh' (server SSH agent), or 'githubapp'."),
      githubAppId: z.string().optional().describe('GitHub App ID (numeric). githubapp only.'),
      githubPrivateKey: z.string().optional().describe('GitHub App private key PEM. githubapp only. Write-only.'),
      commitAuthorName: z.string().optional().describe('Git author name for agent commits.'),
      commitAuthorEmail: z.string().optional().describe('Git author email for agent commits.'),
    },
    run: async (args, { caller, deps }) => {
      const input: RepositoryInput = {
        name: args.name.trim(),
        url: args.url.trim(),
        defaultBranch: args.defaultBranch?.trim() || 'main',
        authMethod: args.authMethod,
        githubAppId: args.githubAppId?.trim() || undefined,
        githubPrivateKey: args.githubPrivateKey,
        commitAuthorName: args.commitAuthorName?.trim() || undefined,
        commitAuthorEmail: args.commitAuthorEmail?.trim() || undefined,
      }
      assertRepositoryInput(input)
      const repo = await createRepository(withEncryptedKey(input), caller.userId)
      deps.triggerRepoSync(repo.id).catch((err) =>
        console.error(`[mcp] Initial sync failed for repo ${repo.id}:`, err)
      )
      return presentRepository(repo)
    },
  })

  registerTool(server, env, {
    name: 'test_repository_connection',
    title: 'Test repository connection',
    description:
      "Check a repository's stored credential: resolve its token (minting a GitHub App installation token when needed) and list the remote's branches. Nothing is changed, and the token is never returned.",
    access: 'read',
    openWorld: true,
    input: { repositoryId: z.string() },
    run: async ({ repositoryId }, { caller }) => {
      const repo = await getRepository(repositoryId)
      if (!repo || !(await canAccessEntity('repository', repositoryId, caller.userId, caller.userGroupIds))) {
        throw new ClientError(`Repository "${repositoryId}" was not found or is not accessible to you.`)
      }
      try {
        const token = await resolveTestToken({ url: repo.url, authMethod: repo.authMethod, repoId: repo.id })
        return { repositoryId, success: true, message: await testRepoConnection(repo.url, token) }
      } catch (err) {
        return { repositoryId, success: false, message: errorMessage(err) }
      }
    },
  })

  registerTool(server, env, {
    name: 'list_publish_targets',
    title: 'List publish targets',
    description:
      'Publish targets (Slack, email, webhook) visible to you. Attach them to agents via update_agent publishTargetIds. Secrets are redacted.',
    access: 'read',
    input: {},
    run: async (_args, { caller }) =>
      (await listPublishTargets(caller.userId, caller.userGroupIds)).map(redactPublishTarget),
  })

  registerTool(server, env, {
    name: 'list_global_mcp_servers',
    title: 'List global MCP servers',
    description:
      'Global MCP servers, loaded into every run when enabled. Their keys cannot be reused by agent MCP servers. Secrets are redacted.',
    access: 'read',
    input: {},
    run: async (_args, { caller }) =>
      (await listGlobalMcps(caller.userId, caller.userGroupIds)).map(redactGlobalMcp),
  })
}
