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
import { assertRepositoryUrl, runConnectionTest, withEncryptedSecrets } from '../../repoCredentials'
import { generateSshKeyPair } from '../../sshKey'
import { redactGlobalMcp, redactPublishTarget, redactUrl } from '../redact'
import { errorMessage, registerTool, type ToolEnv } from '../registry'
import { failureKind, summarizeRun } from './runs'
import type { Repository, RepositoryInput } from '../../../shared/types'

const PEM_RE = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]+-----END [A-Z ]*PRIVATE KEY-----/

/** Reject combinations the repo-sync and run paths cannot use, before anything is stored. */
function assertRepositoryInput(input: RepositoryInput): void {
  assertRepositoryUrl(input)
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
  if (input.authMethod === 'gitlab') {
    if (!input.gitlabToken?.trim()) throw new ClientError('GitLab auth needs gitlabToken (a personal, project, or group access token).')
  } else if (input.gitlabToken) {
    throw new ClientError('gitlabToken is only used with authMethod "gitlab".')
  }
  if (input.authMethod !== 'sshkey' && (input.sshPrivateKey || input.sshKnownHosts)) {
    throw new ClientError('sshPrivateKey and sshKnownHosts are only used with authMethod "sshkey".')
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
    hasGitlabToken: repo.hasGitlabToken,
    hasSshKey: repo.hasSshKey,
    sshPublicKey: repo.sshPublicKey,
    sshKeyFingerprint: repo.sshKeyFingerprint,
    sshHostKeyPinned: !!repo.sshKnownHosts,
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
      'Add a managed git repository owned by you, then start its first sync in the background (poll list_repositories for syncStatus). For authMethod "githubapp" pass githubAppId and githubPrivateKey (the PEM). For "gitlab" pass gitlabToken (an access token with read_repository + write_repository; works with self-managed GitLab too). For "sshkey" (any git host over SSH) either pass sshPrivateKey or set generateSshKey: true — Conduit then creates an ed25519 key and returns only its sshPublicKey, which the user must add as a deploy key (with write access if agents push) before the sync can succeed; then call sync_repository. Secrets are encrypted at rest and never returned. Use test_repository_connection to check the credential.',
    access: 'write',
    openWorld: true,
    input: {
      name: z.string().min(1),
      url: z
        .string()
        .min(1)
        .describe('Clone URL, e.g. "https://github.com/org/repo.git", or "git@gitlab.com:group/project.git" for sshkey. No embedded credentials.'),
      defaultBranch: z.string().min(1).optional().describe("Default 'main'."),
      authMethod: z
        .enum(['none', 'pat', 'ssh', 'githubapp', 'gitlab', 'sshkey'])
        .describe(
          "'none' (public), 'pat' (the server's GitHub PAT), 'ssh' (server SSH agent), 'githubapp', 'gitlab' (per-repo GitLab access token over HTTPS), or 'sshkey' (per-repo SSH deploy key, any host)."
        ),
      githubAppId: z.string().optional().describe('GitHub App ID (numeric). githubapp only.'),
      githubPrivateKey: z.string().optional().describe('GitHub App private key PEM. githubapp only. Write-only.'),
      gitlabToken: z.string().optional().describe('GitLab access token. gitlab only. Write-only.'),
      sshPrivateKey: z.string().optional().describe('SSH private key (OpenSSH or PEM, no passphrase). sshkey only. Write-only.'),
      generateSshKey: z.boolean().optional().describe('sshkey only: generate the deploy key server-side instead of passing sshPrivateKey.'),
      sshKnownHosts: z
        .string()
        .optional()
        .describe('sshkey only: known_hosts lines pinning the host key. Omit to trust the host key seen on first sync.'),
      commitAuthorName: z.string().optional().describe('Git author name for agent commits.'),
      commitAuthorEmail: z.string().optional().describe('Git author email for agent commits.'),
    },
    run: async (args, { caller, deps }) => {
      if (args.generateSshKey && args.sshPrivateKey) {
        throw new ClientError('Pass either sshPrivateKey or generateSshKey, not both.')
      }
      if (args.generateSshKey && args.authMethod !== 'sshkey') {
        throw new ClientError('generateSshKey is only used with authMethod "sshkey".')
      }
      const sshPrivateKey = args.generateSshKey ? generateSshKeyPair('conduit-deploy-key').privateKey : args.sshPrivateKey
      if (args.authMethod === 'sshkey' && !sshPrivateKey?.trim()) {
        throw new ClientError('SSH deploy key auth needs sshPrivateKey, or generateSshKey: true.')
      }
      const input: RepositoryInput = {
        name: args.name.trim(),
        url: args.url.trim(),
        defaultBranch: args.defaultBranch?.trim() || 'main',
        authMethod: args.authMethod,
        githubAppId: args.githubAppId?.trim() || undefined,
        githubPrivateKey: args.githubPrivateKey,
        gitlabToken: args.gitlabToken?.trim() || undefined,
        sshPrivateKey,
        sshKnownHosts: args.sshKnownHosts?.trim() || undefined,
        commitAuthorName: args.commitAuthorName?.trim() || undefined,
        commitAuthorEmail: args.commitAuthorEmail?.trim() || undefined,
      }
      assertRepositoryInput(input)
      const repo = await createRepository(withEncryptedSecrets(input), caller.userId)
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
      "Check a repository's stored credential: resolve its token or deploy key (minting a GitHub App installation token when needed) and list the remote's branches. Nothing is changed, and no secret is returned.",
    access: 'read',
    openWorld: true,
    input: { repositoryId: z.string() },
    run: async ({ repositoryId }, { caller }) => {
      const repo = await getRepository(repositoryId)
      if (!repo || !(await canAccessEntity('repository', repositoryId, caller.userId, caller.userGroupIds))) {
        throw new ClientError(`Repository "${repositoryId}" was not found or is not accessible to you.`)
      }
      try {
        const message = await runConnectionTest({ url: repo.url, authMethod: repo.authMethod, repoId: repo.id })
        return { repositoryId, success: true, message }
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
