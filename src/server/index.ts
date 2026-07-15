// Initialise error reporting BEFORE any other import loads (see ./observability/instrument).
import './observability/instrument'
import { reporter, getReporterNames } from './observability'

import express from 'express'
import cookieParser from 'cookie-parser'
import { createServer } from 'http'
import { WebSocketServer, WebSocket } from 'ws'
import * as path from 'path'
import * as fs from 'fs'
import * as os from 'os'
import { initDb } from '../main/db/index'
import { listAgents, getAgent, createAgent, updateAgent, deleteAgent } from '../main/db/queries/agents'
import { listRuns, updateRun, getOrphanedRuns } from '../main/db/queries/runs'
import { startRunServer, stopRun, setRunFinalizedHook, appendRunLog } from './runner'
import { startMemoryMonitor } from './memoryPressure'
import {
  listGlobalMcps,
  getGlobalMcp,
  createGlobalMcp,
  updateGlobalMcp,
  deleteGlobalMcp,
} from '../main/db/queries/globalMcps'
import {
  listPublishTargets,
  getPublishTarget,
  createPublishTarget,
  updatePublishTarget,
  deletePublishTarget,
} from '../main/db/queries/publishTargets'
import {
  listRepositories,
  getRepository,
  createRepository,
  updateRepository,
  deleteRepository,
} from '../main/db/queries/repositories'
import { RepoSyncService } from './repoSync'
import { RunEventBus } from './runEventBus'
import { DataDirSweeper, sweepOnce, getStorageUsage } from './dataDirSweeper'
import { encryptSecret } from './crypto'
import { mintInstallationToken, resolveRepoToken } from './githubApp'
import { isUrlMcpServer } from '../shared/mcp'
import { testPublishTarget, checkPublishTargetHealth } from './publisher'
import {
  listTriggers,
  getTrigger,
  createTrigger,
  updateTrigger,
  deleteTrigger,
} from '../main/db/queries/triggers'
import { TriggerService } from './triggers/triggerService'
import { createTriggerRoutes } from './triggers/triggerRoutes'
import { createMcpOAuthRouter } from './mcpOAuth/routes'
import { startAuth as mcpStartAuth, getStatus as mcpGetStatus, revoke as mcpRevoke, probeOAuthSupport as mcpProbe } from './mcpOAuth/service'
import { listMcpTools } from './mcpTools'
import { classifyUrlHealth, buildHealthProbeHeaders } from './mcpHealth'
import { getGithubPat } from './store'
import { readRunLog } from './utils'
import { Octokit } from '@octokit/rest'
import { createSession, sendMessageServer, closeSession } from './promptChatServer'
import { loadIpRestrictionsConfig, isIpAllowed, extractClientIp } from './ipRestrictions'
import { createIpRestrictionMiddleware } from './middleware/ipRestriction'
import { isAuthEnabled, DEV_CONTEXT, DEV_USER_ID } from './auth/config'
import { ClientError, isClientError } from './errors'
import { sessionMiddleware } from './auth/middleware'
import { authRouter as authRoutes } from './auth/routes'
import { ensureDevUser, getDevContext } from './auth/devBypass'
import { canAccessEntity, isEntityOwner } from '../main/db/queries/access'
import { deleteClient as deleteMcpOAuthClient } from '../main/db/queries/mcpOAuthClients'
import { deleteToken as deleteMcpOAuthToken } from '../main/db/queries/oauthTokens'
import { auditMcpOAuth } from './mcpOAuth/audit'
import { getShare, listShares, createShare, deleteShare } from '../main/db/queries/shares'
import { listUsers, searchUsers } from '../main/db/queries/users'
import { listGroups, getUserGroupIds } from '../main/db/queries/groups'
import { getCredentialStatus, setCredential } from '../main/db/queries/agentCredentials'
import { getRunnerTimeouts, setRunnerTimeout } from '../main/db/queries/runnerSettings'
import { deleteExpiredSessions } from '../main/db/queries/sessions'
import { resolveSession } from './auth/session'
import { deleteExpiredPendingAuth } from '../main/db/queries/mcpOAuthPending'
import { ensureLocalSecretKey } from './localSecret'
import type { ReporterUser } from '../shared/observability'
import type {
  AgentConfig,
  GlobalMcpServer,
  PublishTarget,
  RepositoryInput,
  RepoTestConnectionInput,
  RunnerType,
  Trigger,
  RequestContext,
  ShareableEntityType,
} from '../shared/types'

// Ensure a local encryption key exists for dev before anything touches crypto/DB.
ensureLocalSecretKey()

const PORT = process.env.PORT || 7456

const DATA_DIR = process.env.CONDUIT_DATA_DIR ?? path.join(os.homedir(), '.conduit')
fs.mkdirSync(DATA_DIR, { recursive: true })

const app = express()
const httpServer = createServer(app)

const wss = new WebSocketServer({ noServer: true })

const RENDERER_DIR = path.join(process.cwd(), 'out', 'renderer')

// ─── Health ───────────────────────────────────────────────────────────────────
// Registered before any other middleware so the probe never blocks on
// IP restrictions or DB connectivity issues.
app.get('/health', (_req, res) => {
  res.status(200).json({ status: 'ok' })
})

