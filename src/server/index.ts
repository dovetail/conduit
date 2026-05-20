import * as Sentry from '@sentry/node'

// Initialise Sentry as early as possible so it captures startup errors.
if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV ?? 'production',
    release: process.env.SENTRY_RELEASE ?? process.env.GIT_SHA,
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? 0),
  })
}

import express from 'express'
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
import { getGithubPat } from './store'
import { readLogFile } from './utils'
import { Octokit } from '@octokit/rest'
import { createSession, sendMessageServer, closeSession } from './promptChatServer'
import { loadIpRestrictionsConfig, isIpAllowed, extractClientIp } from './ipRestrictions'
import { createIpRestrictionMiddleware } from './middleware/ipRestriction'
import type {
  AgentConfig,
  GlobalMcpServer,
  PublishTarget,
  Repository,
  RunnerType,
  Trigger,
} from '../shared/types'

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
  })
})

// ─── IP Restrictions ──────────────────────────────────────────────────────────

const ipConfig = loadIpRestrictionsConfig(DATA_DIR)
if (ipConfig.enabled) {
  console.log(`[conduit] IP restrictions enabled. Allowed: ${ipConfig.allowedCidrs.join(', ')}`)
}

app.use(createIpRestrictionMiddleware(ipConfig))

app.use(express.static(RENDERER_DIR))

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

// SPA fallback — all other GETs serve index.html
app.get('*', (_req, res) => {
  res.sendFile(path.join(RENDERER_DIR, 'index.html'))
})

// ─── Channel handlers ─────────────────────────────────────────────────────────

type HandlerFn = (args: unknown[], ws: WebSocket) => Promise<unknown>

