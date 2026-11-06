/**
 * In-process end-to-end tests for the worker control plane: a real HTTP
 * server, real WebSocket clients standing in for conduit-worker, exercising
 * auth, assign/assignTo, event streaming, cancellation, and exit.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import http from 'http'
import { AddressInfo } from 'net'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import WebSocket from 'ws'
import {
  WorkerControlPlane,
  resolveAssignTimeoutMs,
  resolveConnectTimeoutMs,
  type WorkerControlPlaneOptions,
  type RecoverRunResult,
} from './workerControl'
import type { RunSpec, WorkerHandle } from '../shared/worker'
import type { ServerToWorkerMessage } from '../shared/workerControl'
import { WORKER_MAX_EVENT_BATCH, WORKER_MAX_MESSAGE_BYTES } from '../shared/workerControl'
import {
  appendSequencedEvents,
  openDeliveryLog,
  readHighestContiguousSequence,
  type DeliveryLogWriter,
  type OpenDeliveryLog,
} from './runDeliveryLog'

const TOKEN = 'test-worker-token'

const SPEC: RunSpec = {
  runId: 'run-1',
  agentId: 'agent-1',
  runner: 'claude',
  prompt: 'hello',
  env: {},
  workspace: { kind: 'ephemeral' },
}

interface TestCtx {
  server: http.Server
  controlPlane: WorkerControlPlane
  url: string
  sockets: WebSocket[]
  logsDir: string
  close: () => Promise<void>
}

type ResumablePlaneOptions = WorkerControlPlaneOptions & {
  reconnectTimeoutMs?: number
  logsDir?: string
  recoverRun?: (runId: string, workerId: string) => Promise<RecoverRunResult>
}

function assertTempLogsDir(logsDir: string): void {
  const resolved = path.resolve(logsDir)
  const forbidden = path.resolve(path.join(os.homedir(), '.conduit'))
  if (resolved === forbidden || resolved.startsWith(forbidden + path.sep)) {
    throw new Error(`sequenced control-plane tests must not use ~/.conduit logs (${logsDir})`)
  }
}

function startServer(options?: ResumablePlaneOptions): Promise<TestCtx> {
  process.env.CONDUIT_WORKER_TOKEN = TOKEN
  const createdLogsDir = options?.logsDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'conduit-wc-logs-'))
  assertTempLogsDir(createdLogsDir)
  const controlPlane = new WorkerControlPlane({ ...options, logsDir: createdLogsDir })
  const server = http.createServer()
  server.on('upgrade', (req, socket, head) => controlPlane.handleUpgrade(req, socket, head))
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo
      const sockets: WebSocket[] = []
      resolve({
        server,
        controlPlane,
        url: `ws://127.0.0.1:${port}/ws/worker`,
        sockets,
        logsDir: createdLogsDir,
        close: () =>
          new Promise<void>((res) => {
            for (const ws of sockets) {
              try {
                ws.terminate()
              } catch {
                // already closed
              }
            }
            sockets.length = 0
            controlPlane.stop()
            server.closeAllConnections()
            server.close(() => {
              if (!options?.logsDir) {
                fs.rmSync(createdLogsDir, { recursive: true, force: true })
              }
              res()
            })
          }),
      })
    })
  })
}

function connectWorker(
  ctx: TestCtx,
  opts: {
    token?: string
    workerId?: string
    activeRunIds?: string[]
    pendingRunIds?: string[]
  } = {}
): Promise<{ ws: WebSocket; next: (timeoutMs?: number) => Promise<ServerToWorkerMessage> }> {
  const before = ctx.controlPlane.connectedWorkerCount
  const ws = new WebSocket(ctx.url, { headers: { authorization: `Bearer ${opts.token ?? TOKEN}` } })
  ctx.sockets.push(ws)
  const queue: ServerToWorkerMessage[] = []
  const pending: ((m: ServerToWorkerMessage) => void)[] = []
  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString()) as ServerToWorkerMessage
    if (pending.length > 0) pending.shift()!(msg)
    else queue.push(msg)
  })
  const next = (timeoutMs?: number) =>
    new Promise<ServerToWorkerMessage>((resolve, reject) => {
      if (queue.length > 0) {
        resolve(queue.shift()!)
        return
      }
      let timer: ReturnType<typeof setTimeout> | undefined
      const wrapped = (m: ServerToWorkerMessage) => {
        if (timer) clearTimeout(timer)
        resolve(m)
      }
      if (timeoutMs !== undefined) {
        timer = setTimeout(() => {
          const idx = pending.indexOf(wrapped)
          if (idx >= 0) pending.splice(idx, 1)
          reject(new Error('timeout'))
        }, timeoutMs)
      }
      pending.push(wrapped)
    })
  return new Promise((resolve, reject) => {
    ws.on('open', () => {
      ws.send(
        JSON.stringify({
          type: 'worker:hello',
          workerId: opts.workerId ?? 'w1',
          capabilities: { runners: ['claude'], version: 'test' },
          activeRunIds: opts.activeRunIds ?? [],
          pendingRunIds: opts.pendingRunIds ?? [],
        })
      )
      // Resolve only once the server has registered the worker, so tests can
      // assign runs immediately without racing hello processing.
      const poll = setInterval(() => {
        if (ctx.controlPlane.connectedWorkerCount > before) {
          clearInterval(poll)
          resolve({ ws, next })
        }
      }, 5)
      setTimeout(() => {
        clearInterval(poll)
        reject(new Error('worker registration timed out'))
      }, 5000).unref()
    })
    ws.on('error', reject)
  })
}

function nextOrTimeout(
  next: (timeoutMs?: number) => Promise<ServerToWorkerMessage>,
  ms: number
): Promise<ServerToWorkerMessage | 'timeout'> {
  return next(ms).catch(() => 'timeout')
}

async function waitDisconnected(ctx: TestCtx): Promise<void> {
  await vi.waitFor(() => {
    expect(ctx.controlPlane.connectedWorkerCount).toBe(0)
  })
}

function connectSocket(ctx: TestCtx, opts: { token?: string } = {}): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(ctx.url, { headers: { authorization: `Bearer ${opts.token ?? TOKEN}` } })
    ctx.sockets.push(ws)
    ws.on('open', () => resolve(ws))
    ws.on('error', reject)
  })
}

function expectClose(ws: WebSocket, ms = 200): Promise<{ code: number; reason: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('socket was not closed')), ms)
    if (ws.readyState === WebSocket.CLOSED) {
      clearTimeout(timer)
      resolve({ code: 1006, reason: 'already closed' })
      return
    }
    ws.on('close', (code, reason) => {
      clearTimeout(timer)
      resolve({ code, reason: reason.toString() })
    })
  })
}

function sendJson(ws: WebSocket, msg: unknown): void {
  ws.send(JSON.stringify(msg))
}

describe('WorkerControlPlane', () => {
  let ctx: TestCtx
  beforeEach(async () => {
    ctx = await startServer()
  })
  afterEach(async () => {
    await ctx.close()
    delete process.env.CONDUIT_WORKER_TOKEN
  })

  it('rejects upgrade with wrong bearer token', async () => {
    await expect(connectWorker(ctx, { token: 'wrong' })).rejects.toThrow(/401/)
    expect(ctx.controlPlane.connectedWorkerCount).toBe(0)
    expect(ctx.logsDir.startsWith(os.tmpdir()) || ctx.logsDir.includes('/T/')).toBe(true)
    expect(path.resolve(ctx.logsDir).startsWith(path.join(os.homedir(), '.conduit'))).toBe(false)
  })

  it('assigns a run, streams events, and reports exit', async () => {
    const worker = await connectWorker(ctx)
    const events: string[] = []
    let resolveExited!: (v: { status: string; exitCode: number | null }) => void
    const exited = new Promise<{ status: string; exitCode: number | null }>((r) => (resolveExited = r))
    const handlePromise = ctx.controlPlane.assign(SPEC, {
      onEvent: (ev) => events.push(ev.stream),
      onExit: (status, exitCode) => resolveExited({ status, exitCode }),
    })

    const assignMsg = await worker.next()
    expect(assignMsg).toMatchObject({ type: 'run:assign', spec: SPEC })

    worker.ws.send(JSON.stringify({ type: 'run:started', runId: SPEC.runId, workspacePath: '/tmp/x' }))
    worker.ws.send(
      JSON.stringify({
        type: 'run:event',
        runId: SPEC.runId,
        events: [{ kind: 'raw', stream: 'stdout', text: 'hi' }],
      })
    )
    worker.ws.send(JSON.stringify({ type: 'run:exit', runId: SPEC.runId, status: 'completed', exitCode: 0 }))

    await handlePromise
    const result = await exited
    expect(result).toEqual({ status: 'completed', exitCode: 0 })
    expect(events).toEqual(['stdout'])
  })

  it('assign resolves the handle when the worker reports run:started', async () => {
    const worker = await connectWorker(ctx)
    const sink = { onEvent: () => {}, onExit: () => {} }
    const handlePromise = ctx.controlPlane.assign(SPEC, sink)
    await worker.next() // run:assign
    worker.ws.send(JSON.stringify({ type: 'run:started', runId: SPEC.runId, workspacePath: '/tmp/x' }))
    const handle = await handlePromise
    expect(handle.runId).toBe(SPEC.runId)
    expect(handle.workspacePath).toBe('/tmp/x')
    await handle.updateRepoToken?.('ghs_fresh')
    expect(await worker.next()).toEqual({ type: 'run:credentials', runId: SPEC.runId, repoToken: 'ghs_fresh' })
    await handle.cancel()
    expect(await worker.next()).toEqual({ type: 'run:cancel', runId: SPEC.runId })
  })

  it('rejects assign when no worker supports the runner', async () => {
    await expect(
      ctx.controlPlane.assign({ ...SPEC, runner: 'amp' }, { onEvent: () => {}, onExit: () => {} })
    ).rejects.toThrow(/No connected worker supports runner "amp"/)
  })

  it('assignTo waits for the named worker to connect', async () => {
    const sink = { onEvent: () => {}, onExit: () => {} }
    const handlePromise = ctx.controlPlane.assignTo('late-worker', SPEC, sink)
    // Connect after the waiter is registered.
    const worker = await connectWorker(ctx, { workerId: 'late-worker' })
    expect(await worker.next()).toMatchObject({ type: 'run:assign', spec: SPEC })
    worker.ws.send(JSON.stringify({ type: 'run:started', runId: SPEC.runId }))
    const handle = await handlePromise
    expect(handle.runId).toBe(SPEC.runId)
  })

  it('assignTo times out when the named worker never connects', async () => {
    await expect(
      ctx.controlPlane.assignTo('ghost', SPEC, { onEvent: () => {}, onExit: () => {} }, 50)
    ).rejects.toThrow(/did not connect within 50ms/)
  })

  it('assignTo dispatches immediately when the worker is already connected', async () => {
    const worker = await connectWorker(ctx, { workerId: 'ready' })
    const handlePromise = ctx.controlPlane.assignTo('ready', SPEC, { onEvent: () => {}, onExit: () => {} })
    expect(await worker.next()).toMatchObject({ type: 'run:assign', spec: SPEC })
    worker.ws.send(JSON.stringify({ type: 'run:started', runId: SPEC.runId }))
    await handlePromise
  })

  it('does not fail a started run on ordinary disconnect before the reconnect window expires', async () => {
    await ctx.close()
    ctx = await startServer({ reconnectTimeoutMs: 250 })
    const worker = await connectWorker(ctx)
    let exit: { status: string } | undefined
    const handlePromise = ctx.controlPlane.assign(SPEC, {
      onEvent: () => {},
      onExit: (status) => {
        exit = { status }
      },
    })
    await worker.next()
    worker.ws.send(JSON.stringify({ type: 'run:started', runId: SPEC.runId, sequence: 1 }))
    await handlePromise
    worker.ws.terminate()
    await waitDisconnected(ctx)
    await new Promise((r) => setTimeout(r, 80))
    expect(exit).toBeUndefined()
  })

  it('rejects messages sent before worker:hello', async () => {
    const ws = await connectSocket(ctx)
    sendJson(ws, { type: 'worker:heartbeat', workerId: 'w1', activeRunIds: [] })
    await expect(expectClose(ws)).resolves.toMatchObject({ code: expect.any(Number) })
    expect(ctx.controlPlane.connectedWorkerCount).toBe(0)
  })

  it('rejects malformed JSON', async () => {
    const ws = await connectSocket(ctx)
    ws.send('{not-json')
    await expect(expectClose(ws)).resolves.toMatchObject({ code: expect.any(Number) })
    expect(ctx.controlPlane.connectedWorkerCount).toBe(0)
  })

  it('rejects oversized frames', async () => {
    const ws = await connectSocket(ctx)
    ws.send('x'.repeat(WORKER_MAX_MESSAGE_BYTES + 1))
    await expect(expectClose(ws)).resolves.toMatchObject({ code: expect.any(Number) })
    expect(ctx.controlPlane.connectedWorkerCount).toBe(0)
  })

  it('rejects run:event batches larger than WORKER_MAX_EVENT_BATCH', async () => {
    const worker = await connectWorker(ctx)
    const events: string[] = []
    const handlePromise = ctx.controlPlane.assign(SPEC, {
      onEvent: (ev) => events.push(ev.stream),
      onExit: () => {},
    })
    await worker.next()
    worker.ws.send(JSON.stringify({ type: 'run:started', runId: SPEC.runId }))
    await handlePromise
    worker.ws.send(
      JSON.stringify({
        type: 'run:event',
        runId: SPEC.runId,
        events: Array.from({ length: WORKER_MAX_EVENT_BATCH + 1 }, () => ({
          kind: 'raw',
          stream: 'stdout',
          text: 'x',
        })),
      })
    )
    await expect(expectClose(worker.ws)).resolves.toMatchObject({ code: expect.any(Number) })
    expect(events).toEqual([])
  })

  it('ignores run events whose assignment.workerId does not match the socket workerId', async () => {
    const owner = await connectWorker(ctx, { workerId: 'owner' })
    const stranger = await connectWorker(ctx, { workerId: 'stranger' })
    const events: string[] = []
    let exit: { status: string; exitCode: number | null | undefined } | undefined
    const handlePromise = ctx.controlPlane.assignTo('owner', SPEC, {
      onEvent: (ev) => events.push(ev.stream),
      onExit: (status, exitCode) => {
        exit = { status, exitCode }
      },
    })
    expect(await owner.next()).toMatchObject({ type: 'run:assign', spec: SPEC })
    owner.ws.send(JSON.stringify({ type: 'run:started', runId: SPEC.runId }))
    await handlePromise

    stranger.ws.send(
      JSON.stringify({
        type: 'run:event',
        runId: SPEC.runId,
        events: [{ kind: 'raw', stream: 'stdout', text: 'injected' }],
      })
    )
    stranger.ws.send(
      JSON.stringify({ type: 'run:exit', runId: SPEC.runId, status: 'completed', exitCode: 0 })
    )
    await new Promise((r) => setTimeout(r, 50))
    expect(events).toEqual([])
    expect(exit).toBeUndefined()

    owner.ws.send(JSON.stringify({ type: 'run:exit', runId: SPEC.runId, status: 'completed', exitCode: 0 }))
    await vi.waitFor(() => {
      expect(exit).toEqual({ status: 'completed', exitCode: 0 })
    })
    expect(events).toEqual([])
  })

  it('rejects a second hello that changes worker identity on the same socket', async () => {
    const worker = await connectWorker(ctx, { workerId: 'w1' })
    worker.ws.send(
      JSON.stringify({
        type: 'worker:hello',
        workerId: 'w2',
        capabilities: { runners: ['claude'], version: 'test' },
        activeRunIds: [],
      })
    )
    await new Promise((r) => setTimeout(r, 50))
    // Keep the live w1 session — do not close-and-leak a stale w1 entry.
    expect(worker.ws.readyState).toBe(WebSocket.OPEN)
    expect(ctx.controlPlane.connectedWorkerCount).toBe(1)
    await expect(
      ctx.controlPlane.assignTo('w2', { ...SPEC, runId: 'run-w2' }, { onEvent: () => {}, onExit: () => {} }, 30)
    ).rejects.toThrow(/did not connect/)

    const handlePromise = ctx.controlPlane.assignTo('w1', SPEC, { onEvent: () => {}, onExit: () => {} })
    expect(await worker.next()).toMatchObject({ type: 'run:assign', spec: SPEC })
    worker.ws.send(JSON.stringify({ type: 'run:started', runId: SPEC.runId }))
    await handlePromise
  })

  it('closes the previous socket when a duplicate identity connects', async () => {
    const first = await connectWorker(ctx, { workerId: 'w1' })
    const firstClosed = expectClose(first.ws, 500)
    const second = await connectSocket(ctx)
    sendJson(second, {
      type: 'worker:hello',
      workerId: 'w1',
      capabilities: { runners: ['claude'], version: 'test' },
      activeRunIds: [],
    })
    await firstClosed
    expect(first.ws.readyState).toBe(WebSocket.CLOSED)
    expect(second.readyState).toBe(WebSocket.OPEN)
    expect(ctx.controlPlane.connectedWorkerCount).toBe(1)
  })

  it('does not let a duplicate-identity socket inherit or inject into a live assignment', async () => {
    const owner = await connectWorker(ctx, { workerId: 'fargate-run-1' })
    const events: string[] = []
    let exit: { status: string; exitCode: number | null | undefined } | undefined
    const handlePromise = ctx.controlPlane.assignTo('fargate-run-1', SPEC, {
      onEvent: (ev) => events.push(ev.text ?? ev.stream),
      onExit: (status, exitCode) => {
        exit = { status, exitCode }
      },
    })
    expect(await owner.next()).toMatchObject({ type: 'run:assign', spec: SPEC })
    owner.ws.send(JSON.stringify({ type: 'run:started', runId: SPEC.runId, workspacePath: '/tmp/owner' }))
    const handle = await handlePromise
    expect(handle.workspacePath).toBe('/tmp/owner')

    const impostor = await connectSocket(ctx)
    const impostorClosed = expectClose(impostor, 500)
    sendJson(impostor, {
      type: 'worker:hello',
      workerId: 'fargate-run-1',
      capabilities: { runners: ['claude'], version: 'test' },
      activeRunIds: [],
    })
    sendJson(impostor, {
      type: 'run:event',
      runId: SPEC.runId,
      events: [{ kind: 'raw', stream: 'stdout', text: 'injected' }],
    })
    sendJson(impostor, { type: 'run:exit', runId: SPEC.runId, status: 'completed', exitCode: 0 })

    await impostorClosed
    expect(owner.ws.readyState).toBe(WebSocket.OPEN)
    expect(ctx.controlPlane.connectedWorkerCount).toBe(1)
    expect(events).toEqual([])
    expect(exit).toBeUndefined()

    owner.ws.send(
      JSON.stringify({
        type: 'run:event',
        runId: SPEC.runId,
        events: [{ kind: 'raw', stream: 'stdout', text: 'from-owner' }],
      })
    )
    owner.ws.send(JSON.stringify({ type: 'run:exit', runId: SPEC.runId, status: 'completed', exitCode: 0 }))
    await vi.waitFor(() => {
      expect(exit).toEqual({ status: 'completed', exitCode: 0 })
    })
    expect(events).toEqual(['from-owner'])
  })

  it('takes over a half-open socket when the reconnect hello claims the active run (pause client read so ping gets no pong)', async () => {
    // Short lease + probe so we can prove takeover beats lease expiry without waiting 75s.
    await ctx.close()
    ctx = await startServer({ leaseMs: 250, socketProbeTimeoutMs: 80 })

    const owner = await connectWorker(ctx, { workerId: 'fargate-run-1' })
    const events: string[] = []
    let exit: { status: string; exitCode: number | null | undefined } | undefined
    const handlePromise = ctx.controlPlane.assignTo('fargate-run-1', SPEC, {
      onEvent: (ev) => events.push(ev.text ?? ev.stream),
      onExit: (status, exitCode) => {
        exit = { status, exitCode }
      },
    })
    expect(await owner.next()).toMatchObject({ type: 'run:assign', spec: SPEC })
    owner.ws.send(JSON.stringify({ type: 'run:started', runId: SPEC.runId, workspacePath: '/tmp/owner' }))
    await handlePromise

    // Half-open: TCP still up (server readyState OPEN, no `close`), but the client
    // no longer reads — so the server's probe ping never gets a pong.
    const ownerRaw = (owner.ws as unknown as { _socket: { pause: () => void } })._socket
    ownerRaw.pause()

    const replacement = await connectSocket(ctx)
    const inbound: ServerToWorkerMessage[] = []
    replacement.on('message', (data) => {
      inbound.push(JSON.parse(data.toString()) as ServerToWorkerMessage)
    })
    sendJson(replacement, {
      type: 'worker:hello',
      workerId: 'fargate-run-1',
      capabilities: { runners: ['claude'], version: 'test' },
      activeRunIds: [SPEC.runId],
      pendingRunIds: [SPEC.runId],
    })

    await vi.waitFor(() => {
      expect(inbound.some((m) => m.type === 'run:resume' && m.runId === SPEC.runId)).toBe(true)
    })
    expect(replacement.readyState).toBe(WebSocket.OPEN)
    expect(ctx.controlPlane.connectedWorkerCount).toBe(1)

    sendJson(replacement, {
      type: 'worker:heartbeat',
      workerId: 'fargate-run-1',
      activeRunIds: [SPEC.runId],
    })
    sendJson(replacement, {
      type: 'run:event',
      runId: SPEC.runId,
      events: [{ kind: 'raw', stream: 'stdout', text: 'after-takeover' }],
    })
    await vi.waitFor(() => {
      expect(events).toEqual(['after-takeover'])
    })

    // Keep the new socket's lease warm across several check intervals. Without
    // takeover the half-open peer cannot heartbeat and checkLeases would fail
    // the run; with takeover, heartbeats on the replacement socket keep it alive.
    const keepAlive = setInterval(() => {
      if (replacement.readyState === WebSocket.OPEN) {
        sendJson(replacement, {
          type: 'worker:heartbeat',
          workerId: 'fargate-run-1',
          activeRunIds: [SPEC.runId],
        })
      }
    }, 50)
    try {
      await new Promise((r) => setTimeout(r, 400))
      expect(exit).toBeUndefined()
      expect(ctx.controlPlane.activeAssignmentCount).toBe(1)
    } finally {
      clearInterval(keepAlive)
    }

    sendJson(replacement, {
      type: 'run:exit',
      runId: SPEC.runId,
      status: 'completed',
      exitCode: 0,
    })
    await vi.waitFor(() => {
      expect(exit).toEqual({ status: 'completed', exitCode: 0 })
    })
  })

  it('does not deliver events from one run onto another run\'s sink', async () => {
    const a = await connectWorker(ctx, { workerId: 'wa' })
    const b = await connectWorker(ctx, { workerId: 'wb' })
    const specA = SPEC
    const specB = { ...SPEC, runId: 'run-2', agentId: 'agent-2' }
    const eventsA: string[] = []
    const eventsB: string[] = []
    let exitA: string | undefined
    let exitB: string | undefined
    const handleA = ctx.controlPlane.assignTo('wa', specA, {
      onEvent: (ev) => eventsA.push(ev.text ?? ev.stream),
      onExit: (status) => {
        exitA = status
      },
    })
    const handleB = ctx.controlPlane.assignTo('wb', specB, {
      onEvent: (ev) => eventsB.push(ev.text ?? ev.stream),
      onExit: (status) => {
        exitB = status
      },
    })
    expect(await a.next()).toMatchObject({ type: 'run:assign', spec: specA })
    expect(await b.next()).toMatchObject({ type: 'run:assign', spec: specB })
    a.ws.send(JSON.stringify({ type: 'run:started', runId: specA.runId }))
    b.ws.send(JSON.stringify({ type: 'run:started', runId: specB.runId }))
    await Promise.all([handleA, handleB])

    a.ws.send(
      JSON.stringify({
        type: 'run:event',
        runId: specB.runId,
        events: [{ kind: 'raw', stream: 'stdout', text: 'cross' }],
      })
    )
    a.ws.send(JSON.stringify({ type: 'run:exit', runId: specB.runId, status: 'failed', exitCode: 1 }))
    b.ws.send(
      JSON.stringify({
        type: 'run:event',
        runId: specB.runId,
        events: [{ kind: 'raw', stream: 'stdout', text: 'ok-b' }],
      })
    )
    await new Promise((r) => setTimeout(r, 50))
    expect(eventsA).toEqual([])
    expect(eventsB).toEqual(['ok-b'])
    expect(exitA).toBeUndefined()
    expect(exitB).toBeUndefined()

    b.ws.send(JSON.stringify({ type: 'run:exit', runId: specB.runId, status: 'completed', exitCode: 0 }))
    await vi.waitFor(() => {
      expect(exitB).toBe('completed')
    })
    expect(exitA).toBeUndefined()
  })

  it('uses constructor assignTimeoutMs and drops the assignment so a late run:started is ignored', async () => {
    await ctx.close()
    ctx = await startServer({ assignTimeoutMs: 50 })
    const worker = await connectWorker(ctx)
    const handlePromise = ctx.controlPlane.assign(SPEC, { onEvent: () => {}, onExit: () => {} })
    await worker.next()
    await expect(handlePromise).rejects.toThrow(/did not start run/)
    expect(await worker.next()).toEqual({ type: 'run:cancel', runId: SPEC.runId })

    worker.ws.send(JSON.stringify({ type: 'run:started', runId: SPEC.runId, workspacePath: '/tmp/late' }))
    // Let the late frame land while no assignment exists (a no-op). A retry's
    // run:started must not be consumed by the timed-out generation's suppressor.
    await new Promise((r) => setTimeout(r, 20))
    const retry = ctx.controlPlane.assign(SPEC, { onEvent: () => {}, onExit: () => {} })
    const retryAssign = await worker.next()
    expect(retryAssign).toMatchObject({ type: 'run:assign', spec: SPEC })
    const retryId = retryAssign.type === 'run:assign' ? retryAssign.assignId : undefined
    worker.ws.send(
      JSON.stringify({
        type: 'run:started',
        runId: SPEC.runId,
        workspacePath: '/tmp/ok',
        assignId: retryId,
      })
    )
    const handle = await retry
    expect(handle.workspacePath).toBe('/tmp/ok')
  }, 400)

  it('does not consume a retry run:started after a timed-out assignment', async () => {
    await ctx.close()
    ctx = await startServer({ assignTimeoutMs: 50 })
    const worker = await connectWorker(ctx)
    const first = ctx.controlPlane.assign(SPEC, { onEvent: () => {}, onExit: () => {} })
    await worker.next()
    await expect(first).rejects.toThrow(/did not start run/)
    expect(await worker.next()).toEqual({ type: 'run:cancel', runId: SPEC.runId })

    const retry = ctx.controlPlane.assign(SPEC, { onEvent: () => {}, onExit: () => {} })
    const retryAssign = await worker.next()
    expect(retryAssign).toMatchObject({ type: 'run:assign', spec: SPEC })
    const retryId = retryAssign.type === 'run:assign' ? retryAssign.assignId : undefined
    worker.ws.send(
      JSON.stringify({
        type: 'run:started',
        runId: SPEC.runId,
        workspacePath: '/tmp/retry',
        assignId: retryId,
      })
    )
    const handle = await retry
    expect(handle.workspacePath).toBe('/tmp/retry')
  }, 400)

  it('does not settle a retry from a late started of the timed-out assignment', async () => {
    await ctx.close()
    // Comfortably longer than the 40ms "still pending" probe below: with a 50ms
    // window the retry assignment could lapse mid-probe and reject, which made
    // this test flaky rather than wrong.
    ctx = await startServer({ assignTimeoutMs: 200 })
    const worker = await connectWorker(ctx)
    const first = ctx.controlPlane.assign(SPEC, { onEvent: () => {}, onExit: () => {} })
    const firstAssign = await worker.next()
    expect(firstAssign).toMatchObject({ type: 'run:assign', spec: SPEC })
    const staleId = firstAssign.type === 'run:assign' ? firstAssign.assignId : undefined
    await expect(first).rejects.toThrow(/did not start run/)
    expect(await worker.next()).toEqual({ type: 'run:cancel', runId: SPEC.runId })

    const retry = ctx.controlPlane.assign(SPEC, { onEvent: () => {}, onExit: () => {} })
    const retryAssign = await worker.next()
    expect(retryAssign).toMatchObject({ type: 'run:assign', spec: SPEC })
    const freshId = retryAssign.type === 'run:assign' ? retryAssign.assignId : undefined
    expect(freshId).toBeTruthy()
    expect(freshId).not.toBe(staleId)

    worker.ws.send(
      JSON.stringify({
        type: 'run:started',
        runId: SPEC.runId,
        workspacePath: '/tmp/stale',
        assignId: staleId,
      })
    )
    const raced = await Promise.race([
      retry.then((h) => h.workspacePath),
      new Promise<string>((resolve) => setTimeout(() => resolve('pending'), 40)),
    ])
    expect(raced).toBe('pending')

    worker.ws.send(
      JSON.stringify({
        type: 'run:started',
        runId: SPEC.runId,
        workspacePath: '/tmp/fresh',
        assignId: freshId,
      })
    )
    const handle = await retry
    expect(handle.workspacePath).toBe('/tmp/fresh')
  }, 5_000)

  it('stop leaves a started run for the replacement server instead of failing it', async () => {
    const worker = await connectWorker(ctx)
    const events: string[] = []
    const onExit = vi.fn()
    const handlePromise = ctx.controlPlane.assign(SPEC, { onEvent: (ev) => events.push(ev.text ?? ''), onExit })
    await worker.next() // run:assign
    worker.ws.send(JSON.stringify({ type: 'run:started', runId: SPEC.runId }))
    await handlePromise
    const closed = expectClose(worker.ws)
    ctx.controlPlane.stop()
    expect(await closed).toMatchObject({ code: 1001 })
    expect(onExit).not.toHaveBeenCalled()
    expect(events).toEqual([])
  })

  it('rejects pending assignTo waiters when the control plane stops', async () => {
    const pending = ctx.controlPlane.assignTo('ghost', SPEC, { onEvent: () => {}, onExit: () => {} }, 2_000)
    ctx.controlPlane.stop()
    await expect(pending).rejects.toThrow(/shutting down|stopped/)
  }, 400)

  it('cancelAssignTo rejects the waiter so a late hello does not receive run:assign', async () => {
    const pending = ctx.controlPlane.assignTo(
      'fargate-run-1',
      SPEC,
      { onEvent: () => {}, onExit: () => {} },
      2_000
    )
    ctx.controlPlane.cancelAssignTo(
      'fargate-run-1',
      new Error('Fargate task stopped before the worker connected')
    )
    await expect(pending).rejects.toThrow(/stopped before the worker connected/)

    const worker = await connectWorker(ctx, { workerId: 'fargate-run-1' })
    const assigned = Promise.race([
      worker.next().then((msg) => msg.type),
      new Promise<string>((resolve) => setTimeout(() => resolve('none'), 50)),
    ])
    await expect(assigned).resolves.toBe('none')
  }, 400)

  it('fails a pending assignment (not yet started) when the worker disconnects', async () => {
    const worker = await connectWorker(ctx)
    const handlePromise = ctx.controlPlane.assign(SPEC, { onEvent: () => {}, onExit: () => {} })
    await worker.next()
    worker.ws.terminate()
    await expect(handlePromise).rejects.toThrow(/disconnected/)
  })

  it('does not fail another worker\'s run when one worker disconnects', async () => {
    await ctx.close()
    ctx = await startServer({ reconnectTimeoutMs: 250 })
    const keep = await connectWorker(ctx, { workerId: 'keep' })
    const drop = await connectWorker(ctx, { workerId: 'drop' })
    const specKeep = SPEC
    const specDrop = { ...SPEC, runId: 'run-drop' }
    let keepStatus: string | undefined
    let dropStatus: string | undefined
    const keepHandle = ctx.controlPlane.assignTo('keep', specKeep, {
      onEvent: () => {},
      onExit: (status) => {
        keepStatus = status
      },
    })
    const dropHandle = ctx.controlPlane.assignTo('drop', specDrop, {
      onEvent: () => {},
      onExit: (status) => {
        dropStatus = status
      },
    })
    expect(await keep.next()).toMatchObject({ type: 'run:assign', spec: specKeep })
    expect(await drop.next()).toMatchObject({ type: 'run:assign', spec: specDrop })
    keep.ws.send(JSON.stringify({ type: 'run:started', runId: specKeep.runId }))
    drop.ws.send(JSON.stringify({ type: 'run:started', runId: specDrop.runId }))
    await Promise.all([keepHandle, dropHandle])
    drop.ws.terminate()
    await new Promise((r) => setTimeout(r, 80))
    expect(dropStatus).toBeUndefined()
    expect(keepStatus).toBeUndefined()
  })
})

describe('WorkerControlPlane lease', () => {
  let ctx: TestCtx
  afterEach(async () => {
    await ctx?.close()
    delete process.env.CONDUIT_WORKER_TOKEN
  })

  it('keeps a started run alive when run:event frames arrive without heartbeats', async () => {
    ctx = await startServer({ leaseMs: 80 })
    const worker = await connectWorker(ctx)
    let exit: { status: string } | undefined
    const handlePromise = ctx.controlPlane.assign(SPEC, {
      onEvent: () => {},
      onExit: (status) => {
        exit = { status }
      },
    })
    await worker.next()
    worker.ws.send(JSON.stringify({ type: 'run:started', runId: SPEC.runId }))
    await handlePromise

    const pump = setInterval(() => {
      worker.ws.send(
        JSON.stringify({
          type: 'run:event',
          runId: SPEC.runId,
          events: [{ kind: 'raw', stream: 'stdout', text: 'still working' }],
        })
      )
    }, 25)
    await new Promise((r) => setTimeout(r, 250))
    clearInterval(pump)

    expect(exit).toBeUndefined()
    expect(ctx.controlPlane.connectedWorkerCount).toBe(1)
  })

  it('fails a started run when the worker is silent past the lease', async () => {
    ctx = await startServer({ leaseMs: 80 })
    const worker = await connectWorker(ctx)
    const exited = new Promise<string>((resolve) => {
      void ctx.controlPlane.assign(SPEC, {
        onEvent: () => {},
        onExit: (status) => resolve(status),
      })
    })
    await worker.next()
    worker.ws.send(JSON.stringify({ type: 'run:started', runId: SPEC.runId }))
    await expect(exited).resolves.toBe('failed')
  })
})

describe('worker control timeouts from supplied env', () => {
  it('reads assign and connect timeouts from the supplied env, not import-time globals', () => {
    expect(resolveAssignTimeoutMs({ CONDUIT_WORKER_ASSIGN_TIMEOUT_MS: '1500' })).toBe(1_500)
    expect(resolveConnectTimeoutMs({ CONDUIT_WORKER_CONNECT_TIMEOUT_MS: '2000' })).toBe(2_000)
  })
})

describe('WorkerControlPlane detach, rebind, and idempotent ACK', () => {
  let ctx: TestCtx
  let logsDir: string

  beforeEach(async () => {
    logsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'conduit-worker-delivery-'))
    ctx = await startServer({ reconnectTimeoutMs: 400, logsDir })
  })
  afterEach(async () => {
    await ctx?.close()
    delete process.env.CONDUIT_WORKER_TOKEN
    fs.rmSync(logsDir, { recursive: true, force: true })
  })

  function logPath(runId = SPEC.runId): string {
    return path.join(logsDir, `${runId}.jsonl`)
  }

  async function startAssignedRun(
    workerId = 'w1'
  ): Promise<{
    worker: { ws: WebSocket; next: (timeoutMs?: number) => Promise<ServerToWorkerMessage> }
    events: string[]
    exits: Array<{ status: string; exitCode: number | null | undefined }>
    handle: WorkerHandle
  }> {
    const worker = await connectWorker(ctx, { workerId })
    const events: string[] = []
    const exits: Array<{ status: string; exitCode: number | null | undefined }> = []
    const handlePromise = ctx.controlPlane.assign(SPEC, {
      onEvent: (ev) => events.push(ev.text ?? ev.stream),
      onExit: (status, exitCode) => {
        exits.push({ status, exitCode })
      },
    })
    void handlePromise.catch(() => {})
    const assignMsg = await worker.next()
    expect(assignMsg).toMatchObject({
      type: 'run:assign',
      spec: SPEC,
      reconnectTimeoutMs: 400,
    })
    worker.ws.send(
      JSON.stringify({
        type: 'run:started',
        runId: SPEC.runId,
        sequence: 1,
        workspacePath: '/tmp/x',
      })
    )
    expect(await worker.next()).toEqual({ type: 'run:ack', runId: SPEC.runId, sequence: 1 })
    const handle = await handlePromise
    return { worker, events, exits, handle }
  }

  it('rebinds the same worker after socket loss, resumes from the durable cursor, and ACKs replayed events then exit in order', async () => {
    const { worker, events, exits } = await startAssignedRun()
    worker.ws.terminate()
    await waitDisconnected(ctx)
    await new Promise((r) => setTimeout(r, 40))
    expect(exits).toEqual([])

    const resumed = await connectWorker(ctx, {
      workerId: 'w1',
      activeRunIds: [SPEC.runId],
      pendingRunIds: [SPEC.runId],
    })
    expect(await resumed.next()).toEqual({ type: 'run:resume', runId: SPEC.runId, sequence: 1 })

    resumed.ws.send(
      JSON.stringify({
        type: 'run:event',
        runId: SPEC.runId,
        sequence: 2,
        events: [{ kind: 'raw', stream: 'stdout', text: 'after-rebind' }],
      })
    )
    expect(await resumed.next()).toEqual({ type: 'run:ack', runId: SPEC.runId, sequence: 2 })
    expect(await readHighestContiguousSequence(logPath())).toBe(2)

    resumed.ws.send(
      JSON.stringify({
        type: 'run:exit',
        runId: SPEC.runId,
        sequence: 3,
        status: 'completed',
        exitCode: 0,
      })
    )
    expect(await resumed.next()).toEqual({ type: 'run:ack', runId: SPEC.runId, sequence: 3 })
    await vi.waitFor(() => {
      expect(exits).toEqual([{ status: 'completed', exitCode: 0 }])
    })
    expect(events).toEqual(['after-rebind'])
  })

  it('does not let a foreign worker identity adopt or inject into a detached run', async () => {
    const { worker, events, exits } = await startAssignedRun('owner')
    worker.ws.terminate()
    await waitDisconnected(ctx)

    const stranger = await connectWorker(ctx, {
      workerId: 'stranger',
      pendingRunIds: [SPEC.runId],
    })
    // Told to stop retrying, but never resumed and never given owner detail.
    expect(await stranger.next(500)).toEqual({
      type: 'run:reject',
      runId: SPEC.runId,
      reason: 'run is not recoverable on this server',
    })
    stranger.ws.send(
      JSON.stringify({
        type: 'run:event',
        runId: SPEC.runId,
        sequence: 2,
        events: [{ kind: 'raw', stream: 'stdout', text: 'injected' }],
      })
    )
    stranger.ws.send(
      JSON.stringify({
        type: 'run:exit',
        runId: SPEC.runId,
        sequence: 3,
        status: 'completed',
        exitCode: 0,
      })
    )
    await new Promise((r) => setTimeout(r, 40))
    expect(events).toEqual([])
    expect(exits).toEqual([])

    const owner = await connectWorker(ctx, {
      workerId: 'owner',
      pendingRunIds: [SPEC.runId],
    })
    expect(await owner.next()).toEqual({ type: 'run:resume', runId: SPEC.runId, sequence: 1 })
  })

  it('acknowledges a lost-ACK replay without duplicating sink events', async () => {
    const { worker, events, exits } = await startAssignedRun()
    worker.ws.terminate()
    await waitDisconnected(ctx)
    const resumed = await connectWorker(ctx, {
      workerId: 'w1',
      pendingRunIds: [SPEC.runId],
    })
    expect(await resumed.next()).toEqual({ type: 'run:resume', runId: SPEC.runId, sequence: 1 })

    const eventFrame = {
      type: 'run:event',
      runId: SPEC.runId,
      sequence: 2,
      events: [{ kind: 'raw', stream: 'stdout', text: 'once' }],
    }
    resumed.ws.send(JSON.stringify(eventFrame))
    expect(await resumed.next()).toEqual({ type: 'run:ack', runId: SPEC.runId, sequence: 2 })
    resumed.ws.send(JSON.stringify(eventFrame))
    expect(await resumed.next()).toEqual({ type: 'run:ack', runId: SPEC.runId, sequence: 2 })
    expect(events).toEqual(['once'])
    expect(exits).toEqual([])
  })

  it('does not apply frames from a stale socket after the same workerId rebinds', async () => {
    const { worker, events, exits } = await startAssignedRun()
    worker.ws.terminate()
    await waitDisconnected(ctx)
    const live = await connectWorker(ctx, {
      workerId: 'w1',
      pendingRunIds: [SPEC.runId],
    })
    expect(await live.next()).toEqual({ type: 'run:resume', runId: SPEC.runId, sequence: 1 })

    const impostor = await connectSocket(ctx)
    const impostorClosed = expectClose(impostor, 500)
    sendJson(impostor, {
      type: 'worker:hello',
      workerId: 'w1',
      capabilities: { runners: ['claude'], version: 'test' },
      activeRunIds: [SPEC.runId],
      pendingRunIds: [SPEC.runId],
    })
    sendJson(impostor, {
      type: 'run:event',
      runId: SPEC.runId,
      sequence: 2,
      events: [{ kind: 'raw', stream: 'stdout', text: 'stale' }],
    })
    await impostorClosed
    expect(live.ws.readyState).toBe(WebSocket.OPEN)
    expect(events).toEqual([])
    expect(exits).toEqual([])

    live.ws.send(
      JSON.stringify({
        type: 'run:event',
        runId: SPEC.runId,
        sequence: 2,
        events: [{ kind: 'raw', stream: 'stdout', text: 'from-live' }],
      })
    )
    expect(await live.next()).toEqual({ type: 'run:ack', runId: SPEC.runId, sequence: 2 })
    expect(events).toEqual(['from-live'])
  })

  it('does not advance ACK across a sequence gap', async () => {
    const { worker, events } = await startAssignedRun()
    worker.ws.terminate()
    await waitDisconnected(ctx)
    const resumed = await connectWorker(ctx, {
      workerId: 'w1',
      pendingRunIds: [SPEC.runId],
    })
    expect(await resumed.next()).toEqual({ type: 'run:resume', runId: SPEC.runId, sequence: 1 })

    resumed.ws.send(
      JSON.stringify({
        type: 'run:event',
        runId: SPEC.runId,
        sequence: 3,
        events: [{ kind: 'raw', stream: 'stdout', text: 'gapped' }],
      })
    )
    expect(await nextOrTimeout(resumed.next, 80)).toBe('timeout')
    expect(events).toEqual([])
    expect(await readHighestContiguousSequence(logPath())).toBe(1)

    resumed.ws.send(
      JSON.stringify({
        type: 'run:event',
        runId: SPEC.runId,
        sequence: 2,
        events: [{ kind: 'raw', stream: 'stdout', text: 'two' }],
      })
    )
    expect(await resumed.next()).toEqual({ type: 'run:ack', runId: SPEC.runId, sequence: 2 })
    expect(events).toEqual(['two'])
  })

  it('fails a detached assignment once with a synthesized exit when the reconnect window expires', async () => {
    await ctx.close()
    ctx = await startServer({ reconnectTimeoutMs: 80, logsDir })
    const worker = await connectWorker(ctx)
    const exits: string[] = []
    const handlePromise = ctx.controlPlane.assign(SPEC, {
      onEvent: () => {},
      onExit: (status) => {
        exits.push(status)
      },
    })
    await worker.next()
    worker.ws.send(JSON.stringify({ type: 'run:started', runId: SPEC.runId, sequence: 1 }))
    await handlePromise
    expect(await worker.next()).toEqual({ type: 'run:ack', runId: SPEC.runId, sequence: 1 })
    worker.ws.terminate()
    await waitDisconnected(ctx)
    await vi.waitFor(() => {
      expect(exits).toEqual(['failed'])
    })
    await new Promise((r) => setTimeout(r, 50))
    expect(exits).toEqual(['failed'])
  })

  it('ACKs run:exit only after async durable finalization completes', async () => {
    const worker = await connectWorker(ctx)
    let finalized = false
    const handlePromise = ctx.controlPlane.assign(SPEC, {
      onEvent: () => {},
      onExit: async () => {
        await new Promise((r) => setTimeout(r, 70))
        finalized = true
      },
    })
    await worker.next()
    worker.ws.send(JSON.stringify({ type: 'run:started', runId: SPEC.runId, sequence: 1 }))
    await handlePromise
    expect(await worker.next()).toEqual({ type: 'run:ack', runId: SPEC.runId, sequence: 1 })

    worker.ws.send(
      JSON.stringify({
        type: 'run:exit',
        runId: SPEC.runId,
        sequence: 2,
        status: 'completed',
        exitCode: 0,
      })
    )
    const ack = worker.next()
    await new Promise((r) => setTimeout(r, 30))
    expect(finalized).toBe(false)
    expect(await ack).toEqual({ type: 'run:ack', runId: SPEC.runId, sequence: 2 })
    expect(finalized).toBe(true)
  })

  it('does not send run:reject for a valid in-progress start reported on reconnect', async () => {
    const { worker } = await startAssignedRun()
    worker.ws.terminate()
    await waitDisconnected(ctx)
    const resumed = await connectWorker(ctx, {
      workerId: 'w1',
      activeRunIds: [SPEC.runId],
      pendingRunIds: [SPEC.runId],
    })
    const msg = await resumed.next()
    expect(msg.type).not.toBe('run:reject')
    expect(msg).toEqual({ type: 'run:resume', runId: SPEC.runId, sequence: 1 })
  })

  it('reconstructs a missing in-memory assignment through RecoverRun for the authenticated workerId', async () => {
    await ctx.close()
    const events: string[] = []
    const recoverRun: ResumablePlaneOptions['recoverRun'] = async (runId, workerId) => {
      if (runId !== SPEC.runId || workerId !== 'w1') return undefined
      return {
        runId,
        workerId,
        durableSequence: 1,
        sink: {
          onEvent: (ev) => events.push(ev.text ?? ev.stream),
          onExit: () => {},
        },
        handle: {
          runId,
          workerId,
          ephemeral: false,
          cancel: async () => {},
        },
      }
    }
    ctx = await startServer({ reconnectTimeoutMs: 400, logsDir, recoverRun })
    // The log is the authority for the cursor, so seed the durable prefix.
    await appendSequencedEvents(logPath(), [{ kind: 'raw', stream: 'stdout', text: 'pre' }], 1)
    const worker = await connectWorker(ctx, {
      workerId: 'w1',
      pendingRunIds: [SPEC.runId],
    })
    expect(await worker.next()).toEqual({ type: 'run:resume', runId: SPEC.runId, sequence: 1 })
    worker.ws.send(
      JSON.stringify({
        type: 'run:event',
        runId: SPEC.runId,
        sequence: 2,
        events: [{ kind: 'raw', stream: 'stdout', text: 'recovered' }],
      })
    )
    expect(await worker.next()).toEqual({ type: 'run:ack', runId: SPEC.runId, sequence: 2 })
    expect(events).toEqual(['recovered'])
  })

  it('resumes a recovered run from cursor 0 and accepts the replayed run:started with its original assignId', async () => {
    await ctx.close()
    const events: string[] = []
    const recoverRun: ResumablePlaneOptions['recoverRun'] = async (runId, workerId) => ({
      runId,
      workerId,
      durableSequence: 0,
      sink: {
        onEvent: (ev) => events.push(ev.text ?? ev.stream),
        onDurableEvent: (ev) => events.push(ev.text ?? ev.stream),
        onExit: () => {},
      },
      handle: { runId, workerId, ephemeral: false, cancel: async () => {} },
    })
    ctx = await startServer({ reconnectTimeoutMs: 400, logsDir, recoverRun })
    const worker = await connectWorker(ctx, { workerId: 'w1', pendingRunIds: [SPEC.runId] })
    expect(await worker.next()).toEqual({ type: 'run:resume', runId: SPEC.runId, sequence: 0 })

    // assignId was issued by the *previous* server process; the replay must still apply.
    worker.ws.send(
      JSON.stringify({
        type: 'run:started',
        runId: SPEC.runId,
        sequence: 1,
        assignId: 'issued-before-restart',
        workspacePath: '/tmp/x',
      })
    )
    expect(await worker.next()).toEqual({ type: 'run:ack', runId: SPEC.runId, sequence: 1 })
    worker.ws.send(
      JSON.stringify({
        type: 'run:event',
        runId: SPEC.runId,
        sequence: 2,
        events: [{ kind: 'raw', stream: 'stdout', text: 'replayed' }],
      })
    )
    expect(await worker.next()).toEqual({ type: 'run:ack', runId: SPEC.runId, sequence: 2 })
    expect(events).toEqual(['replayed'])
    expect(await readHighestContiguousSequence(logPath())).toBe(2)
  })

  it('rejects a run the recovery declines instead of leaving the worker retrying', async () => {
    await ctx.close()
    const seen: Array<[string, string]> = []
    const recoverRun: ResumablePlaneOptions['recoverRun'] = async (runId, workerId) => {
      seen.push([runId, workerId])
      return undefined
    }
    ctx = await startServer({ reconnectTimeoutMs: 400, logsDir, recoverRun })
    const worker = await connectWorker(ctx, { workerId: 'w1', pendingRunIds: [SPEC.runId] })
    const msg = await worker.next(500)
    expect(msg).toEqual({
      type: 'run:reject',
      runId: SPEC.runId,
      reason: 'run is not recoverable on this server',
    })
    expect(seen).toEqual([[SPEC.runId, 'w1']])
  })

  it('rejects a reported run whose recovery resolves for a different worker identity', async () => {
    await ctx.close()
    const recoverRun: ResumablePlaneOptions['recoverRun'] = async (runId) => ({
      runId,
      workerId: 'someone-else',
      durableSequence: 0,
      sink: { onEvent: () => {}, onExit: () => {} },
      handle: { runId, workerId: 'someone-else', ephemeral: false, cancel: async () => {} },
    })
    ctx = await startServer({ reconnectTimeoutMs: 400, logsDir, recoverRun })
    const worker = await connectWorker(ctx, { workerId: 'w1', pendingRunIds: [SPEC.runId] })
    const msg = await worker.next(500)
    expect(msg.type).toBe('run:reject')
    if (msg.type === 'run:reject') {
      // No detail about the real owner, the run's state, or its existence.
      expect(msg.reason).toBe('run is not recoverable on this server')
      expect(msg.reason).not.toContain('someone-else')
    }
  })

  it('rejects a reported run held by another worker identity without naming the owner', async () => {
    const { worker } = await startAssignedRun('owner')
    expect(worker.ws.readyState).toBe(WebSocket.OPEN)
    const stranger = await connectWorker(ctx, {
      workerId: 'stranger',
      pendingRunIds: [SPEC.runId],
    })
    const msg = await stranger.next(500)
    expect(msg).toEqual({
      type: 'run:reject',
      runId: SPEC.runId,
      reason: 'run is not recoverable on this server',
    })
  })

  it('drops an unsequenced frame once the assignment is in sequenced delivery mode', async () => {
    const { worker, events, exits } = await startAssignedRun()

    worker.ws.send(
      JSON.stringify({
        type: 'run:event',
        runId: SPEC.runId,
        events: [{ kind: 'raw', stream: 'stdout', text: 'unsequenced' }],
      })
    )
    worker.ws.send(JSON.stringify({ type: 'run:exit', runId: SPEC.runId, status: 'completed', exitCode: 0 }))
    await new Promise((r) => setTimeout(r, 60))
    expect(events).toEqual([])
    expect(exits).toEqual([])

    worker.ws.send(
      JSON.stringify({
        type: 'run:event',
        runId: SPEC.runId,
        sequence: 2,
        events: [{ kind: 'raw', stream: 'stdout', text: 'sequenced' }],
      })
    )
    expect(await worker.next()).toEqual({ type: 'run:ack', runId: SPEC.runId, sequence: 2 })
    expect(events).toEqual(['sequenced'])
  })

  it('drops a sequenced frame once the assignment is in legacy delivery mode', async () => {
    const worker = await connectWorker(ctx, { workerId: 'legacy' })
    const events: string[] = []
    const handlePromise = ctx.controlPlane.assign(SPEC, {
      onEvent: (ev) => events.push(ev.text ?? ev.stream),
      onExit: () => {},
    })
    await worker.next()
    worker.ws.send(JSON.stringify({ type: 'run:started', runId: SPEC.runId }))
    await handlePromise

    worker.ws.send(
      JSON.stringify({
        type: 'run:event',
        runId: SPEC.runId,
        sequence: 2,
        events: [{ kind: 'raw', stream: 'stdout', text: 'sequenced' }],
      })
    )
    expect(await nextOrTimeout(worker.next, 80)).toBe('timeout')
    expect(events).toEqual([])
  })

  /**
   * A worker that already sent its terminal frame on a healthy socket has
   * nothing left to react to: its cursor covers the frame and no disconnect
   * happened. So the server has to re-drive it — the tests below only resend
   * when a `run:resume` actually arrives, exactly like the real worker.
   */
  async function startRunWithFailingExit(opts: {
    failTimes: number
    plane?: ResumablePlaneOptions
  }): Promise<{
    worker: { ws: WebSocket; next: (timeoutMs?: number) => Promise<ServerToWorkerMessage> }
    attempts: string[]
    exitFrame: Record<string, unknown>
  }> {
    await ctx.close()
    ctx = await startServer({
      reconnectTimeoutMs: 400,
      logsDir,
      exitRetryInitialDelayMs: 20,
      ...opts.plane,
    })
    const worker = await connectWorker(ctx, { workerId: 'w1' })
    const attempts: string[] = []
    let remainingFailures = opts.failTimes
    const handlePromise = ctx.controlPlane.assign(SPEC, {
      onEvent: () => {},
      onExit: async (status) => {
        attempts.push(status)
        if (remainingFailures > 0) {
          remainingFailures--
          throw new Error('db unavailable')
        }
      },
    })
    void handlePromise.catch(() => {})
    await worker.next()
    worker.ws.send(JSON.stringify({ type: 'run:started', runId: SPEC.runId, sequence: 1 }))
    expect(await worker.next()).toEqual({ type: 'run:ack', runId: SPEC.runId, sequence: 1 })
    await handlePromise
    return {
      worker,
      attempts,
      exitFrame: {
        type: 'run:exit',
        runId: SPEC.runId,
        sequence: 2,
        status: 'completed',
        exitCode: 0,
      },
    }
  }

  it('re-drives the worker with run:resume when finalization fails, then ACKs the resent terminal frame once', async () => {
    const { worker, attempts, exitFrame } = await startRunWithFailingExit({ failTimes: 1 })

    worker.ws.send(JSON.stringify(exitFrame))
    await vi.waitFor(() => {
      expect(attempts).toEqual(['completed'])
    })

    // The server must ask for the frame again; the worker never resends unasked.
    expect(await worker.next(500)).toEqual({
      type: 'run:resume',
      runId: SPEC.runId,
      sequence: 1,
    })
    worker.ws.send(JSON.stringify(exitFrame))

    expect(await worker.next(500)).toEqual({ type: 'run:ack', runId: SPEC.runId, sequence: 2 })
    expect(attempts).toEqual(['completed', 'completed'])

    // Success clears the retry timer: no further resume, and the assignment is gone.
    expect(await nextOrTimeout(worker.next, 200)).toBe('timeout')
    expect(ctx.controlPlane.activeAssignmentCount).toBe(0)

    // A late duplicate is answered from the final-ACK record, not re-finalized.
    worker.ws.send(JSON.stringify(exitFrame))
    expect(await worker.next(500)).toEqual({ type: 'run:ack', runId: SPEC.runId, sequence: 2 })
    expect(attempts).toEqual(['completed', 'completed'])
  })

  it('bounds the re-drive by the delivery window, then rejects the delivery without ever ACKing', async () => {
    const { worker, attempts, exitFrame } = await startRunWithFailingExit({
      failTimes: Number.POSITIVE_INFINITY,
      plane: { reconnectTimeoutMs: 400, exitRetryInitialDelayMs: 50, exitRetryMaxDelayMs: 100 },
    })

    worker.ws.send(JSON.stringify(exitFrame))
    const seen: ServerToWorkerMessage[] = []
    const startedAt = Date.now()
    for (;;) {
      const msg = await nextOrTimeout(worker.next, 1_500)
      if (msg === 'timeout') throw new Error(`no terminal outcome; saw ${JSON.stringify(seen)}`)
      seen.push(msg)
      if (msg.type === 'run:reject') break
      // A real worker only resends when told to.
      if (msg.type === 'run:resume') worker.ws.send(JSON.stringify(exitFrame))
    }
    const elapsed = Date.now() - startedAt

    const resumes = seen.filter((m) => m.type === 'run:resume')
    expect(resumes.length).toBeGreaterThanOrEqual(2) // it really retried
    expect(resumes.length).toBeLessThanOrEqual(12) // ...without hot-looping
    expect(elapsed).toBeGreaterThanOrEqual(300) // bounded by the window, not instant
    expect(seen.filter((m) => m.type === 'run:ack')).toEqual([])
    // One finalize per delivery (the original plus each resend), then the run is
    // failed through the normal path so it cannot sit "running" forever.
    expect(attempts.filter((s) => s === 'completed')).toHaveLength(resumes.length + 1)
    expect(attempts.at(-1)).toBe('failed')

    const reject = seen.at(-1) as { type: string; runId: string; reason: string }
    expect(reject.runId).toBe(SPEC.runId)
    expect(reject.reason).not.toMatch(/db|database|sql/i)

    // Nothing is left running: no assignment, no timer, and no late ACK.
    expect(ctx.controlPlane.activeAssignmentCount).toBe(0)
    worker.ws.send(JSON.stringify(exitFrame))
    expect(await nextOrTimeout(worker.next, 300)).toBe('timeout')
  })

  it('waits for a finalize that is still in flight rather than rejecting a frame it may yet ACK', async () => {
    await ctx.close()
    ctx = await startServer({
      reconnectTimeoutMs: 200,
      logsDir,
      exitRetryInitialDelayMs: 20,
      exitRetryMaxDelayMs: 40,
    })
    const worker = await connectWorker(ctx, { workerId: 'w1' })
    const attempts: string[] = []
    let releaseSecond = () => {}
    const secondFinalize = new Promise<void>((resolve) => {
      releaseSecond = resolve
    })
    const handlePromise = ctx.controlPlane.assign(SPEC, {
      onEvent: () => {},
      onExit: async (status) => {
        attempts.push(status)
        if (attempts.length === 1) throw new Error('db unavailable')
        // A slow commit: it outlives the re-drive window but does succeed.
        await secondFinalize
      },
    })
    void handlePromise.catch(() => {})
    await worker.next()
    worker.ws.send(JSON.stringify({ type: 'run:started', runId: SPEC.runId, sequence: 1 }))
    expect(await worker.next()).toEqual({ type: 'run:ack', runId: SPEC.runId, sequence: 1 })
    await handlePromise

    const exitFrame = {
      type: 'run:exit',
      runId: SPEC.runId,
      sequence: 2,
      status: 'completed',
      exitCode: 0,
    }
    worker.ws.send(JSON.stringify(exitFrame))
    expect(await worker.next(500)).toEqual({
      type: 'run:resume',
      runId: SPEC.runId,
      sequence: 1,
    })
    worker.ws.send(JSON.stringify(exitFrame))

    // The window lapses while the second finalize is still pending. Abandoning
    // here would reject a frame that is about to be acknowledged.
    await vi.waitFor(() => {
      expect(attempts).toHaveLength(2)
    })
    expect(await nextOrTimeout(worker.next, 500)).toBe('timeout')

    releaseSecond()
    expect(await worker.next(500)).toEqual({ type: 'run:ack', runId: SPEC.runId, sequence: 2 })
    expect(attempts).toEqual(['completed', 'completed'])
    expect(ctx.controlPlane.activeAssignmentCount).toBe(0)
  })

  it('lets a reconnect drive the resume after a detach instead of a stale retry timer', async () => {
    const { worker, attempts, exitFrame } = await startRunWithFailingExit({
      failTimes: 1,
      plane: { reconnectTimeoutMs: 2_000, exitRetryInitialDelayMs: 150 },
    })

    worker.ws.send(JSON.stringify(exitFrame))
    await vi.waitFor(() => {
      expect(attempts).toEqual(['completed'])
    })
    // Drop the socket before the re-drive fires: the reconnect owns recovery now.
    worker.ws.terminate()
    await waitDisconnected(ctx)

    const resumed = await connectWorker(ctx, {
      workerId: 'w1',
      activeRunIds: [],
      pendingRunIds: [SPEC.runId],
    })
    expect(await resumed.next(500)).toEqual({
      type: 'run:resume',
      runId: SPEC.runId,
      sequence: 1,
    })
    resumed.ws.send(JSON.stringify(exitFrame))
    expect(await resumed.next(500)).toEqual({ type: 'run:ack', runId: SPEC.runId, sequence: 2 })

    // The stale timer must not fire a second resume on the rebound socket.
    expect(await nextOrTimeout(resumed.next, 400)).toBe('timeout')
    expect(attempts).toEqual(['completed', 'completed'])
    expect(ctx.controlPlane.activeAssignmentCount).toBe(0)
  })

  it('keeps the log at its byte cap while still acknowledging and recovering the delivery cursor', async () => {
    await ctx.close()
    ctx = await startServer({ reconnectTimeoutMs: 400, logsDir, runLogMaxBytes: 400 })
    const { worker, events } = await startAssignedRun()

    const chunk = 'y'.repeat(300)
    for (let sequence = 2; sequence <= 8; sequence++) {
      worker.ws.send(
        JSON.stringify({
          type: 'run:event',
          runId: SPEC.runId,
          sequence,
          events: [{ kind: 'raw', stream: 'stdout', text: `${sequence}-${chunk}` }],
        })
      )
      expect(await worker.next(500)).toEqual({ type: 'run:ack', runId: SPEC.runId, sequence })
    }

    // Every event still reached the sink live even after the log stopped growing.
    expect(events).toHaveLength(7)
    const text = fs.readFileSync(logPath(), 'utf8')
    expect(text.match(/run log truncated on disk/g)).toHaveLength(1)
    expect(fs.statSync(logPath()).size).toBeLessThan(400 * 4)
    expect(text).not.toContain(`8-${chunk}`)

    // The durable cursor survives for a replacement process to resume from.
    expect(await readHighestContiguousSequence(logPath())).toBe(8)
  })

  it('serializes reconnect replay during a gated append so the event is applied once and ACK goes to the live socket', async () => {
    await ctx.close()
    let releaseAppend!: () => void
    const appendHeld = new Promise<void>((resolve) => {
      releaseAppend = resolve
    })
    let enteredSeq2 = 0
    const gatedOpen: OpenDeliveryLog = async (logPath, opts) => {
      const inner = await openDeliveryLog(logPath, opts)
      const gated: DeliveryLogWriter = {
        get cursor() {
          return inner.cursor
        },
        get capped() {
          return inner.capped
        },
        append: async (events, sequence) => {
          if (sequence === 2) {
            enteredSeq2++
            await appendHeld
          }
          return inner.append(events, sequence)
        },
      }
      return gated
    }
    ctx = await startServer({ reconnectTimeoutMs: 400, logsDir, openDeliveryLog: gatedOpen })

    const { worker, events } = await startAssignedRun()
    worker.ws.send(
      JSON.stringify({
        type: 'run:event',
        runId: SPEC.runId,
        sequence: 2,
        events: [{ kind: 'raw', stream: 'stdout', text: 'once' }],
      })
    )
    await vi.waitFor(() => {
      expect(enteredSeq2).toBeGreaterThanOrEqual(1)
    })

    const stale = worker
    stale.ws.terminate()
    await waitDisconnected(ctx)
    const live = await connectWorker(ctx, {
      workerId: 'w1',
      pendingRunIds: [SPEC.runId],
    })
    expect(await live.next()).toEqual({ type: 'run:resume', runId: SPEC.runId, sequence: 1 })
    live.ws.send(
      JSON.stringify({
        type: 'run:event',
        runId: SPEC.runId,
        sequence: 2,
        events: [{ kind: 'raw', stream: 'stdout', text: 'once' }],
      })
    )
    stale.ws.send(
      JSON.stringify({
        type: 'run:event',
        runId: SPEC.runId,
        sequence: 2,
        events: [{ kind: 'raw', stream: 'stdout', text: 'stale-inject' }],
      })
    )
    releaseAppend()
    expect(await live.next()).toEqual({ type: 'run:ack', runId: SPEC.runId, sequence: 2 })
    expect(events).toEqual(['once'])
    const logText = fs.readFileSync(logPath(), 'utf8')
    expect(logText.match(/"once"/g)?.length).toBe(1)
    expect(logText).not.toContain('stale-inject')
    expect(await nextOrTimeout(stale.next, 50)).toBe('timeout')
  })

  it('does not finalize twice when a slow onExit races reconnect replay', async () => {
    let releaseExit!: () => void
    const exitHeld = new Promise<void>((resolve) => {
      releaseExit = resolve
    })
    const worker = await connectWorker(ctx)
    const exits: string[] = []
    const handlePromise = ctx.controlPlane.assign(SPEC, {
      onEvent: () => {},
      onExit: async (status) => {
        exits.push(status)
        await exitHeld
      },
    })
    await worker.next()
    worker.ws.send(JSON.stringify({ type: 'run:started', runId: SPEC.runId, sequence: 1 }))
    expect(await worker.next()).toEqual({ type: 'run:ack', runId: SPEC.runId, sequence: 1 })
    await handlePromise

    worker.ws.send(
      JSON.stringify({
        type: 'run:exit',
        runId: SPEC.runId,
        sequence: 2,
        status: 'completed',
        exitCode: 0,
      })
    )
    await vi.waitFor(() => {
      expect(exits).toEqual(['completed'])
    })
    worker.ws.terminate()
    await waitDisconnected(ctx)
    const live = await connectWorker(ctx, {
      workerId: 'w1',
      pendingRunIds: [SPEC.runId],
    })
    expect(await live.next()).toEqual({ type: 'run:resume', runId: SPEC.runId, sequence: 1 })
    live.ws.send(
      JSON.stringify({
        type: 'run:exit',
        runId: SPEC.runId,
        sequence: 2,
        status: 'completed',
        exitCode: 0,
      })
    )
    await new Promise((r) => setTimeout(r, 40))
    expect(exits).toEqual(['completed'])
    releaseExit()
    expect(await live.next()).toEqual({ type: 'run:ack', runId: SPEC.runId, sequence: 2 })
    expect(exits).toEqual(['completed'])
  })

  it('does not install RecoverRun or send resume after the socket closes during recovery', async () => {
    await ctx.close()
    let releaseRecover!: () => void
    const recoverHeld = new Promise<void>((resolve) => {
      releaseRecover = resolve
    })
    let recoverCalls = 0
    const adopted: string[] = []
    const abandoned: string[] = []
    const recoverRun: ResumablePlaneOptions['recoverRun'] = async (runId, workerId) => {
      recoverCalls++
      await recoverHeld
      return {
        runId,
        workerId,
        durableSequence: 1,
        sink: { onEvent: () => {}, onExit: () => {} },
        handle: { runId, workerId, ephemeral: false, cancel: async () => {} },
        onAdopted: () => adopted.push(runId),
        onAbandoned: () => abandoned.push(runId),
      }
    }
    ctx = await startServer({ reconnectTimeoutMs: 400, logsDir, recoverRun })
    await appendSequencedEvents(logPath(), [{ kind: 'raw', stream: 'stdout', text: 'pre' }], 1)
    const first = await connectWorker(ctx, { workerId: 'w1', pendingRunIds: [SPEC.runId] })
    await vi.waitFor(() => {
      expect(recoverCalls).toBe(1)
    })
    first.ws.terminate()
    await waitDisconnected(ctx)
    releaseRecover()
    await new Promise((r) => setTimeout(r, 40))
    expect(await nextOrTimeout(first.next, 40)).toBe('timeout')
    expect(adopted).toEqual([])
    expect(abandoned).toEqual([SPEC.runId])

    const second = await connectWorker(ctx, { workerId: 'w1', pendingRunIds: [SPEC.runId] })
    expect(await second.next()).toEqual({ type: 'run:resume', runId: SPEC.runId, sequence: 1 })
    expect(recoverCalls).toBe(2)
    expect(adopted).toEqual([SPEC.runId])
  })

  it('ACKs a replacement-process terminal run:exit without re-finalizing', async () => {
    await ctx.close()
    const exits: string[] = []
    const recoverRun: ResumablePlaneOptions['recoverRun'] = async (runId, workerId) => {
      if (runId !== SPEC.runId || workerId !== 'w1') return undefined
      return { kind: 'terminal', runId, workerId, durableSequence: 2 }
    }
    ctx = await startServer({ reconnectTimeoutMs: 400, logsDir, recoverRun })
    const worker = await connectWorker(ctx, { workerId: 'w1', pendingRunIds: [SPEC.runId] })
    expect(await worker.next()).toEqual({ type: 'run:resume', runId: SPEC.runId, sequence: 2 })
    worker.ws.send(
      JSON.stringify({
        type: 'run:exit',
        runId: SPEC.runId,
        sequence: 3,
        status: 'completed',
        exitCode: 0,
      })
    )
    expect(await worker.next()).toEqual({ type: 'run:ack', runId: SPEC.runId, sequence: 3 })
    expect(exits).toEqual([])

    worker.ws.send(
      JSON.stringify({
        type: 'run:exit',
        runId: SPEC.runId,
        sequence: 3,
        status: 'completed',
        exitCode: 0,
      })
    )
    expect(await worker.next()).toEqual({ type: 'run:ack', runId: SPEC.runId, sequence: 3 })
    expect(exits).toEqual([])
  })

  it('does not adopt a terminal recovery for a mismatched workerId', async () => {
    await ctx.close()
    const recoverRun: ResumablePlaneOptions['recoverRun'] = async (runId, workerId) => {
      if (workerId !== 'w1') return undefined
      return { kind: 'terminal', runId, workerId, durableSequence: 2 }
    }
    ctx = await startServer({ reconnectTimeoutMs: 400, logsDir, recoverRun })
    const impostor = await connectWorker(ctx, { workerId: 'impostor', pendingRunIds: [SPEC.runId] })
    expect(await impostor.next(500)).toEqual({
      type: 'run:reject',
      runId: SPEC.runId,
      reason: 'run is not recoverable on this server',
    })
    impostor.ws.send(
      JSON.stringify({
        type: 'run:exit',
        runId: SPEC.runId,
        sequence: 3,
        status: 'completed',
        exitCode: 0,
      })
    )
    expect(await nextOrTimeout(impostor.next, 80)).toBe('timeout')
  })
})