// Runtime config exposed to the browser (read at app boot).
// Lets the renderer initialise Sentry without baking the DSN into the bundle.
app.get('/api/runtime-config', (_req, res) => {
  res.status(200).json({
    sentryDsn: process.env.SENTRY_DSN ?? null,
    sentryEnvironment: process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV ?? null,
    sentryRelease: process.env.SENTRY_RELEASE ?? process.env.GIT_SHA ?? null,
    errorReporters: getReporterNames(),
  })
})

/**
 * Map a request's acting user onto the error-reporter user shape. `RequestContext`
 * only carries the user id (email/name aren't available here), so we attach the id.
 */
function contextToReporterUser(context: RequestContext): ReporterUser {
  return { id: context.userId }
}

// ─── IP Restrictions ──────────────────────────────────────────────────────────

const ipConfig = loadIpRestrictionsConfig(DATA_DIR)
if (ipConfig.enabled) {
  console.log(`[conduit] IP restrictions enabled. Allowed: ${ipConfig.allowedCidrs.join(', ')}`)
}

app.use(createIpRestrictionMiddleware(ipConfig))
app.use(cookieParser())

// Auth routes (login, callback, logout, me) — no session required
app.use('/auth', authRoutes)

// MCP OAuth callback route — must be before sessionMiddleware so the OAuth
// provider's redirect arrives without requiring a Conduit session cookie.
app.use('/mcp/oauth', createMcpOAuthRouter(broadcast))

// Serve the SPA shell + static assets WITHOUT requiring a session, so an
// unauthenticated browser can load the app and drive the Okta/OIDC login flow.
// (Data access is authenticated separately at the WebSocket upgrade, and /auth/me
// self-gates; the /api/* routes below stay behind sessionMiddleware.) Without
// this, unauthenticated requests to '/' returned 401 JSON and the app never
// loaded — showing a raw "Not authenticated" instead of the login page.
app.use(express.static(RENDERER_DIR))
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next()
  res.sendFile(path.join(RENDERER_DIR, 'index.html'))
})

// Session middleware — validates session cookie, attaches RequestContext to req.
// Guards the HTTP API routes registered after it.
app.use(sessionMiddleware)

// ─── Active clients ───────────────────────────────────────────────────────────

const clients = new Set<WebSocket>()

function broadcast(channel: string, payload: unknown): void {
  const msg = JSON.stringify({ type: 'event', channel, payload })
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(msg)
    }
  }
}

// ─── Trigger service ──────────────────────────────────────────────────────────

const triggerService = new TriggerService(broadcast)

// Inbound trigger HTTP endpoints. Registered before SPA catch-all but after triggerService.
app.use('/api/triggers', express.json({ limit: '1mb' }), createTriggerRoutes(triggerService))

// Express error-handling middleware — must be the LAST app.use so it catches
// errors from any preceding route/static handler. The 4-arg signature is what
// marks it as an error handler; it captures then forwards to Express's default.
app.use((err: unknown, req: express.Request, _res: express.Response, next: express.NextFunction) => {
  reporter.captureException(err, { tags: { path: req.path } })
  next(err)
})

// ─── Channel handlers ─────────────────────────────────────────────────────────

/**
 * Convert a client-facing repository payload into the persistence-layer shape:
 * the raw GitHub App private key (write-only) is encrypted into
 * `githubPrivateKeyEnc`. An absent/blank key is dropped so the stored key is
 * left untouched on update.
 */
function withEncryptedKey<T extends Partial<RepositoryInput>>(
  data: T
): Omit<T, 'githubPrivateKey'> & { githubPrivateKeyEnc?: string } {
  const { githubPrivateKey, ...rest } = data
  const result = { ...rest } as Omit<T, 'githubPrivateKey'> & { githubPrivateKeyEnc?: string }
  if (typeof githubPrivateKey === 'string' && githubPrivateKey.trim()) {
    result.githubPrivateKeyEnc = encryptSecret(githubPrivateKey.trim())
  }
  return result
}

/**
 * Resolve the credential token for a connection test. For GitHub App auth this
 * mints from the PEM supplied in the form, or — when none is supplied — falls
 * back to the key already stored for an existing repo.
 */
async function resolveTestToken(input: RepoTestConnectionInput): Promise<string | undefined> {
  switch (input.authMethod) {
    case 'pat':
      return getGithubPat()
    case 'githubapp':
      if (input.githubPrivateKey && input.githubPrivateKey.trim()) {
        if (!input.githubAppId) throw new Error('A GitHub App ID is required.')
        return mintInstallationToken({
          // Trim to match how the key is stored (encryptSecret trims) so a
          // successful test reflects the value that will actually be persisted.
          appId: input.githubAppId,
          privateKey: input.githubPrivateKey.trim(),
          repoUrl: input.url,
        })
      }
      if (input.repoId) {
        return resolveRepoToken({ id: input.repoId, url: input.url, authMethod: 'githubapp' })
      }
      throw new Error('Upload a GitHub App private key to test this connection.')
    default:
      return undefined
  }
}

type HandlerFn = (args: unknown[], ws: WebSocket, ctx: RequestContext) => Promise<unknown>

