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
import { startRunServer, stopRun } from './runner'
import {
  listGlobalMcps,
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
import { testPublishTarget } from './publisher'
import {
  listTriggers,
  getTrigger,
  createTrigger,
  updateTrigger,
  deleteTrigger,
} from '../main/db/queries/triggers'
import { TriggerService } from './triggers/triggerService'
import { createTriggerRoutes } from './triggers/triggerRoutes'
import { listMcpTools } from './mcpTools'
import { getGithubPat, setGithubPat, serverStoreGet, serverStoreSet } from './store'
import { readLogFile } from './utils'
import { Octokit } from '@octokit/rest'
import { createSession, sendMessageServer, closeSession } from './promptChatServer'
import { loadIpRestrictionsConfig, isIpAllowed, extractClientIp } from './ipRestrictions'
import { createIpRestrictionMiddleware } from './middleware/ipRestriction'
import { isAuthEnabled, DEV_CONTEXT } from './auth/config'
import { sessionMiddleware } from './auth/middleware'
import { authRouter as authRoutes } from './auth/routes'
import { ensureDevUser, getDevContext } from './auth/devBypass'
import { canAccessEntity, isEntityOwner } from '../main/db/queries/access'
import { getShare, listShares, createShare, deleteShare } from '../main/db/queries/shares'
import { listUsers, searchUsers } from '../main/db/queries/users'
import { listGroups, getUserGroupIds } from '../main/db/queries/groups'
import { getSession as getDbSession, deleteExpiredSessions } from '../main/db/queries/sessions'
import type {
  AgentConfig,
  GlobalMcpServer,
  PublishTarget,
  Repository,
  RunnerType,
  SlackPublishConfig,
  Trigger,
  RequestContext,
  ShareableEntityType,
} from '../shared/types'

const PORT = process.env.PORT || 7456

const DATA_DIR = process.env.CONDUIT_DATA_DIR ?? path.join(os.homedir(), '.conduit')
// Ensure it exists
fs.mkdirSync(DATA_DIR, { recursive: true })

const app = express()
const httpServer = createServer(app)

// WebSocket server — not attached directly to httpServer so we can restrict
// upgrades to the /ws path only.
const wss = new WebSocketServer({ noServer: true })

// Serve the built renderer static files.
// Use process.cwd() so this resolves correctly whether running via:
//   - tsx src/server/index.ts  (__dirname = src/server/)
//   - node out/server/index.js (__dirname = out/server/)
const RENDERER_DIR = path.join(process.cwd(), 'out', 'renderer')

// ─── IP Restrictions ──────────────────────────────────────────────────────────

const ipConfig = loadIpRestrictionsConfig(DATA_DIR)
if (ipConfig.enabled) {
  console.log(`[conduit] IP restrictions enabled. Allowed: ${ipConfig.allowedCidrs.join(', ')}`)
}

app.use(createIpRestrictionMiddleware(ipConfig))
app.use(cookieParser())

// Auth routes (login, callback, logout, me) — no session required
app.use('/auth', authRoutes)

// Session middleware — validates session cookie, attaches RequestContext to req
app.use(sessionMiddleware)

app.use(express.static(RENDERER_DIR))
// SPA fallback — all non-API routes serve index.html
app.get('*', (_req, res) => {
  res.sendFile(path.join(RENDERER_DIR, 'index.html'))
})

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

// Inbound trigger HTTP endpoints (must be registered before SPA catch-all but after triggerService)
// Express registers middleware in order, and our catch-all is app.get('*') which only matches GET,
// so POST routes registered here will work correctly.
app.use('/api/triggers', express.json({ limit: '1mb' }), createTriggerRoutes(triggerService))

// ─── Channel handlers ─────────────────────────────────────────────────────────

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
    return Promise.resolve()
  },

  // Runs
  'runs:list': ([agentId]) => Promise.resolve(listRuns(agentId as string)),
  'runs:start': ([agentId], _ws, ctx) => startRunServer(agentId as string, broadcast, undefined, ctx.userId),
  'runs:stop': ([runId]) => stopRun(runId as string),
  'runs:getLog': ([runId]) => Promise.resolve(readLogFile(runId as string)),

  // Global MCPs
  'globalMcps:list': (_args, _ws, ctx) => Promise.resolve(listGlobalMcps(ctx.userId, ctx.userGroupIds)),
  'globalMcps:create': ([data], _ws, ctx) =>
    Promise.resolve(
      createGlobalMcp(data as Omit<GlobalMcpServer, 'id' | 'createdAt' | 'updatedAt'>, ctx.userId)
    ),
  'globalMcps:update': async ([id, data], _ws, ctx) => {
    if (!(await canAccessEntity('globalMcpServer', id as string, ctx.userId, ctx.userGroupIds))) {
      throw new Error('Access denied')
    }
    return Promise.resolve(
      updateGlobalMcp(
        id as string,
        data as Partial<Omit<GlobalMcpServer, 'id' | 'createdAt' | 'updatedAt'>>
      )
    )
  },
  'globalMcps:delete': async ([id], _ws, ctx) => {
    if (!(await isEntityOwner('globalMcpServer', id as string, ctx.userId))) {
      throw new Error('Only the owner can delete this MCP server')
    }
    await deleteGlobalMcp(id as string)
    return Promise.resolve()
  },

  'globalMcps:checkHealth': async ([serverConfig]) => {
    const config = serverConfig as import('../shared/types').McpServerEntry
    const isUrl = config.type === 'url' || !!config.url

    if (isUrl && config.url) {
      try {
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), 4000)
        const res = await fetch(config.url, {
          method: 'GET',
          signal: controller.signal,
          headers: { Accept: '*/*' },
        })
        clearTimeout(timeout)
        return { status: 'healthy', message: `HTTP ${res.status} ${res.statusText}` }
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Connection failed'
        return { status: 'unhealthy', message: msg }
      }
    }

    // stdio type — check whether the command binary is available
    const command = config.command ?? ''
    if (!command) return { status: 'unhealthy', message: 'No command configured' }

    try {
      const { execSync } = await import('child_process')
      execSync(`which ${command}`, { stdio: 'ignore' })
      return { status: 'healthy', message: `${command} found in PATH` }
    } catch {
      return { status: 'unhealthy', message: `${command} not found in PATH` }
    }
  },

  'globalMcps:listTools': async ([serverConfig]) => {
    return listMcpTools(serverConfig as import('../shared/types').McpServerEntry)
  },

  // Repositories
  'repos:list': (_args, _ws, ctx) => Promise.resolve(listRepositories(ctx.userId, ctx.userGroupIds)),
  'repos:get': ([id]) => Promise.resolve(getRepository(id as string)),
  'repos:create': async ([data], _ws, ctx) => {
    const repo = await createRepository(
      data as Omit<Repository, 'id' | 'createdAt' | 'updatedAt' | 'syncStatus' | 'clonePath'>,
      ctx.userId
    )
    // Trigger initial clone asynchronously
    repoSyncService.triggerSync(repo.id).catch((err) =>
      console.error(`[server] Initial sync failed for repo ${repo.id}:`, err)
    )
    return repo
  },
  'repos:update': async ([id, data], _ws, ctx) => {
    if (!(await canAccessEntity('repository', id as string, ctx.userId, ctx.userGroupIds))) {
      throw new Error('Access denied')
    }
    return Promise.resolve(
      updateRepository(
        id as string,
        data as Partial<Omit<Repository, 'id' | 'createdAt' | 'updatedAt'>>
      )
    )
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
  'repos:testConnection': async ([data]) => {
    const { testRepoConnection } = await import('./gitOps')
    const { url, authMethod } = data as { url: string; authMethod: 'none' | 'pat' | 'ssh' }
    const pat = authMethod === 'pat' ? getGithubPat() : undefined
    try {
      const message = await testRepoConnection(url, pat)
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
    testPublishTarget(type as import('../shared/types').PublishTargetType, config as import('../shared/types').PublishConfig),

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
    if (!pat) throw new Error('GitHub PAT not configured')
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
    if (!pat) throw new Error('GitHub PAT not configured')
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
    if (!pat) throw new Error('GitHub PAT not configured')
    const octokit = new Octokit({ auth: pat })

    const response = await octokit.gists.get({ gist_id: gistId as string })
    const file = response.data.files?.['prompt.md']

    if (!file) {
      throw new Error(`Gist ${String(gistId)} does not contain a prompt.md file`)
    }

    return file.content ?? ''
  },

  // Preferences — special-case githubPat to use the server store's PAT helpers
  'prefs:get': ([key]) => {
    if (key === 'githubPat') {
      return Promise.resolve(getGithubPat())
    }
    return Promise.resolve(serverStoreGet(key as string))
  },
  'prefs:set': ([key, value]) => {
    if (key === 'githubPat') {
      if (typeof value === 'string') setGithubPat(value)
    } else {
      serverStoreSet(key as string, value)
    }
    return Promise.resolve()
  },

  // Shell — cannot open a browser from the server; return the URL so the client
  // can handle it (the ws-client polyfill calls window.open directly anyway).
  'shell:openExternal': ([url]) => Promise.resolve({ url }),

  // Prompt Chat
  'promptChat:start': ([agentId, runner]) =>
    createSession(agentId as string, runner as RunnerType),
  'promptChat:send': ([sessionId, message], ws) => {
    // We need a per-client broadcast so only this ws receives the streaming events
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
}

// ─── WebSocket ────────────────────────────────────────────────────────────────

// Store auth context per WebSocket connection
const wsContextMap = new WeakMap<WebSocket, RequestContext>()

wss.on('connection', (ws, req) => {
  clients.add(ws)

  // Attach auth context from the upgrade request
  const ctx = (req as any).__conduitContext as RequestContext | undefined
  if (ctx) {
    wsContextMap.set(ws, ctx)
  }

  ws.on('message', async (raw) => {
    let msg: { type: string; id: string; channel: string; args?: unknown[] }
    try {
      msg = JSON.parse(raw.toString())
    } catch {
      return // Ignore malformed frames
    }

    if (msg.type !== 'invoke') return

    const handler = handlers[msg.channel]
    if (!handler) {
      ws.send(
        JSON.stringify({
          type: 'error',
          id: msg.id,
          error: `Unknown channel: ${msg.channel}`,
        })
      )
      return
    }

    // Get context — fall back to dev context if not set (shouldn't happen, but safe)
    const context = wsContextMap.get(ws) ?? DEV_CONTEXT

    try {
      const result = await handler(msg.args ?? [], ws, context)
      ws.send(JSON.stringify({ type: 'response', id: msg.id, result }))
    } catch (err: unknown) {
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
    const clientIp = extractClientIp(req.socket.remoteAddress, req.headers as any)
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
      const session = await getDbSession(sessionId)
      if (!session || session.expiresAt < Date.now()) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
        socket.destroy()
        return
      }
      const userGroupIds = await getUserGroupIds(session.userId)
      ctx = { userId: session.userId, userGroupIds }
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

  // Mark any runs that were left in "running" state as failed (server restart)
  const orphaned = await getOrphanedRuns()
  for (const run of orphaned) {
    await updateRun(run.id, { status: 'failed', endedAt: Date.now() })
  }
  if (orphaned.length > 0) {
    console.log(`[server] Marked ${orphaned.length} orphaned run(s) as failed`)
  }

  // Start the repository sync service (clones new repos, fetches existing ones)
  repoSyncService.start()

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

  httpServer.listen(PORT, () => {
    console.log(`Conduit server running at http://localhost:${PORT}`)
  })
}

start().catch((err) => {
  console.error('[server] Startup failed:', err)
  process.exit(1)
})