const handlers: Record<string, HandlerFn> = {
  // Agents
  'agents:list': () => listAgents(),
  'agents:get': ([id]) => getAgent(id as string),
  'agents:create': ([data]) =>
    createAgent(data as Omit<AgentConfig, 'id' | 'createdAt' | 'updatedAt'>),
  'agents:update': ([id, data]) =>
    updateAgent(
      id as string,
      data as Partial<Omit<AgentConfig, 'id' | 'createdAt' | 'updatedAt'>>
    ),
  'agents:delete': async ([id]) => {
    await deleteAgent(id as string)
  },

  // Runs
  'runs:list': ([agentId]) => listRuns(agentId as string),
  'runs:start': ([agentId]) => startRunServer(agentId as string, broadcast),
  'runs:stop': ([runId]) => stopRun(runId as string),
  'runs:getLog': ([runId]) => Promise.resolve(readLogFile(runId as string)),

  // Global MCPs
  'globalMcps:list': () => listGlobalMcps(),
  'globalMcps:create': ([data]) =>
    createGlobalMcp(data as Omit<GlobalMcpServer, 'id' | 'createdAt' | 'updatedAt'>),
  'globalMcps:update': ([id, data]) =>
    updateGlobalMcp(
      id as string,
      data as Partial<Omit<GlobalMcpServer, 'id' | 'createdAt' | 'updatedAt'>>
    ),
  'globalMcps:delete': async ([id]) => {
    await deleteGlobalMcp(id as string)
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

  'globalMcps:listTools': async ([serverConfig]) => {
    return listMcpTools(serverConfig as import('../shared/types').McpServerEntry)
  },

  // Repositories
  'repos:list': () => listRepositories(),
  'repos:get': ([id]) => getRepository(id as string),
  'repos:create': async ([data]) => {
    const repo = await createRepository(
      data as Omit<Repository, 'id' | 'createdAt' | 'updatedAt' | 'syncStatus' | 'clonePath'>
    )
    repoSyncService.triggerSync(repo.id).catch((err) =>
      console.error(`[server] Initial sync failed for repo ${repo.id}:`, err)
    )
    return repo
  },
  'repos:update': ([id, data]) =>
    updateRepository(
      id as string,
      data as Partial<Omit<Repository, 'id' | 'createdAt' | 'updatedAt'>>
    ),
  'repos:delete': async ([id]) => {
    await deleteRepository(id as string)
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
  'publishTargets:list': () => listPublishTargets(),
  'publishTargets:get': ([id]) => getPublishTarget(id as string),
  'publishTargets:create': ([data]) =>
    createPublishTarget(data as Omit<PublishTarget, 'id' | 'createdAt' | 'updatedAt'>),
  'publishTargets:update': ([id, data]) =>
    updatePublishTarget(
      id as string,
      data as Partial<Omit<PublishTarget, 'id' | 'createdAt' | 'updatedAt'>>
    ),
  'publishTargets:delete': async ([id]) => {
    await deletePublishTarget(id as string)
  },
  'publishTargets:test': ([type, config]) =>
    testPublishTarget(
      type as import('../shared/types').PublishTargetType,
      config as import('../shared/types').PublishConfig
    ),

  // Triggers
  'triggers:list': ([agentId]) => listTriggers(agentId as string),
  'triggers:get': ([id]) => getTrigger(id as string),
  'triggers:create': async ([data]) => {
    const trigger = await createTrigger(data as Omit<Trigger, 'id' | 'createdAt' | 'updatedAt'>)
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
}

// ─── WebSocket ────────────────────────────────────────────────────────────────

wss.on('connection', (ws) => {
  clients.add(ws)

  ws.on('message', async (raw) => {
    let msg: { type: string; id: string; channel: string; args?: unknown[] }
    try {
      msg = JSON.parse(raw.toString())
    } catch {
      return
    }

    if (msg.type !== 'invoke') return

    const handler = handlers[msg.channel]
    if (!handler) {
      ws.send(
        JSON.stringify({ type: 'error', id: msg.id, error: `Unknown channel: ${msg.channel}` })
      )
      return
    }

    try {
      const result = await handler(msg.args ?? [], ws)
      ws.send(JSON.stringify({ type: 'response', id: msg.id, result }))
    } catch (err: unknown) {
      if (process.env.SENTRY_DSN) Sentry.captureException(err)
      const message = err instanceof Error ? err.message : String(err)
      ws.send(JSON.stringify({ type: 'error', id: msg.id, error: message }))
    }
  })

  ws.on('close', () => {
    clients.delete(ws)
  })
})

httpServer.on('upgrade', (req, socket, head) => {
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
    wss.handleUpgrade(req, socket as import('net').Socket, head, (ws) => {
      wss.emit('connection', ws, req)
    })
  } else {
    socket.destroy()
  }
})

// ─── Startup ──────────────────────────────────────────────────────────────────

const repoSyncService = new RepoSyncService(broadcast)

async function start(): Promise<void> {
  await initDb()

  const orphaned = await getOrphanedRuns()
  for (const run of orphaned) {
    await updateRun(run.id, { status: 'failed', endedAt: Date.now() })
  }
  if (orphaned.length > 0) {
    console.log(`[server] Marked ${orphaned.length} orphaned run(s) as failed`)
  }

  repoSyncService.start()
  await triggerService.start()

  httpServer.listen(PORT, () => {
    console.log(`Conduit server running at http://localhost:${PORT}`)
  })

  // Graceful shutdown. K8s sends SIGTERM and waits up to
  // terminationGracePeriodSeconds (default 30s) before SIGKILL.
  let shuttingDown = false
  const shutdown = (signal: string) => {
    if (shuttingDown) return
    shuttingDown = true
    console.log(`[server] Received ${signal}, draining…`)
    httpServer.close(() => console.log('[server] HTTP server closed'))
    for (const ws of clients) ws.close(1001, 'Server shutting down')
    triggerService.stop()
    repoSyncService.stop()
    // Give in-flight requests up to 10s to finish, then exit.
    setTimeout(() => process.exit(0), 10_000).unref()
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
}

start().catch((err) => {
  console.error('[server] Startup failed:', err)
  if (process.env.SENTRY_DSN) Sentry.captureException(err)
  process.exit(1)
})