const handlers: Record<string, HandlerFn> = {
  // Agents
  'agents:list': (_args, _ws, ctx) => Promise.resolve(listAgents(ctx.userId, ctx.userGroupIds)),
  'agents:get': ([id]) => Promise.resolve(getAgent(id as string)),
  'agents:create': ([data], _ws, ctx) =>
    Promise.resolve(createAgent(data as Omit<AgentConfig, 'id' | 'createdAt' | 'updatedAt'>, ctx.userId)),
  'agents:update': async ([id, data], _ws, ctx) => {
    if (!(await canAccessEntity('agent', id as string, ctx.userId, ctx.userGroupIds))) {
      throw new Error('Access denied')
    }
    return Promise.resolve(
      updateAgent(
        id as string,
        data as Partial<Omit<AgentConfig, 'id' | 'createdAt' | 'updatedAt'>>
      )
    )
  },
  'agents:delete': async ([id], _ws, ctx) => {
    if (!(await isEntityOwner('agent', id as string, ctx.userId))) {
      throw new Error('Only the owner can delete this agent')
    }
    await deleteAgent(id as string)
    // Soft-delete leaves the agent's trigger rows intact, so stop their live cron
    // jobs now — otherwise they'd keep firing (harmlessly hitting the getAgent
    // guard) until the next restart, which skips them.
    for (const trigger of await listTriggers(id as string)) {
      triggerService.unregisterTrigger(trigger.id)
    }
    return Promise.resolve()
  },

  // Runs
  'runs:list': ([agentId]) => Promise.resolve(listRuns(agentId as string)),
  'runs:start': ([agentId], _ws, ctx) => startRunServer(agentId as string, broadcast, undefined, ctx.userId),
  'runs:stop': ([runId]) => stopRun(runId as string),
  'runs:getLog': ([runId]) => readRunLog(runId as string),

  // Global MCPs
  'globalMcps:list': (_args, _ws, ctx) => Promise.resolve(listGlobalMcps(ctx.userId, ctx.userGroupIds)),
  'globalMcps:create': ([data], _ws, ctx) =>
    Promise.resolve(
      createGlobalMcp(data as Omit<GlobalMcpServer, 'id' | 'createdAt' | 'updatedAt'>, ctx.userId)
    ),
  'globalMcps:update': async ([id, data], _ws, ctx) => {
    if (!(await canAccessEntity('globalMcpServer', id as string, ctx.userId, ctx.userGroupIds))) {
      throw new ClientError('Access denied')
    }
    return Promise.resolve(
      updateGlobalMcp(
        id as string,
        data as Partial<Omit<GlobalMcpServer, 'id' | 'createdAt' | 'updatedAt'>>
      )
    )
  },
  'globalMcps:delete': async ([id], _ws, ctx) => {
    const existing = await getGlobalMcp(id as string)
    if (!existing) throw new ClientError('MCP server not found')
    // Legacy single-user-mode globals have no real owner (null owner_id, or the
    // synthetic dev user). They're org-wide by nature (shared with everyone), so
    // any authenticated user may remove them; otherwise deletion is owner-only.
    const isLegacyGlobal = existing.ownerId == null || existing.ownerId === DEV_USER_ID
    if (
      !isLegacyGlobal &&
      !(await isEntityOwner('globalMcpServer', id as string, ctx.userId))
    ) {
      throw new ClientError('Only the owner can delete this MCP server')
    }
    const deleted = await deleteGlobalMcp(id as string)
    if (deleted === 0) throw new ClientError('MCP server not found')
    // Also clear any cached OAuth client + shared token for this server URL, so
    // recreating the server (the user's "delete to recreate" flow) registers a
    // fresh DCR client against the current redirect URI instead of reusing a
    // possibly-stale one keyed by the same URL.
    const cfg = existing.serverConfig
    if (isUrlMcpServer(cfg) && cfg.url) {
      await deleteMcpOAuthClient(cfg.url)
      await deleteMcpOAuthToken(cfg.url, '__global__')
      auditMcpOAuth('client_cleared_on_delete', { userId: ctx.userId, id, serverUrl: cfg.url })
    }
    auditMcpOAuth('global_mcp_deleted', { userId: ctx.userId, id, name: existing.name })
    return Promise.resolve()
  },

  'globalMcps:checkHealth': async ([serverConfig]) => {
    const config = serverConfig as import('../shared/types').McpServerEntry

    if (isUrlMcpServer(config) && config.url) {
      try {
        // Probe with a real MCP `initialize` handshake, not a bare GET. Streamable-
        // HTTP MCP servers (Linear/Sentry/Figma/…) reject a bare GET or `Accept: */*`
        // with 405 Method Not Allowed / 406 Not Acceptable — so once a valid token
        // gets past the 401, the probe would surface a misleading "Method Not
        // Allowed". A POST initialize with the streamable-HTTP Accept header is what
        // an actual MCP client sends: 200 when authenticated + usable, 401 when not.
        // Carry the user's own headers (a manual `Authorization: Bearer …`, or
        // Datadog-style DD-API-KEY headers) so the probe reflects real auth. A
        // resolved global OAuth token, when present, still overrides — matching
        // runtime injection precedence. Without this, a manually-authed server
        // always 401s here, reads as `unauthorized`, and wrongly kicks OAuth.
        let authOverride: string | undefined
        try {
          const { resolveGlobalMcpToken } = await import('../main/utils/mcp')
          const { normalizeTokenScheme } = await import('./mcpOAuth/flow')
          const token = await resolveGlobalMcpToken(config.url)
          if (token) authOverride = `${normalizeTokenScheme(token.tokenType)} ${token.accessToken}`
        } catch {
          // No token resolvable — fall through to the config's own headers.
        }
        const headers = buildHealthProbeHeaders(config.headers, authOverride)
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), 4000)
        const res = await fetch(config.url, {
          method: 'POST',
          signal: controller.signal,
          headers,
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: {
              protocolVersion: '2025-06-18',
              capabilities: {},
              clientInfo: { name: 'conduit-healthcheck', version: '1' },
            },
          }),
        })
        clearTimeout(timeout)
        return classifyUrlHealth(res.status, res.statusText)
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Connection failed'
        return { status: 'unhealthy', message: msg }
      }
    }

    const command = config.command ?? ''
    if (!command) return { status: 'unhealthy', message: 'No command configured' }

    try {
      const { execFileSync } = await import('child_process')
      // execFile (not exec) avoids shell interpretation of `command`.
      execFileSync('which', [command], { stdio: 'ignore' })
      return { status: 'healthy', message: `${command} found in PATH` }
    } catch {
      return { status: 'unhealthy', message: `${command} not found in PATH` }
    }
  },

  'runners:checkCli': async () => {
    const { execFile } = await import('child_process')
    const { promisify } = await import('util')
    const run = promisify(execFile)
    // Binary each runner shells out to (see server/runner.ts spawn). Cursor's
    // headless agent binary is `cursor-agent`.
    const RUNNER_BINARIES: Record<import('../shared/types').RunnerType, string> = {
      claude: 'claude',
      amp: 'amp',
      cursor: 'cursor-agent',
    }
    const runners = Object.keys(RUNNER_BINARIES) as import('../shared/types').RunnerType[]
    return Promise.all(
      runners.map(async (runner) => {
        const binary = RUNNER_BINARIES[runner]
        try {
          const { stdout } = await run('which', [binary])
          return { runner, binary, installed: true, path: stdout.trim() }
        } catch {
          return { runner, binary, installed: false }
        }
      })
    )
  },

  'globalMcps:listTools': async ([serverConfig]) => {
    let config = serverConfig as import('../shared/types').McpServerEntry
    // Inject the stored global OAuth token so tools load for authenticated
    // servers instead of 401ing on the initialize call.
    if (isUrlMcpServer(config) && config.url) {
      try {
        const { resolveGlobalMcpToken } = await import('../main/utils/mcp')
        const token = await resolveGlobalMcpToken(config.url)
        if (token) {
          config = { ...config, headers: { ...config.headers, Authorization: `${token.tokenType} ${token.accessToken}` } }
        }
      } catch {
        // No token — list unauthenticated (will surface the server's own error).
      }
    }
    return listMcpTools(config)
  },

  // Repositories
  'repos:list': (_args, _ws, ctx) => Promise.resolve(listRepositories(ctx.userId, ctx.userGroupIds)),
  'repos:get': ([id]) => Promise.resolve(getRepository(id as string)),
  'repos:create': async ([data], _ws, ctx) => {
    const repo = await createRepository(
      withEncryptedKey(data as RepositoryInput),
      ctx.userId
    )
    repoSyncService.triggerSync(repo.id).catch((err) =>
      console.error(`[server] Initial sync failed for repo ${repo.id}:`, err)
    )
    return repo
  },
  'repos:update': async ([id, data], _ws, ctx) => {
    if (!(await canAccessEntity('repository', id as string, ctx.userId, ctx.userGroupIds))) {
      throw new Error('Access denied')
    }
    // GitHub App credentials are sensitive secrets — only the owner may set or
    // change them, even though shared users can edit other repo fields.
    const input = data as Partial<RepositoryInput>
    if (
      (input.githubAppId !== undefined || input.githubPrivateKey !== undefined) &&
      !(await isEntityOwner('repository', id as string, ctx.userId))
    ) {
      throw new Error('Only the owner can change GitHub App credentials')
    }
    return Promise.resolve(updateRepository(id as string, withEncryptedKey(input)))
  },
  'repos:delete': async ([id], _ws, ctx) => {
    if (!(await isEntityOwner('repository', id as string, ctx.userId))) {
      throw new Error('Only the owner can delete this repository')
    }
    await deleteRepository(id as string)
    return Promise.resolve()
  },
  'repos:triggerSync': async ([id]) => {
    await repoSyncService.triggerSync(id as string)
  },
  'repos:testConnection': async ([data], _ws, ctx) => {
    const { testRepoConnection } = await import('./gitOps')
    const input = data as RepoTestConnectionInput
    // When testing against a stored key, ensure the caller can actually access
    // that repo — otherwise its credentials could be exercised by anyone.
    if (
      input.repoId &&
      !(await canAccessEntity('repository', input.repoId, ctx.userId, ctx.userGroupIds))
    ) {
      return { success: false, message: 'Access denied' }
    }
    try {
      const token = await resolveTestToken(input)
      const message = await testRepoConnection(input.url, token)
      return { success: true, message }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { success: false, message }
    }
  },

  // Publish Targets
  'publishTargets:list': (_args, _ws, ctx) => Promise.resolve(listPublishTargets(ctx.userId, ctx.userGroupIds)),
  'publishTargets:get': ([id]) => Promise.resolve(getPublishTarget(id as string)),
  'publishTargets:create': ([data], _ws, ctx) =>
    Promise.resolve(
      createPublishTarget(data as Omit<PublishTarget, 'id' | 'createdAt' | 'updatedAt'>, ctx.userId)
    ),
  'publishTargets:update': async ([id, data], _ws, ctx) => {
    if (!(await canAccessEntity('publishTarget', id as string, ctx.userId, ctx.userGroupIds))) {
      throw new Error('Access denied')
    }
    return Promise.resolve(
      updatePublishTarget(
        id as string,
        data as Partial<Omit<PublishTarget, 'id' | 'createdAt' | 'updatedAt'>>
      )
    )
  },
  'publishTargets:delete': async ([id], _ws, ctx) => {
    if (!(await isEntityOwner('publishTarget', id as string, ctx.userId))) {
      throw new Error('Only the owner can delete this publish target')
    }
    await deletePublishTarget(id as string)
    return Promise.resolve()
  },
  'publishTargets:test': ([type, config]) =>
    testPublishTarget(
      type as import('../shared/types').PublishTargetType,
      config as import('../shared/types').PublishConfig
    ),
  'publishTargets:checkHealth': ([type, config]) =>
    checkPublishTargetHealth(
      type as import('../shared/types').PublishTargetType,
      config as import('../shared/types').PublishConfig
    ),

  // Triggers
  'triggers:list': async ([agentId], _ws, ctx) => {
    if (!(await canAccessEntity('agent', agentId as string, ctx.userId, ctx.userGroupIds))) {
      throw new Error('Access denied')
    }
    return Promise.resolve(listTriggers(agentId as string))
  },
  'triggers:get': ([id]) => Promise.resolve(getTrigger(id as string)),
  'triggers:create': async ([data], _ws, ctx) => {
    const triggerData = data as Omit<Trigger, 'id' | 'createdAt' | 'updatedAt'>
    if (!(await canAccessEntity('agent', triggerData.agentId, ctx.userId, ctx.userGroupIds))) {
      throw new Error('Access denied')
    }
    const trigger = await createTrigger(triggerData)
    triggerService.registerTrigger(trigger)
    return trigger
  },
  'triggers:update': async ([id, data]) => {
    const trigger = await updateTrigger(
      id as string,
      data as Partial<Omit<Trigger, 'id' | 'createdAt' | 'updatedAt'>>
    )
    triggerService.registerTrigger(trigger)
    return trigger
  },
  'triggers:delete': async ([id]) => {
    triggerService.unregisterTrigger(id as string)
    await deleteTrigger(id as string)
  },

  // Gist
  'gist:save': async ([content, gistId]) => {
    const pat = getGithubPat()
    if (!pat) throw new Error('GitHub PAT not configured (set GITHUB_PAT env var)')
    const octokit = new Octokit({ auth: pat })

    if (gistId) {
      const response = await octokit.gists.update({
        gist_id: gistId as string,
        files: { 'prompt.md': { content: content as string } },
      })
      return response.data.id!
    } else {
      const response = await octokit.gists.create({
        description: 'Conduit agent prompt',
        public: false,
        files: { 'prompt.md': { content: content as string } },
      })
      return response.data.id!
    }
  },

  'gist:list': async () => {
    const pat = getGithubPat()
    if (!pat) throw new Error('GitHub PAT not configured (set GITHUB_PAT env var)')
    const octokit = new Octokit({ auth: pat })
    const response = await octokit.gists.list({ per_page: 100 })
    return response.data.map((g) => ({
      id: g.id,
      description: g.description ?? '',
      files: Object.fromEntries(
        Object.entries(g.files ?? {}).map(([name, f]) => [
          name,
          { filename: f?.filename ?? name, language: f?.language ?? null, size: f?.size ?? 0 },
        ])
      ),
      createdAt: g.created_at,
      updatedAt: g.updated_at,
      public: g.public,
      htmlUrl: g.html_url,
      isConduitPrompt: 'prompt.md' in (g.files ?? {}),
    }))
  },

  'gist:load': async ([gistId]) => {
    const pat = getGithubPat()
    if (!pat) throw new Error('GitHub PAT not configured (set GITHUB_PAT env var)')
    const octokit = new Octokit({ auth: pat })

    const response = await octokit.gists.get({ gist_id: gistId as string })
    const file = response.data.files?.['prompt.md']

    if (!file) {
      throw new Error(`Gist ${String(gistId)} does not contain a prompt.md file`)
    }

    return file.content ?? ''
  },

  // Preferences — read-only via env vars in server mode.
  'prefs:get': ([key]) => {
    if (key === 'githubPat') return Promise.resolve(getGithubPat() ?? null)
    return Promise.resolve(null)
  },
  'prefs:set': () => {
    throw new Error(
      'prefs:set is disabled in server mode — configure secrets via environment variables (e.g. via ESO + AWS Secrets Manager).'
    )
  },

  // Agent credentials — per-user API keys/tokens for the runner CLIs, encrypted
  // at rest and injected into the runner process env at launch.
  'agentCreds:getStatus': (_args, _ws, ctx) => getCredentialStatus(ctx.userId),
  'agentCreds:set': ([runner, value], _ws, ctx) =>
    setCredential(ctx.userId, runner as RunnerType, (value as string) ?? '').then(() => undefined),

  // Per-user, per-runner background-task timeout (seconds; 0 = run indefinitely).
  'runnerSettings:getTimeouts': (_args, _ws, ctx) => getRunnerTimeouts(ctx.userId),
  'runnerSettings:setTimeout': ([runner, seconds], _ws, ctx) =>
    setRunnerTimeout(ctx.userId, runner as RunnerType, Number(seconds) || 0).then(() => undefined),

  // Data-directory maintenance — run the sweeper on demand from Settings. Safe
  // for any authenticated user: it only removes artifacts of runs that are not
  // currently executing on this pod.
  'maintenance:sweep': () => sweepOnce(),
  'maintenance:storageUsage': () => getStorageUsage(),

  'shell:openExternal': ([url]) => Promise.resolve({ url }),

  // Prompt Chat
  'promptChat:start': ([agentId, runner]) =>
    createSession(agentId as string, runner as RunnerType),
  'promptChat:send': ([sessionId, message], ws) => {
    function clientBroadcast(channel: string, payload: unknown): void {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'event', channel, payload }))
      }
    }
    return sendMessageServer(sessionId as string, message as string, clientBroadcast)
  },
  'promptChat:close': ([sessionId]) => {
    closeSession(sessionId as string)
    return Promise.resolve()
  },

  // Shares
  'shares:list': async ([entityType, entityId], _ws, ctx) => {
    if (!(await canAccessEntity(entityType as ShareableEntityType, entityId as string, ctx.userId, ctx.userGroupIds))) {
      throw new Error('Access denied')
    }
    return Promise.resolve(listShares(entityType as ShareableEntityType, entityId as string))
  },
  'shares:create': async ([data], _ws, ctx) => {
    const { entityType, entityId, targetType, targetId } = data as {
      entityType: ShareableEntityType; entityId: string;
      targetType: 'user' | 'group' | 'everyone'; targetId?: string
    }
    if (!(await isEntityOwner(entityType, entityId, ctx.userId))) {
      throw new Error('Only the owner can share this entity')
    }
    const share = await createShare({ entityType, entityId, targetType, targetId, createdBy: ctx.userId })
    broadcast('share:changed', { entityType, entityId })
    return share
  },
  'shares:delete': async ([shareId], _ws, ctx) => {
    const share = await getShare(shareId as string)
    if (!share) throw new Error('Share not found')
    if (!(await isEntityOwner(share.entityType, share.entityId, ctx.userId))) {
      throw new Error('Only the owner can modify shares')
    }
    await deleteShare(shareId as string)
    broadcast('share:changed', { entityType: share.entityType, entityId: share.entityId })
  },

  // Users — use Okta Management API when available, fall back to local DB
  'users:list': () => Promise.resolve(listUsers()),
  'users:search': async ([query]) => {
    if (isAuthEnabled()) {
      const { searchOktaUsers } = await import('./auth/okta')
      const oktaResults = await searchOktaUsers(query as string)
      if (oktaResults.length > 0) return oktaResults
    }
    return searchUsers(query as string)
  },

  // Groups
  'groups:list': () => Promise.resolve(listGroups()),

  // MCP OAuth
  'mcp:oauth:startAuth': ([serverId, isGlobal, redirectOrigin], _ws, ctx) =>
    mcpStartAuth(serverId as string, isGlobal as boolean, ctx.userId, ctx.userGroupIds, redirectOrigin as string | undefined),
  'mcp:oauth:getStatus': ([serverId, isGlobal], _ws, ctx) =>
    mcpGetStatus(serverId as string, isGlobal as boolean, ctx.userId, ctx.userGroupIds),
  'mcp:oauth:revoke': ([serverId, isGlobal], _ws, ctx) =>
    mcpRevoke(serverId as string, isGlobal as boolean, ctx.userId, ctx.userGroupIds),
  'mcp:oauth:probe': ([serverConfig]) => mcpProbe(serverConfig as import('../shared/types').McpServerEntry),
}

// ─── WebSocket ────────────────────────────────────────────────────────────────

// Store auth context per WebSocket connection
const wsContextMap = new WeakMap<WebSocket, RequestContext>()
// Track the session id + last-validated time per authenticated socket so a live
// connection can be re-checked (and its token refreshed) while it stays open,
// instead of trusting the context captured once at upgrade time forever.
const wsSessionMap = new WeakMap<WebSocket, { sessionId: string; lastValidated: number }>()
// Re-validate a live connection's session at most this often (throttled per socket).
const WS_REVALIDATE_INTERVAL_MS = 30_000

wss.on('connection', (ws, req) => {
  clients.add(ws)

  // Attach auth context from the upgrade request
  const ctx = (req as any).__conduitContext as RequestContext | undefined
  if (ctx) {
    wsContextMap.set(ws, ctx)
  }
  const sessionId = (req as any).__conduitSessionId as string | undefined
  if (sessionId) {
    wsSessionMap.set(ws, { sessionId, lastValidated: Date.now() })
  }

  ws.on('message', async (raw) => {
    let msg: { type: string; id: string; channel: string; args?: unknown[] }
    try {
      msg = JSON.parse(raw.toString())
    } catch {
      return
    }

    if (msg.type !== 'invoke') return

    // Re-validate the session on live connections (auth mode only), throttled so
    // we don't hit the DB on every message. resolveSession refreshes the Okta
    // token when it is near expiry — keeping an active session alive — and
    // returns null only when the session is truly dead. In that case we tell the
    // client and close with 4401, which the browser client maps to a redirect to
    // the login page (no manual refresh needed).
    if (isAuthEnabled()) {
      const meta = wsSessionMap.get(ws)
      if (meta && Date.now() - meta.lastValidated > WS_REVALIDATE_INTERVAL_MS) {
        const session = await resolveSession(meta.sessionId)
        if (!session) {
          ws.send(JSON.stringify({ type: 'error', id: msg.id, error: 'Session expired' }))
          ws.close(4401, 'session expired')
          return
        }
        meta.lastValidated = Date.now()
      }
    }

    const handler = handlers[msg.channel]
    if (!handler) {
      ws.send(
        JSON.stringify({ type: 'error', id: msg.id, error: `Unknown channel: ${msg.channel}` })
      )
      return
    }

    // Get context — fall back to dev context if not set (shouldn't happen, but safe)
    const context = wsContextMap.get(ws) ?? DEV_CONTEXT

    try {
      const result = await handler(msg.args ?? [], ws, context)
      ws.send(JSON.stringify({ type: 'response', id: msg.id, result }))
    } catch (err: unknown) {
      // Expected business-rule rejections (access denied, not found, validation)
      // are surfaced to the client but not reported as faults — they're normal.
      if (!isClientError(err)) {
        reporter.captureException(err, {
          tags: { channel: msg.channel },
          user: contextToReporterUser(context),
        })
      }
      const message = err instanceof Error ? err.message : String(err)
      ws.send(JSON.stringify({ type: 'error', id: msg.id, error: message }))
    }
  })

  ws.on('close', () => {
    clients.delete(ws)
  })
})

// Only upgrade /ws path to WebSocket — leave all other HTTP routes alone
httpServer.on('upgrade', async (req, socket, head) => {
  if (req.url === '/ws') {
    const clientIp = extractClientIp(
      req.socket.remoteAddress,
      req.headers as Record<string, string | string[] | undefined>
    )
    if (!isIpAllowed(clientIp, ipConfig)) {
      console.warn(`[conduit] Blocked WebSocket from ${clientIp}`)
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
      socket.destroy()
      return
    }

    // Authenticate the WebSocket upgrade
    let ctx: RequestContext
    if (!isAuthEnabled()) {
      ctx = getDevContext()
    } else {
      // Parse session cookie from upgrade request headers
      const cookieHeader = req.headers.cookie || ''
      const cookies = Object.fromEntries(
        cookieHeader.split(';').map(c => {
          const [k, ...v] = c.trim().split('=')
          return [k, v.join('=')]
        })
      )
      const sessionId = cookies['conduit_session']
      if (!sessionId) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
        socket.destroy()
        return
      }
      const session = await resolveSession(sessionId)
      if (!session) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
        socket.destroy()
        return
      }
      const userGroupIds = await getUserGroupIds(session.userId)
      ctx = { userId: session.userId, userGroupIds }
      // Remember the session id so the live connection can be re-validated
      // (and its token refreshed) as it stays open — see the message handler.
      ;(req as any).__conduitSessionId = sessionId
    }

    // Attach context to the request for the connection handler
    ;(req as any).__conduitContext = ctx

    wss.handleUpgrade(req, socket as import('net').Socket, head, (ws) => {
      wss.emit('connection', ws, req)
    })
  } else {
    socket.destroy()
  }
})

// ─── Startup ──────────────────────────────────────────────────────────────────

// Repository sync service — module-scoped so request handlers can reach it.
const repoSyncService = new RepoSyncService(broadcast)

// Data-directory sweeper — periodically reclaims disk from finished/stopped runs
// (orphaned worktrees, temp workspaces, MCP configs) and owns startup cleanup.
const dataDirSweeper = new DataDirSweeper()

// RDS run-event bus — LISTENs on Postgres NOTIFY and re-broadcasts a run-pod's
// events to this replica's WebSocket clients (P3 eventing contract). Inert for
// in-process runs (they broadcast directly and don't notify); wired now so
// flipping CONDUIT_EXECUTOR=job needs no further control-plane changes.
const runEventBus = new RunEventBus(broadcast)

async function start(): Promise<void> {
  // Initialise the Postgres database (creates tables if they don't exist)
  await initDb()

  // Ensure dev user exists for FK integrity
  if (!isAuthEnabled()) {
    await ensureDevUser()
    console.log('[server] Auth disabled — running in dev bypass mode')
  } else {
    // Initialize OIDC client asynchronously
    import('./auth/okta').then(({ initOidcClient }) =>
      initOidcClient().catch((err: unknown) =>
        console.error('[server] Failed to initialize OIDC client:', err)
      )
    )
    console.log('[server] Auth enabled — Okta OIDC configured')
  }

  // Mark any runs that were left in "running" state as failed (server restart).
  // A run in this state means the previous process exited mid-run (deploy, crash,
  // OOM, or disk-pressure eviction) so its `child.on('close')` handler never ran —
  // which is exactly why such failures were invisible. Capture it so the operator
  // gets a signal (with the affected run IDs) instead of a silent DB flip.
  const orphaned = await getOrphanedRuns()
  for (const run of orphaned) {
    await updateRun(run.id, { status: 'failed', endedAt: Date.now() })
    // Leave a trace in the run's own log so its transcript explains why it
    // stopped, instead of just ending mid-output (the "quiet death").
    appendRunLog(
      run.id,
      '✗ Run did not finish — the Conduit process exited mid-run (deploy, crash, ' +
        'out-of-memory, or disk-pressure eviction). Marked failed on restart.'
    )
  }
  if (orphaned.length > 0) {
    console.log(`[server] Marked ${orphaned.length} orphaned run(s) as failed`)
    reporter.captureMessage(
      `Marked ${orphaned.length} orphaned run(s) as failed on startup — the previous Conduit ` +
        `process exited mid-run (deploy, crash, OOM, or disk-pressure eviction).`,
      'warning',
      {
        tags: { component: 'server', op: 'orphanReconcile' },
        extra: { count: orphaned.length, runIds: orphaned.map((r) => r.id) },
      }
    )
  }

  // Start the repository sync service (clones new repos, fetches existing ones)
  repoSyncService.start()

  // Start the data-directory sweeper (immediate cleanup + periodic sweep), and
  // also sweep after every run finishes so disk is reclaimed promptly. Sweeps
  // coalesce, so the per-finish trigger can't pile up.
  dataDirSweeper.start()
  setRunFinalizedHook(() => {
    sweepOnce().catch((err) =>
      reporter.captureException(err, { tags: { component: 'dataDirSweeper', op: 'postRun' } })
    )
  })

  // Start the RDS run-event bus (LISTEN run_events → re-broadcast). Best-effort:
  // it self-reconnects, so a transient DB hiccup here never blocks startup.
  runEventBus.start().catch((err) =>
    reporter.captureException(err, { tags: { component: 'runEventBus', op: 'start' } })
  )

  // Sample memory pressure so an impending OOM — which kills the whole process
  // mid-run and leaves runs "quietly" dead — is surfaced as a warning + breadcrumbs
  // ahead of the kill, rather than only reconciled as failed on the next startup.
  const stopMemoryMonitor = startMemoryMonitor()

  // Start the trigger service (registers cron jobs from DB)
  await triggerService.start()

  // Periodic session cleanup (every hour)
  if (isAuthEnabled()) {
    setInterval(() => {
      deleteExpiredSessions()
        .then((count) => {
          if (count > 0) {
            console.log(`[server] Cleaned up ${count} expired session(s)`)
          }
        })
        .catch((err) => console.error('[server] Session cleanup failed:', err))
    }, 60 * 60 * 1000)
  }

  // Periodic cleanup of expired pending OAuth state (hourly), regardless of auth
  // mode — MCP OAuth is available in dev too. Consumed rows are already deleted;
  // this only sweeps abandoned flows.
  setInterval(() => {
    deleteExpiredPendingAuth().catch((err) =>
      console.error('[server] Pending OAuth cleanup failed:', err)
    )
  }, 60 * 60 * 1000)

  // MCP OAuth redirect URIs must be byte-stable across the register→authorize→token
  // steps or providers reject them ("Mismatching redirect URI" — e.g. Datadog).
  // Without CONDUIT_BASE_URL the redirect is derived from the (variable) browser
  // origin, which breaks behind a load balancer / multiple hostnames. Warn loudly
  // in deployed (auth-enabled) mode so it isn't silently misconfigured.
  if (isAuthEnabled() && !process.env.CONDUIT_BASE_URL) {
    console.warn(
      '[conduit] WARNING: CONDUIT_BASE_URL is not set. MCP OAuth redirect URIs will be ' +
        'derived from the browser origin and may be unstable, causing "Mismatching redirect URI" ' +
        'errors (e.g. Datadog). Set CONDUIT_BASE_URL to the public base URL in production.'
    )
  }

  httpServer.listen(PORT, () => {
    console.log(`Conduit server running at http://localhost:${PORT}`)
  })

  // Graceful shutdown. K8s sends SIGTERM and waits up to
  // terminationGracePeriodSeconds (default 30s) before SIGKILL.
  let shuttingDown = false
  const shutdown = async (signal: string) => {
    if (shuttingDown) return
    shuttingDown = true
    console.log(`[server] Received ${signal}, draining…`)
    httpServer.close(() => console.log('[server] HTTP server closed'))
    for (const ws of clients) ws.close(1001, 'Server shutting down')
    triggerService.stop()
    repoSyncService.stop()
    dataDirSweeper.stop()
    runEventBus.stop()
    stopMemoryMonitor()
    // Flush buffered error events so shutdown-time reports are delivered.
    await reporter.flush(2000).catch(() => {})
    // Give in-flight requests up to 10s to finish, then exit.
    setTimeout(() => process.exit(0), 10_000).unref()
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
}

// Global safety nets for process-level errors that escape all other handlers.
// These are our generic capture path (not Sentry's built-in integrations, which
// are disabled in sentryReporter.ts) so every configured provider sees them.
// We always console.error first, so diagnostics survive even when no reporter is
// configured (empty composite) — matching Node's default stderr behaviour.
process.on('unhandledRejection', (reason) => {
  console.error('[server] Unhandled promise rejection:', reason)
  reporter.captureException(reason, { tags: { kind: 'unhandledRejection' } })
})
process.on('uncaughtException', (err) => {
  console.error('[server] Uncaught exception:', err)
  reporter.captureException(err, { tags: { kind: 'uncaughtException' } })
  // Flush best-effort, then exit non-zero regardless of flush outcome. Guard the
  // promise so a rejecting flush can't itself become an unhandledRejection.
  reporter
    .flush(2000)
    .catch(() => {})
    .finally(() => process.exit(1))
})

start().catch((err) => {
  console.error('[server] Startup failed:', err)
  reporter.captureException(err, { tags: { phase: 'startup' } })
  process.exit(1)
})
