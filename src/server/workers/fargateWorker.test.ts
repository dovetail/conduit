import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as path from 'node:path'
import * as fs from 'node:fs'
import * as os from 'node:os'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import type { ECSClient } from '@aws-sdk/client-ecs'
import type { RunSpec, WorkerEventSink, WorkerHandle } from '../../shared/worker'
import type { WorkerControlPlane } from '../workerControl'
import {
  FARGATE_DEFAULT_STOP_TIMEOUT_MS,
  FARGATE_WORKER_CPU,
  FARGATE_WORKER_MEMORY_MIB,
  STOP_DEPROVISION_TIMEOUT_MS,
  STOP_VERIFY_TIMEOUT_MS,
  FargateWorkerFactory,
  buildFargateEcsClientConfig,
  resolveFargateTaskSize,
  isAllowlistedE2eModule,
  resolveFargateConfig,
  describeStoppedContainers,
  stopWaitVerdict,
  tryLoadE2eFakeEcsClient,
  type FargateWorkerConfig,
} from './fargateWorker'
import { reporter } from '../observability'

vi.mock('../observability', () => ({
  reporter: { captureException: vi.fn(), captureMessage: vi.fn() },
}))

const TASK_ARN = 'arn:aws:ecs:us-east-1:123456789012:task/conduit/abcdef0123456789'
const ROLE_ARN = 'arn:aws:iam::123456789012:role/conduit-launcher'

const SPEC: RunSpec = {
  runId: 'run-1',
  agentId: 'agent-1',
  runner: 'claude',
  prompt: 'hello',
  env: {},
  workspace: { kind: 'ephemeral' },
}

const BASE_ENV = {
  CONDUIT_FARGATE_CLUSTER: 'conduit',
  CONDUIT_FARGATE_TASK_DEFINITION: 'conduit-worker:1',
  CONDUIT_FARGATE_SUBNETS: 'subnet-aaa, subnet-bbb',
  CONDUIT_SERVER_URL: 'wss://conduit.example.test/ws/worker',
}

function baseConfig(over: Partial<FargateWorkerConfig> = {}): FargateWorkerConfig {
  return {
    cluster: 'conduit',
    taskDefinition: 'conduit-worker:1',
    containerName: 'worker',
    subnets: ['subnet-aaa', 'subnet-bbb'],
    securityGroups: ['sg-aaa'],
    assignPublicIp: 'ENABLED',
    serverUrl: 'wss://conduit.example.test/ws/worker',
    connectTimeoutMs: 5_000,
    ...over,
  }
}

class FakeEcs {
  calls: { name: string; input: Record<string, unknown> }[] = []
  runTaskResponse: unknown = { tasks: [{ taskArn: TASK_ARN }], failures: [] }
  describeResponse: unknown = {
    tasks: [{ taskArn: TASK_ARN, lastStatus: 'STOPPED', desiredStatus: 'STOPPED' }],
  }
  stopImpl: () => Promise<unknown> = async () => ({})

  async send(command: { input?: unknown }): Promise<unknown> {
    const name = command.constructor.name
    this.calls.push({ name, input: (command.input ?? {}) as Record<string, unknown> })
    if (name === 'RunTaskCommand') return this.runTaskResponse
    if (name === 'StopTaskCommand') return this.stopImpl()
    if (name === 'DescribeTasksCommand') return this.describeResponse
    return {}
  }

  of(name: string): Record<string, unknown>[] {
    return this.calls.filter((c) => c.name === name).map((c) => c.input)
  }
}

function fakeControlPlane(
  over: {
    assignTo?: WorkerControlPlane['assignTo']
  } = {}
): {
  plane: WorkerControlPlane
  assignTo: ReturnType<typeof vi.fn>
  cancelAssignTo: ReturnType<typeof vi.fn>
  lastSink: () => WorkerEventSink
} {
  let lastSink: WorkerEventSink | undefined
  const assignTo = vi.fn(async (workerId: string, spec: RunSpec, sink: WorkerEventSink) => {
    lastSink = sink
    return {
      runId: spec.runId,
      ephemeral: false,
      workerId,
      cancel: vi.fn(async () => {}),
    } satisfies WorkerHandle
  })
  const cancelAssignTo = vi.fn()
  if (over.assignTo) assignTo.mockImplementation(over.assignTo)
  return {
    plane: { assignTo, cancelAssignTo } as unknown as WorkerControlPlane,
    assignTo,
    cancelAssignTo,
    lastSink: () => {
      if (!lastSink) throw new Error('assignTo was not called')
      return lastSink
    },
  }
}

function envNames(input: Record<string, unknown>): string[] {
  const overrides = input.overrides as {
    containerOverrides: { environment?: { name: string; value: string }[] }[]
  }
  return (overrides.containerOverrides[0].environment ?? []).map((e) => e.name)
}

describe('resolveFargateTaskSize', () => {
  it('defaults to 2 vCPU / 8192 MiB', () => {
    expect(resolveFargateTaskSize()).toEqual({ cpu: '2048', memory: '8192' })
    expect(resolveFargateTaskSize(undefined)).toEqual({ cpu: '2048', memory: '8192' })
  })

  it('accepts the top of the 2 vCPU range', () => {
    expect(resolveFargateTaskSize(16384)).toEqual({ cpu: '2048', memory: '16384' })
    expect(resolveFargateTaskSize(4096)).toEqual({ cpu: '2048', memory: '4096' })
  })

  it('rejects sizes outside the 2 vCPU range or off the 1024 step', () => {
    for (const memory of [2048, 9000, 32768, 8192.5]) {
      expect(() => resolveFargateTaskSize(memory)).toThrow(/4096–16384/)
    }
  })
})

describe('resolveFargateConfig', () => {
  it('requires cluster, task definition, and subnets', () => {
    expect(() => resolveFargateConfig({ CONDUIT_SERVER_URL: 'wss://x' })).toThrow(
      /CONDUIT_FARGATE_CLUSTER.*CONDUIT_FARGATE_TASK_DEFINITION.*CONDUIT_FARGATE_SUBNETS/
    )
  })

  it('reads connect and assign timeouts from the supplied env, not import-time globals', () => {
    const cfg = resolveFargateConfig({
      ...BASE_ENV,
      CONDUIT_WORKER_CONNECT_TIMEOUT_MS: '12000',
      CONDUIT_WORKER_ASSIGN_TIMEOUT_MS: '1500',
    })
    expect(cfg.connectTimeoutMs).toBe(12_000)
    expect(cfg.assignTimeoutMs).toBe(1_500)
  })

  it('parses optional CONDUIT_FARGATE_ROLE_ARN', () => {
    const cfg = resolveFargateConfig({ ...BASE_ENV, CONDUIT_FARGATE_ROLE_ARN: ROLE_ARN })
    expect(cfg.roleArn).toBe(ROLE_ARN)
  })

  it('omits roleArn when CONDUIT_FARGATE_ROLE_ARN is unset', () => {
    expect(resolveFargateConfig(BASE_ENV).roleArn).toBeUndefined()
  })
})

describe('tryLoadE2eFakeEcsClient', () => {
  const e2eModule = path.resolve(process.cwd(), 'e2e/fargate/fakeEcs.cjs')

  it('is a no-op unless CONDUIT_FARGATE_E2E_FAKE_ECS is set', () => {
    expect(tryLoadE2eFakeEcsClient({})).toBeUndefined()
    expect(tryLoadE2eFakeEcsClient({ CONDUIT_E2E: '1', CONDUIT_FARGATE_E2E_FAKE_ECS: '  ' })).toBeUndefined()
  })

  it('refuses to load when NODE_ENV=production', () => {
    expect(() =>
      tryLoadE2eFakeEcsClient({
        NODE_ENV: 'production',
        CONDUIT_E2E: '1',
        CONDUIT_FARGATE_E2E_FAKE_ECS: e2eModule,
      })
    ).toThrow(/NODE_ENV=production/)
  })

  it('requires CONDUIT_E2E=1', () => {
    expect(() => tryLoadE2eFakeEcsClient({ CONDUIT_FARGATE_E2E_FAKE_ECS: e2eModule })).toThrow(
      /CONDUIT_E2E=1/
    )
  })

  it('allowlists only paths under e2e/', () => {
    expect(isAllowlistedE2eModule(e2eModule)).toBe(true)
    expect(isAllowlistedE2eModule(path.resolve(process.cwd(), 'src/server/workers/fargateWorker.ts'))).toBe(
      false
    )
    expect(isAllowlistedE2eModule(path.resolve(process.cwd(), 'e2e/../package.json'))).toBe(false)
    expect(() =>
      tryLoadE2eFakeEcsClient({
        CONDUIT_E2E: '1',
        CONDUIT_FARGATE_E2E_FAKE_ECS: path.resolve(process.cwd(), 'package.json'),
      })
    ).toThrow(/must resolve under e2e\//)
  })

  it('loads createFakeEcsClient from the e2e module path when CONDUIT_E2E=1', () => {
    const client = tryLoadE2eFakeEcsClient({
      CONDUIT_E2E: '1',
      CONDUIT_FARGATE_E2E_FAKE_ECS: e2eModule,
    })
    expect(client).toBeDefined()
    expect(typeof client?.send).toBe('function')
  })
})

describe('fake ECS state hydration', () => {
  const requireE2e = createRequire(path.join(process.cwd(), 'package.json'))
  const e2eModule = path.resolve(process.cwd(), 'e2e/fargate/fakeEcs.cjs')
  let tmpDir: string
  let child: ReturnType<typeof spawn> | undefined
  const prevState = process.env.CONDUIT_FARGATE_E2E_STATE
  const prevSkip = process.env.CONDUIT_FARGATE_E2E_SKIP_SPAWN

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'conduit-fake-ecs-'))
  })

  afterEach(() => {
    if (prevState === undefined) delete process.env.CONDUIT_FARGATE_E2E_STATE
    else process.env.CONDUIT_FARGATE_E2E_STATE = prevState
    if (prevSkip === undefined) delete process.env.CONDUIT_FARGATE_E2E_SKIP_SPAWN
    else process.env.CONDUIT_FARGATE_E2E_SKIP_SPAWN = prevSkip
    if (child?.pid) {
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {
        try {
          process.kill(child.pid, 'SIGKILL')
        } catch {
          // gone
        }
      }
    }
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('reloads a surviving task PID without spawning a duplicate or wiping state', async () => {
    const stateFile = path.join(tmpDir, 'fake-ecs.json')
    const arn = 'arn:aws:ecs:local:000000000000:task/conduit-e2e/00000001'
    child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      detached: true,
      stdio: 'ignore',
    })
    child.unref()
    fs.writeFileSync(
      stateFile,
      JSON.stringify({
        seq: 1,
        runTasks: [{ taskArn: arn, runId: 'run-hydrate', workerId: 'fargate-run-hydrate', skippedSpawn: false }],
        tasks: {
          [arn]: {
            lastStatus: 'RUNNING',
            workerPid: child.pid,
            supervisorPid: child.pid,
            pgid: child.pid,
            workerId: 'fargate-run-hydrate',
            runId: 'run-hydrate',
          },
        },
      })
    )
    process.env.CONDUIT_FARGATE_E2E_STATE = stateFile
    process.env.CONDUIT_FARGATE_E2E_SKIP_SPAWN = path.join(tmpDir, 'skip-spawn')
    fs.writeFileSync(process.env.CONDUIT_FARGATE_E2E_SKIP_SPAWN, '1')

    const { createFakeEcsClient } = requireE2e(e2eModule) as {
      createFakeEcsClient: () => {
        send: (command: { input?: unknown }) => Promise<unknown>
      }
    }
    const client = createFakeEcsClient()

    const persisted = JSON.parse(fs.readFileSync(stateFile, 'utf8')) as {
      tasks: Record<string, { lastStatus: string; workerPid: number | null; runId: string }>
    }
    expect(persisted.tasks[arn]?.workerPid).toBe(child.pid)
    expect(persisted.tasks[arn]?.lastStatus).toBe('RUNNING')

    class DescribeTasksCommand {
      input: { tasks: string[] }
      constructor(input: { tasks: string[] }) {
        this.input = input
      }
    }
    const described = (await client.send(new DescribeTasksCommand({ tasks: [arn] }))) as {
      tasks: { taskArn: string; lastStatus: string; desiredStatus: string }[]
    }
    expect(described.tasks).toEqual([
      { taskArn: arn, lastStatus: 'RUNNING', desiredStatus: 'RUNNING' },
    ])

    class RunTaskCommand {
      input: { overrides?: { containerOverrides?: { environment?: { name: string; value: string }[] }[] } }
      constructor(input: RunTaskCommand['input']) {
        this.input = input
      }
    }
    const spawned = (await client.send(
      new RunTaskCommand({
        overrides: { containerOverrides: [{ environment: [{ name: 'CONDUIT_WORKER_ID', value: 'fargate-new' }] }] },
      })
    )) as { tasks: { taskArn: string }[] }
    expect(spawned.tasks[0]?.taskArn).not.toBe(arn)
    const afterRun = JSON.parse(fs.readFileSync(stateFile, 'utf8')) as {
      tasks: Record<string, { workerPid: number | null }>
    }
    expect(afterRun.tasks[arn]?.workerPid).toBe(child.pid)
  })

  it('keeps skip-spawn tasks RUNNING until StopTask so connect-timeout still works', async () => {
    const stateFile = path.join(tmpDir, 'fake-ecs.json')
    const skipFile = path.join(tmpDir, 'skip-spawn')
    process.env.CONDUIT_FARGATE_E2E_STATE = stateFile
    process.env.CONDUIT_FARGATE_E2E_SKIP_SPAWN = skipFile
    fs.writeFileSync(skipFile, '1')

    const { createFakeEcsClient } = requireE2e(e2eModule) as {
      createFakeEcsClient: () => { send: (command: { input?: unknown }) => Promise<unknown> }
    }
    const client = createFakeEcsClient()

    class RunTaskCommand {
      input: { overrides?: { containerOverrides?: { environment?: { name: string; value: string }[] }[] } }
      constructor(input: RunTaskCommand['input']) {
        this.input = input
      }
    }
    class DescribeTasksCommand {
      input: { tasks: string[] }
      constructor(input: { tasks: string[] }) {
        this.input = input
      }
    }
    const spawned = (await client.send(
      new RunTaskCommand({
        overrides: { containerOverrides: [{ environment: [{ name: 'CONDUIT_WORKER_ID', value: 'fargate-skip' }] }] },
      })
    )) as { tasks: { taskArn: string }[] }
    const arn = spawned.tasks[0]?.taskArn
    expect(arn).toBeTruthy()
    const described = (await client.send(new DescribeTasksCommand({ tasks: [arn!] }))) as {
      tasks: { lastStatus: string }[]
    }
    expect(described.tasks[0]?.lastStatus).toBe('RUNNING')
  })

  it('merges concurrent STOPPED exit metadata over a RUNNING persist', () => {
    const { mergeSnapshots } = requireE2e(e2eModule) as {
      mergeSnapshots: (disk: object, incoming: object) => {
        seq: number
        runTasks: { taskArn: string }[]
        tasks: Record<
          string,
          {
            lastStatus: string
            exitCode: number | null
            retryTimestamps: number[]
            supervisorPid: number | null
            workerPid: number | null
          }
        >
      }
    }
    const arn = 'arn:aws:ecs:local:000000000000:task/conduit-e2e/00000001'
    const arn2 = 'arn:aws:ecs:local:000000000000:task/conduit-e2e/00000002'
    const merged = mergeSnapshots(
      {
        seq: 1,
        runTasks: [{ taskArn: arn, runId: 'r1' }],
        tasks: {
          [arn]: {
            lastStatus: 'RUNNING',
            supervisorPid: 11,
            workerPid: 12,
            retryTimestamps: [100],
          },
        },
      },
      {
        seq: 4,
        runTasks: [{ taskArn: arn2, runId: 'r2' }],
        tasks: {
          [arn]: {
            lastStatus: 'STOPPED',
            exitCode: 7,
            retryTimestamps: [200],
            supervisorPid: 11,
            workerPid: 12,
          },
        },
      }
    )
    expect(merged.seq).toBe(4)
    expect(merged.runTasks.map((r) => r.taskArn).sort()).toEqual([arn, arn2].sort())
    expect(merged.tasks[arn]?.lastStatus).toBe('STOPPED')
    expect(merged.tasks[arn]?.exitCode).toBe(7)
    expect(merged.tasks[arn]?.retryTimestamps).toEqual([100, 200])
    expect(merged.tasks[arn]?.supervisorPid).toBe(11)
    expect(merged.tasks[arn]?.workerPid).toBe(12)
  })

  it('does not let a later RUNNING write revive a STOPPED task or drop pids', () => {
    const { mergeSnapshots } = requireE2e(e2eModule) as {
      mergeSnapshots: (disk: object, incoming: object) => {
        tasks: Record<
          string,
          { lastStatus: string; exitCode: number | null; supervisorPid: number | null; workerPid: number | null }
        >
      }
    }
    const arn = 'arn:aws:ecs:local:000000000000:task/conduit-e2e/00000001'
    const merged = mergeSnapshots(
      {
        seq: 1,
        runTasks: [{ taskArn: arn }],
        tasks: {
          [arn]: {
            lastStatus: 'STOPPED',
            exitCode: 1,
            supervisorPid: 21,
            workerPid: 22,
            retryTimestamps: [1],
          },
        },
      },
      {
        seq: 1,
        runTasks: [{ taskArn: arn }],
        tasks: {
          [arn]: { lastStatus: 'RUNNING', supervisorPid: 21, workerPid: null, retryTimestamps: [] },
        },
      }
    )
    expect(merged.tasks[arn]?.lastStatus).toBe('STOPPED')
    expect(merged.tasks[arn]?.exitCode).toBe(1)
    expect(merged.tasks[arn]?.workerPid).toBe(22)
    expect(merged.tasks[arn]?.supervisorPid).toBe(21)
  })

  it('hydrates a legacy pid field as workerPid when supervisorPid is absent', () => {
    const { mergeSnapshots } = requireE2e(e2eModule) as {
      mergeSnapshots: (disk: object, incoming: object) => {
        tasks: Record<string, { workerPid: number | null; supervisorPid: number | null }>
      }
    }
    const arn = 'arn:aws:ecs:local:000000000000:task/conduit-e2e/00000001'
    const merged = mergeSnapshots(
      {},
      {
        seq: 1,
        runTasks: [{ taskArn: arn }],
        tasks: { [arn]: { lastStatus: 'RUNNING', pid: 99 } },
      }
    )
    expect(merged.tasks[arn]?.workerPid).toBe(99)
    expect(merged.tasks[arn]?.supervisorPid).toBeNull()
  })

  it('child-process writers cannot lose STOPPED exit metadata', async () => {
    const { persistSnapshot } = requireE2e(e2eModule) as {
      persistSnapshot: (incoming: object) => void
    }
    expect(typeof persistSnapshot).toBe('function')
    const stateFile = path.join(tmpDir, 'fake-ecs.json')
    const arn = 'arn:aws:ecs:local:000000000000:task/conduit-e2e/00000001'
    const arn2 = 'arn:aws:ecs:local:000000000000:task/conduit-e2e/00000002'
    process.env.CONDUIT_FARGATE_E2E_STATE = stateFile
    persistSnapshot({
      seq: 1,
      runTasks: [{ taskArn: arn, runId: 'r1' }],
      tasks: {
        [arn]: {
          lastStatus: 'RUNNING',
          supervisorPid: 11,
          workerPid: 12,
          retryTimestamps: [100],
        },
      },
    })
    const go = path.join(tmpDir, 'go')
    const script = `
      const fs = require('node:fs')
      const { persistSnapshot } = require(${JSON.stringify(e2eModule)})
      const go = process.argv[1]
      const patch = JSON.parse(process.argv[2])
      while (!fs.existsSync(go)) {}
      persistSnapshot(patch)
    `
    const stopped = spawn(process.execPath, [
      '-e',
      script,
      go,
      JSON.stringify({
        seq: 1,
        runTasks: [{ taskArn: arn, runId: 'r1' }],
        tasks: {
          [arn]: {
            lastStatus: 'STOPPED',
            exitCode: 7,
            retryTimestamps: [200],
            supervisorPid: 11,
            workerPid: 12,
          },
        },
      }),
    ], { env: { ...process.env, CONDUIT_FARGATE_E2E_STATE: stateFile }, stdio: 'ignore' })
    const running = spawn(process.execPath, [
      '-e',
      script,
      go,
      JSON.stringify({
        seq: 4,
        runTasks: [{ taskArn: arn2, runId: 'r2' }],
        tasks: {
          [arn]: { lastStatus: 'RUNNING', supervisorPid: 11, retryTimestamps: [] },
        },
      }),
    ], { env: { ...process.env, CONDUIT_FARGATE_E2E_STATE: stateFile }, stdio: 'ignore' })
    await new Promise((r) => setTimeout(r, 80))
    fs.writeFileSync(go, '1')
    await Promise.all([
      new Promise((resolve) => stopped.once('exit', resolve)),
      new Promise((resolve) => running.once('exit', resolve)),
    ])
    const snap = JSON.parse(fs.readFileSync(stateFile, 'utf8')) as {
      seq: number
      runTasks: { taskArn: string }[]
      tasks: Record<string, { lastStatus: string; exitCode: number | null; retryTimestamps: number[] }>
    }
    expect(snap.tasks[arn]?.lastStatus).toBe('STOPPED')
    expect(snap.tasks[arn]?.exitCode).toBe(7)
    expect(snap.tasks[arn]?.retryTimestamps).toEqual([100, 200])
    expect(snap.seq).toBe(4)
    expect(snap.runTasks.map((r) => r.taskArn).sort()).toEqual([arn, arn2].sort())
  })

  it('retains supervisor/worker pids after STOPPED so cleanup can kill leaked descendants', () => {
    const { persistSnapshot, cleanupPidsForTask } = requireE2e(e2eModule) as {
      persistSnapshot: (incoming: object) => void
      cleanupPidsForTask: (task: object) => number[]
    }
    const stateFile = path.join(tmpDir, 'fake-ecs.json')
    process.env.CONDUIT_FARGATE_E2E_STATE = stateFile
    persistSnapshot({
      seq: 1,
      runTasks: [],
      tasks: {
        arn1: {
          lastStatus: 'STOPPED',
          supervisorPid: 31,
          workerPid: 32,
          pgid: 31,
          exitCode: 1,
        },
      },
    })
    const snap = JSON.parse(fs.readFileSync(stateFile, 'utf8')) as {
      tasks: Record<string, { lastStatus: string; supervisorPid: number; workerPid: number; pgid: number }>
    }
    expect(snap.tasks.arn1.lastStatus).toBe('STOPPED')
    expect(snap.tasks.arn1.supervisorPid).toBe(31)
    expect(snap.tasks.arn1.workerPid).toBe(32)
    expect(cleanupPidsForTask(snap.tasks.arn1).sort()).toEqual([31, 32])
  })

  it('kills a leaked worker via retained supervisor pgid when supervisor died before workerPid patch', async () => {
    const { persistSnapshot, killRecordedTasks } = requireE2e(e2eModule) as {
      persistSnapshot: (incoming: object) => void
      killRecordedTasks: (stateFile: string) => void
    }
    const stateFile = path.join(tmpDir, 'fake-ecs.json')
    process.env.CONDUIT_FARGATE_E2E_STATE = stateFile
    const workerPidFile = path.join(tmpDir, 'worker.pid')
    child = spawn(
      process.execPath,
      [
        '-e',
        `
          const { spawn } = require('node:child_process')
          const fs = require('node:fs')
          const worker = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
          fs.writeFileSync(${JSON.stringify(workerPidFile)}, String(worker.pid))
          setInterval(() => {}, 1000)
        `,
      ],
      { detached: true, stdio: 'ignore' }
    )
    child.unref()
    const supervisor = child
    const started = Date.now()
    while (!fs.existsSync(workerPidFile) && Date.now() - started < 5000) {
      await new Promise((r) => setTimeout(r, 20))
    }
    const workerPid = Number(fs.readFileSync(workerPidFile, 'utf8'))
    expect(workerPid).toBeGreaterThan(0)
    persistSnapshot({
      seq: 1,
      runTasks: [],
      tasks: {
        leak: {
          lastStatus: 'STOPPED',
          supervisorPid: supervisor.pid,
          pgid: supervisor.pid,
          workerPid: null,
        },
      },
    })
    try {
      process.kill(supervisor.pid!, 'SIGKILL')
    } catch {
      // already gone
    }
    await new Promise((r) => setTimeout(r, 50))
    try {
      process.kill(workerPid, 0)
    } catch {
      throw new Error('worker died with supervisor; test needs a leaked descendant')
    }
    killRecordedTasks(stateFile)
    const deadSince = Date.now()
    while (Date.now() - deadSince < 2000) {
      try {
        process.kill(workerPid, 0)
        await new Promise((r) => setTimeout(r, 20))
      } catch {
        break
      }
    }
    expect(() => process.kill(workerPid, 0)).toThrow()
  })
})

/**
 * Mutual exclusion of the cross-process state lock, tested with real barriers
 * rather than by racing and hoping. Each test puts the lock into one exact
 * contended shape, then proves a competing writer waits instead of entering —
 * the property every merge in this harness depends on.
 */
describe('fake ECS state lock', () => {
  const requireE2e = createRequire(path.join(process.cwd(), 'package.json'))
  const e2eModule = path.resolve(process.cwd(), 'e2e/fargate/fakeEcs.cjs')
  let tmpDir: string
  let kids: ReturnType<typeof spawn>[] = []
  const prevState = process.env.CONDUIT_FARGATE_E2E_STATE

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'conduit-fake-ecs-lock-'))
    kids = []
  })

  afterEach(() => {
    for (const kid of kids) {
      if (!kid.pid) continue
      try {
        process.kill(kid.pid, 'SIGKILL')
      } catch {
        // already gone
      }
    }
    if (prevState === undefined) delete process.env.CONDUIT_FARGATE_E2E_STATE
    else process.env.CONDUIT_FARGATE_E2E_STATE = prevState
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  /** Spawn a child, capturing its exit up front so a fast exit cannot be missed. */
  function spawnKid(script: string, stateFile: string, args: string[] = []) {
    const kid = spawn(process.execPath, ['-e', script, ...args], {
      env: { ...process.env, CONDUIT_FARGATE_E2E_STATE: stateFile },
      stdio: 'ignore',
    })
    kids.push(kid)
    const exited = new Promise<void>((resolve) => kid.once('exit', () => resolve()))
    return { kid, exited }
  }

  /** A child that persists one patch, then marks a file so we can see it entered. */
  function spawnWriter(stateFile: string, doneFile: string, patch: object) {
    return spawnKid(
      `
        const fs = require('node:fs')
        const { persistSnapshot } = require(${JSON.stringify(e2eModule)})
        persistSnapshot(JSON.parse(process.argv[1]))
        fs.writeFileSync(${JSON.stringify(doneFile)}, '1')
      `,
      stateFile,
      [JSON.stringify(patch)]
    )
  }

  const settle = (ms: number) => new Promise((r) => setTimeout(r, ms))

  async function waitFor(file: string, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (fs.existsSync(file)) return true
      await settle(10)
    }
    return false
  }

  const patch = { seq: 2, runTasks: [], tasks: { t: { lastStatus: 'RUNNING' } } }

  it('does not enter a lock whose owner has not been recorded yet', async () => {
    const stateFile = path.join(tmpDir, 'fake-ecs.json')
    const doneFile = path.join(tmpDir, 'done')
    // Exactly the state a holder publishes in the window between claiming the
    // lock and recording who owns it. Unowned must not mean unheld.
    fs.writeFileSync(`${stateFile}.lock`, '')

    const { exited } = spawnWriter(stateFile, doneFile, patch)
    await settle(200)
    expect(fs.existsSync(doneFile)).toBe(false)
    expect(fs.existsSync(stateFile)).toBe(false)

    fs.rmSync(`${stateFile}.lock`, { recursive: true, force: true })
    expect(await waitFor(doneFile, 5_000)).toBe(true)
    await exited
    expect(JSON.parse(fs.readFileSync(stateFile, 'utf8')).tasks.t.lastStatus).toBe('RUNNING')
  })

  it('does not enter a claimed lock directory that has no owner file yet', async () => {
    const stateFile = path.join(tmpDir, 'fake-ecs.json')
    const doneFile = path.join(tmpDir, 'done')
    fs.mkdirSync(`${stateFile}.lock`)

    const { exited } = spawnWriter(stateFile, doneFile, patch)
    await settle(200)
    expect(fs.existsSync(doneFile)).toBe(false)

    fs.rmSync(`${stateFile}.lock`, { recursive: true, force: true })
    expect(await waitFor(doneFile, 5_000)).toBe(true)
    await exited
    expect(JSON.parse(fs.readFileSync(stateFile, 'utf8')).tasks.t.lastStatus).toBe('RUNNING')
  })

  it('waits for a live holder and proceeds the moment it releases', async () => {
    const { acquireLock, releaseLock } = requireE2e(e2eModule) as {
      acquireLock: () => void
      releaseLock: () => void
    }
    const stateFile = path.join(tmpDir, 'fake-ecs.json')
    const doneFile = path.join(tmpDir, 'done')
    process.env.CONDUIT_FARGATE_E2E_STATE = stateFile

    acquireLock()
    const { exited } = spawnWriter(stateFile, doneFile, patch)
    await settle(200)
    expect(fs.existsSync(doneFile)).toBe(false)

    releaseLock()
    expect(await waitFor(doneFile, 5_000)).toBe(true)
    await exited
  })

  it('reclaims a lock whose owner is gone, without waiting forever', async () => {
    const { acquireLock } = requireE2e(e2eModule) as { acquireLock: () => void }
    const stateFile = path.join(tmpDir, 'fake-ecs.json')
    const doneFile = path.join(tmpDir, 'done')

    // A holder that dies mid-transaction: the lock outlives the process.
    const holder = spawnKid(
      `
        const fs = require('node:fs')
        const { acquireLock } = require(${JSON.stringify(e2eModule)})
        acquireLock()
        fs.writeFileSync(${JSON.stringify(path.join(tmpDir, 'held'))}, '1')
        setInterval(() => {}, 1000)
      `,
      stateFile
    )
    expect(await waitFor(path.join(tmpDir, 'held'), 5_000)).toBe(true)
    process.kill(holder.kid.pid!, 'SIGKILL')
    await holder.exited

    const { exited } = spawnWriter(stateFile, doneFile, patch)
    expect(await waitFor(doneFile, 10_000)).toBe(true)
    await exited
    // And the reclaiming process really owned it: it could lock again cleanly.
    process.env.CONDUIT_FARGATE_E2E_STATE = stateFile
    expect(() => acquireLock()).not.toThrow()
  })

  it('keeps every concurrent writer\u2019s update when many processes pile on at once', async () => {
    const stateFile = path.join(tmpDir, 'fake-ecs.json')
    const writers = 8
    const started = Array.from({ length: writers }, (_, i) =>
      spawnWriter(stateFile, path.join(tmpDir, `done-${i}`), {
        seq: i + 1,
        runTasks: [{ taskArn: `arn:aws:ecs:local:000000000000:task/conduit-e2e/0000000${i + 1}` }],
        tasks: { [`t${i}`]: { lastStatus: 'STOPPED', exitCode: i } },
      })
    )
    await Promise.all(started.map((s) => s.exited))

    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
    // A lost update means a writer read a snapshot another writer was mid-way
    // through replacing — exactly what the lock exists to prevent.
    for (let i = 0; i < writers; i++) {
      expect(state.tasks[`t${i}`]?.exitCode, `writer ${i} was lost`).toBe(i)
    }
    expect(fs.existsSync(`${stateFile}.lock`)).toBe(false)
  }, 30_000)

  it('never releases a lock another process owns', async () => {
    const { acquireLock, releaseLock } = requireE2e(e2eModule) as {
      acquireLock: () => void
      releaseLock: () => void
    }
    const stateFile = path.join(tmpDir, 'fake-ecs.json')
    process.env.CONDUIT_FARGATE_E2E_STATE = stateFile
    acquireLock()

    const intruder = spawnKid(`require(${JSON.stringify(e2eModule)}).releaseLock()`, stateFile)
    await intruder.exited

    expect(fs.existsSync(`${stateFile}.lock`)).toBe(true)
    releaseLock()
    expect(fs.existsSync(`${stateFile}.lock`)).toBe(false)
  })
})

describe('buildFargateEcsClientConfig', () => {
  it('does not assume a role when roleArn is unset', () => {
    expect(buildFargateEcsClientConfig(baseConfig()).credentials).toBeUndefined()
  })

  it('assumes CONDUIT_FARGATE_ROLE_ARN for ECS calls', () => {
    const ecsConfig = buildFargateEcsClientConfig(baseConfig({ roleArn: ROLE_ARN }))
    expect(ecsConfig.credentials).toBeDefined()
  })
})

describe('describeStoppedContainers', () => {
  it('reports exit code and reason per container, and the stop code', () => {
    expect(
      describeStoppedContainers({
        containers: [
          { name: 'worker', exitCode: 1 },
          { name: 'sidecar', reason: 'CannotPullContainerError' },
          { name: 'idle' },
        ],
        stopCode: 'TaskFailedToStart',
      })
    ).toBe('container worker exited 1; container sidecar CannotPullContainerError; stop code TaskFailedToStart')
  })

  it('is empty when ECS recorded nothing', () => {
    expect(describeStoppedContainers(undefined)).toBe('')
    expect(describeStoppedContainers({ containers: [{ name: 'worker' }] })).toBe('')
  })
})

describe('FargateWorkerFactory', () => {
  let ecs: FakeEcs
  let cp: ReturnType<typeof fakeControlPlane>
  let factory: FargateWorkerFactory
  const sink: WorkerEventSink = { onEvent: () => {}, onExit: () => {} }

  beforeEach(() => {
    ecs = new FakeEcs()
    cp = fakeControlPlane()
    factory = new FargateWorkerFactory(cp.plane, baseConfig(), ecs as unknown as ECSClient, {
      uncleanRetryMs: 0,
    })
  })

  it('waits longer than Fargate default stopTimeout before giving up on STOPPED', () => {
    expect(STOP_VERIFY_TIMEOUT_MS).toBeGreaterThan(FARGATE_DEFAULT_STOP_TIMEOUT_MS)
    expect(STOP_DEPROVISION_TIMEOUT_MS).toBeGreaterThan(STOP_VERIFY_TIMEOUT_MS)
  })

  it('keeps polling a stop ECS has already accepted instead of failing at the verify cap', () => {
    const deprovisioning = { lastStatus: 'DEPROVISIONING', desiredStatus: 'STOPPED' }
    expect(stopWaitVerdict(deprovisioning, STOP_VERIFY_TIMEOUT_MS, STOP_VERIFY_TIMEOUT_MS, STOP_DEPROVISION_TIMEOUT_MS)).toBe(
      'continue'
    )
    expect(stopWaitVerdict(deprovisioning, STOP_DEPROVISION_TIMEOUT_MS, STOP_VERIFY_TIMEOUT_MS, STOP_DEPROVISION_TIMEOUT_MS)).toBe(
      'deprovision-stuck'
    )
    expect(stopWaitVerdict({ lastStatus: 'RUNNING', desiredStatus: 'STOPPED' }, 1_000, 60_000, 600_000)).toBe('continue')
    expect(stopWaitVerdict({ lastStatus: 'RUNNING', desiredStatus: 'RUNNING' }, 60_000, 60_000, 600_000)).toBe(
      'not-accepted'
    )
    expect(stopWaitVerdict({ lastStatus: 'STOPPED', desiredStatus: 'STOPPED' }, 0, 60_000, 600_000)).toBe('stopped')
    expect(stopWaitVerdict(undefined, 0, 60_000, 600_000)).toBe('stopped')
  })

  it('does not report a stop failure while the task is still deprovisioning', async () => {
    vi.mocked(reporter.captureMessage).mockClear()
    factory = new FargateWorkerFactory(cp.plane, baseConfig(), ecs as unknown as ECSClient, {
      uncleanRetryMs: 0,
      stopVerifyTimeoutMs: 30,
      stopDeprovisionTimeoutMs: 5_000,
      stopBackoffMs: 1,
      stopAttempts: 1,
    })
    let describes = 0
    const original = ecs.send.bind(ecs)
    ecs.send = async (command) => {
      if (command.constructor.name === 'DescribeTasksCommand') {
        describes++
        ecs.calls.push({ name: 'DescribeTasksCommand', input: (command.input ?? {}) as Record<string, unknown> })
        if (describes < 4) {
          return { tasks: [{ taskArn: TASK_ARN, lastStatus: 'DEPROVISIONING', desiredStatus: 'STOPPED' }] }
        }
        return { tasks: [{ taskArn: TASK_ARN, lastStatus: 'STOPPED', desiredStatus: 'STOPPED' }] }
      }
      return original(command)
    }
    const handle = await factory.startRun(SPEC, sink)
    await expect(handle.cancel()).resolves.toBeUndefined()
    expect(describes).toBeGreaterThanOrEqual(4)
    expect(reporter.captureMessage).not.toHaveBeenCalled()
    expect(ecs.of('StopTaskCommand')).toHaveLength(1)
  })

  it('reports a stuck RUNNING task once, with the status ECS actually returned', async () => {
    vi.mocked(reporter.captureMessage).mockClear()
    factory = new FargateWorkerFactory(cp.plane, baseConfig(), ecs as unknown as ECSClient, {
      uncleanRetryMs: 0,
      stopVerifyTimeoutMs: 40,
      stopDeprovisionTimeoutMs: 5_000,
      stopBackoffMs: 1,
      stopAttempts: 2,
    })
    const original = ecs.send.bind(ecs)
    ecs.send = async (command) => {
      if (command.constructor.name === 'DescribeTasksCommand') {
        ecs.calls.push({ name: 'DescribeTasksCommand', input: (command.input ?? {}) as Record<string, unknown> })
        return {
          tasks: [
            {
              taskArn: TASK_ARN,
              lastStatus: 'RUNNING',
              desiredStatus: 'RUNNING',
              stoppedReason: 'still going',
            },
          ],
        }
      }
      return original(command)
    }
    const handle = await factory.startRun(SPEC, sink)
    await expect(handle.cancel()).rejects.toThrow(/RUNNING/)
    expect(ecs.of('StopTaskCommand')).toHaveLength(2)
    expect(reporter.captureMessage).toHaveBeenCalledTimes(1)
    expect(vi.mocked(reporter.captureMessage).mock.calls[0]?.[0]).toMatch(/RUNNING/)
    expect(vi.mocked(reporter.captureMessage).mock.calls[0]?.[2]).toMatchObject({
      extra: { lastStatus: 'RUNNING', desiredStatus: 'RUNNING' },
    })
  })

  it('waits out the deprovision budget once instead of retrying StopTask on every slice', async () => {
    vi.mocked(reporter.captureMessage).mockClear()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    factory = new FargateWorkerFactory(cp.plane, baseConfig(), ecs as unknown as ECSClient, {
      uncleanRetryMs: 25,
      stopVerifyTimeoutMs: 20,
      stopDeprovisionTimeoutMs: 80,
      stopBackoffMs: 1,
      stopAttempts: 3,
      shutdownDeadlineMs: 40,
    })
    const original = ecs.send.bind(ecs)
    ecs.send = async (command) => {
      if (command.constructor.name === 'DescribeTasksCommand') {
        ecs.calls.push({ name: 'DescribeTasksCommand', input: (command.input ?? {}) as Record<string, unknown> })
        return { tasks: [{ taskArn: TASK_ARN, lastStatus: 'DEPROVISIONING', desiredStatus: 'STOPPED' }] }
      }
      return original(command)
    }
    const handle = await factory.startRun(SPEC, sink)
    // Stop was accepted; lingering DEPROVISIONING is not a StopTask failure.
    await expect(handle.cancel()).resolves.toBeUndefined()
    expect(ecs.of('StopTaskCommand')).toHaveLength(1)
    expect(reporter.captureMessage).not.toHaveBeenCalled()
    expect(warnSpy.mock.calls.some((c) => String(c[0]).includes('DEPROVISIONING'))).toBe(true)
    // Unclean retry must not fire StopTask again for this ARN.
    await new Promise((r) => setTimeout(r, 80))
    expect(ecs.of('StopTaskCommand')).toHaveLength(1)
    // Forgotten from active — shutdown must not hang waiting on deprovision.
    await expect(factory.shutdown()).resolves.toBeUndefined()
    expect(ecs.of('StopTaskCommand')).toHaveLength(1)
    warnSpy.mockRestore()
  })

  it('waits through DEACTIVATING until DescribeTasks reports STOPPED', async () => {
    factory = new FargateWorkerFactory(cp.plane, baseConfig(), ecs as unknown as ECSClient, {
      uncleanRetryMs: 0,
      stopVerifyTimeoutMs: 400,
      stopBackoffMs: 5,
      stopAttempts: 1,
    })
    let describes = 0
    const original = ecs.send.bind(ecs)
    ecs.send = async (command) => {
      if (command.constructor.name === 'DescribeTasksCommand') {
        describes++
        ecs.calls.push({ name: 'DescribeTasksCommand', input: (command.input ?? {}) as Record<string, unknown> })
        if (describes < 3) {
          return { tasks: [{ taskArn: TASK_ARN, lastStatus: 'DEACTIVATING', desiredStatus: 'STOPPED' }] }
        }
        return { tasks: [{ taskArn: TASK_ARN, lastStatus: 'STOPPED', desiredStatus: 'STOPPED' }] }
      }
      return original(command)
    }
    const handle = await factory.startRun(SPEC, sink)
    await expect(handle.cancel()).resolves.toBeUndefined()
    expect(describes).toBeGreaterThanOrEqual(3)
  })

  it('raises the task memory when the run asks for 16 GiB', async () => {
    await factory.startRun({ ...SPEC, workerMemoryMib: 16384 }, sink)
    expect(ecs.of('RunTaskCommand')[0].overrides).toMatchObject({ cpu: '2048', memory: '16384' })
  })

  it('refuses a task memory Fargate will not run at 2 vCPU', async () => {
    await expect(factory.startRun({ ...SPEC, workerMemoryMib: 9000 }, sink)).rejects.toThrow(/4096–16384/)
    expect(ecs.of('RunTaskCommand')).toHaveLength(0)
  })

  it('sends an exact RunTask shape with startedBy, tags, and 2 vCPU / 8192 MiB', async () => {
    await factory.startRun(SPEC, sink)
    const input = ecs.of('RunTaskCommand')[0]
    expect(input).toMatchObject({
      cluster: 'conduit',
      taskDefinition: 'conduit-worker:1',
      launchType: 'FARGATE',
      startedBy: 'conduit',
      networkConfiguration: {
        awsvpcConfiguration: {
          subnets: ['subnet-aaa', 'subnet-bbb'],
          securityGroups: ['sg-aaa'],
          assignPublicIp: 'ENABLED',
        },
      },
      overrides: {
        cpu: FARGATE_WORKER_CPU,
        memory: FARGATE_WORKER_MEMORY_MIB,
        containerOverrides: [
          {
            name: 'worker',
            environment: [
              { name: 'CONDUIT_SERVER_URL', value: 'wss://conduit.example.test/ws/worker' },
              { name: 'CONDUIT_WORKER_ID', value: 'fargate-run-1' },
            ],
          },
        ],
      },
      tags: [
        { key: 'conduit:run-id', value: 'run-1' },
        { key: 'conduit:agent-id', value: 'agent-1' },
        { key: 'managed-by', value: 'conduit' },
      ],
    })
    expect(FARGATE_WORKER_CPU).toBe('2048')
    expect(FARGATE_WORKER_MEMORY_MIB).toBe('8192')
  })

  it('does not put CONDUIT_WORKER_TOKEN or CONDUIT_FARGATE_WORKER_TOKEN in overrides by default', async () => {
    await factory.startRun(SPEC, sink)
    const names = envNames(ecs.of('RunTaskCommand')[0])
    expect(names).not.toContain('CONDUIT_WORKER_TOKEN')
    expect(names).not.toContain('CONDUIT_FARGATE_WORKER_TOKEN')
  })

  it('allows a dev-only CONDUIT_WORKER_TOKEN override when workerToken is configured', async () => {
    factory = new FargateWorkerFactory(
      cp.plane,
      baseConfig({ workerToken: 'dev-only-token' }),
      ecs as unknown as ECSClient
    )
    await factory.startRun(SPEC, sink)
    const names = envNames(ecs.of('RunTaskCommand')[0])
    expect(names).toContain('CONDUIT_WORKER_TOKEN')
    expect(names).not.toContain('CONDUIT_FARGATE_WORKER_TOKEN')
  })

  it('fails startRun when RunTask throws', async () => {
    const original = ecs.send.bind(ecs)
    ecs.send = async (command) => {
      if (command.constructor.name === 'RunTaskCommand') {
        ecs.calls.push({ name: 'RunTaskCommand', input: (command.input ?? {}) as Record<string, unknown> })
        throw new Error('AccessDenied')
      }
      return original(command)
    }
    await expect(factory.startRun(SPEC, sink)).rejects.toThrow(/Failed to start Fargate task.*AccessDenied/)
  })

  it('fails startRun when RunTask returns no task ARN', async () => {
    ecs.runTaskResponse = { tasks: [], failures: [{ reason: 'RESOURCE:MEMORY', arn: 'cluster' }] }
    await expect(factory.startRun(SPEC, sink)).rejects.toThrow(/RESOURCE:MEMORY/)
  })

  it('passes the configured connect timeout to assignTo', async () => {
    await factory.startRun(SPEC, sink)
    expect(cp.assignTo).toHaveBeenCalledWith(
      'fargate-run-1',
      SPEC,
      expect.anything(),
      5_000
    )
  })

  it('fails startRun early when DescribeTasks reports STOPPED before the worker connects', async () => {
    ecs.describeResponse = {
      tasks: [
        {
          taskArn: TASK_ARN,
          lastStatus: 'STOPPED',
          stoppedReason: 'CannotPullContainerError: image not found',
        },
      ],
    }
    cp.assignTo.mockImplementation(() => new Promise(() => {}))
    const outcome = Promise.race([
      factory.startRun(SPEC, sink).then(
        () => 'settled',
        (err: Error) => err.message
      ),
      new Promise<string>((resolve) => setTimeout(() => resolve('still-pending'), 200)),
    ])
    await expect(outcome).resolves.toMatch(/CannotPullContainerError|STOPPED|image not found/)
    expect(cp.cancelAssignTo).toHaveBeenCalledWith(
      'fargate-run-1',
      expect.objectContaining({ message: expect.stringMatching(/CannotPullContainerError|STOPPED|image not found/) })
    )
  })

  it('names the container exit code when the task stops before the worker connects', async () => {
    ecs.describeResponse = {
      tasks: [
        {
          taskArn: TASK_ARN,
          lastStatus: 'STOPPED',
          stoppedReason: 'Essential container in task exited',
          stopCode: 'EssentialContainerExited',
          containers: [{ name: 'worker', exitCode: 137, reason: 'OutOfMemoryError: Container killed' }],
        },
      ],
    }
    cp.assignTo.mockImplementation(() => new Promise(() => {}))
    await expect(factory.startRun(SPEC, sink)).rejects.toThrow(
      'stopped before the worker connected: Essential container in task exited ' +
        '(container worker exited 137: OutOfMemoryError: Container killed; stop code EssentialContainerExited)'
    )
  })

  it('does not leave an unhandled rejection when early STOPPED wins the assignTo race', async () => {
    const rejections: unknown[] = []
    const onUnhandled = (reason: unknown) => {
      rejections.push(reason)
    }
    process.on('unhandledRejection', onUnhandled)
    try {
      ecs.describeResponse = {
        tasks: [{ taskArn: TASK_ARN, lastStatus: 'STOPPED', stoppedReason: 'CannotPullContainerError' }],
      }
      let rejectAssign!: (err: Error) => void
      cp.assignTo.mockImplementation(() => new Promise((_, reject) => { rejectAssign = reject }))
      await expect(factory.startRun(SPEC, sink)).rejects.toThrow(/CannotPullContainerError|STOPPED/)
      rejectAssign(new Error('Worker fargate-run-1 did not connect within 5000ms'))
      await new Promise((r) => setTimeout(r, 20))
      expect(rejections).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })

  it('keeps waiting for assignTo when DescribeTasks throws a transient error', async () => {
    const original = ecs.send.bind(ecs)
    ecs.send = async (command) => {
      if (command.constructor.name === 'DescribeTasksCommand') {
        ecs.calls.push({ name: 'DescribeTasksCommand', input: (command.input ?? {}) as Record<string, unknown> })
        throw new Error('ThrottlingException')
      }
      return original(command)
    }
    cp.assignTo.mockImplementation(
      () =>
        new Promise((resolve) => {
          setTimeout(() => {
            resolve({
              runId: SPEC.runId,
              ephemeral: false,
              workerId: 'fargate-run-1',
              cancel: vi.fn(async () => {}),
            } satisfies WorkerHandle)
          }, 80)
        })
    )
    const handle = await factory.startRun(SPEC, sink)
    expect(handle.runId).toBe('run-1')
    expect(ecs.of('DescribeTasksCommand').length).toBeGreaterThan(0)
    expect(cp.cancelAssignTo).not.toHaveBeenCalled()
  })

  it('StopTask on cancel and verifies STOPPED via DescribeTasks', async () => {
    const handle = await factory.startRun(SPEC, sink)
    await handle.cancel()
    expect(ecs.of('StopTaskCommand')[0]).toMatchObject({
      cluster: 'conduit',
      task: TASK_ARN,
    })
    expect(ecs.of('DescribeTasksCommand')[0]).toMatchObject({
      cluster: 'conduit',
      tasks: [TASK_ARN],
    })
  })

  it('StopTask on normal exit and verifies STOPPED', async () => {
    await factory.startRun(SPEC, sink)
    cp.lastSink().onExit('completed', 0)
    await vi.waitFor(
      () => {
        expect(ecs.of('StopTaskCommand').length).toBeGreaterThan(0)
        expect(ecs.of('DescribeTasksCommand').length).toBeGreaterThan(0)
      },
      { timeout: 200, interval: 20 }
    )
  })

  it('StopTask on failed exit and verifies STOPPED', async () => {
    await factory.startRun(SPEC, sink)
    cp.lastSink().onExit('failed', 1)
    await vi.waitFor(
      () => {
        expect(ecs.of('StopTaskCommand').length).toBeGreaterThan(0)
        expect(ecs.of('DescribeTasksCommand').length).toBeGreaterThan(0)
      },
      { timeout: 200, interval: 20 }
    )
  })

  it('StopTask when assignTo fails', async () => {
    cp.assignTo.mockRejectedValue(new Error('Worker fargate-run-1 did not connect within 50ms'))
    await expect(factory.startRun(SPEC, sink)).rejects.toThrow(/did not connect/)
    expect(ecs.of('StopTaskCommand')[0]).toMatchObject({ task: TASK_ARN })
  })

  it('stop is idempotent when the task is already gone', async () => {
    const handle = await factory.startRun(SPEC, sink)
    ecs.stopImpl = async () => {
      throw new Error('The referenced task was not found')
    }
    await expect(handle.cancel()).resolves.toBeUndefined()
    await expect(handle.cancel()).resolves.toBeUndefined()
  })

  it('retries a transient StopTask failure and then forgets the task', async () => {
    const handle = await factory.startRun(SPEC, sink)
    let stops = 0
    ecs.stopImpl = async () => {
      stops++
      if (stops === 1) throw new Error('ThrottlingException')
      return {}
    }
    await handle.cancel()
    expect(ecs.of('StopTaskCommand').length).toBe(2)
    const afterCancel = ecs.of('StopTaskCommand').length
    await factory.shutdown()
    expect(ecs.of('StopTaskCommand').length).toBe(afterCancel)
  })

  it('keeps a persistently unstoppable task tracked so shutdown retries StopTask', async () => {
    factory = new FargateWorkerFactory(cp.plane, baseConfig(), ecs as unknown as ECSClient, {
      stopBackoffMs: 5,
      shutdownDeadlineMs: 80,
      uncleanRetryMs: 0,
    })
    const handle = await factory.startRun(SPEC, sink)
    ecs.stopImpl = async () => {
      throw new Error('ServiceException')
    }
    await expect(handle.cancel()).rejects.toThrow(/stop|STOPPED|ServiceException/i)
    const afterCancel = ecs.of('StopTaskCommand').length
    expect(afterCancel).toBeGreaterThanOrEqual(2)
    await expect(factory.shutdown()).rejects.toThrow(/Failed to stop|stop/i)
    expect(ecs.of('StopTaskCommand').length).toBeGreaterThan(afterCancel)
  })

  it('retries unclean tasks on a periodic timer after cancel fails', async () => {
    factory = new FargateWorkerFactory(cp.plane, baseConfig(), ecs as unknown as ECSClient, {
      stopAttempts: 1,
      stopBackoffMs: 1,
      shutdownDeadlineMs: 20,
      uncleanRetryMs: 25,
    })
    const handle = await factory.startRun(SPEC, sink)
    ecs.stopImpl = async () => {
      throw new Error('ServiceException')
    }
    await expect(handle.cancel()).rejects.toThrow(/stop|STOPPED|ServiceException/i)
    const afterCancel = ecs.of('StopTaskCommand').length
    await vi.waitFor(
      () => {
        expect(ecs.of('StopTaskCommand').length).toBeGreaterThan(afterCancel)
      },
      { timeout: 200, interval: 10 }
    )
    await expect(factory.shutdown()).rejects.toThrow(/Failed to stop|stop/i)
  })

  it('emits one reporter event per task ARN across unclean cleanup retries', async () => {
    vi.mocked(reporter.captureMessage).mockClear()
    factory = new FargateWorkerFactory(cp.plane, baseConfig(), ecs as unknown as ECSClient, {
      stopAttempts: 1,
      stopBackoffMs: 1,
      shutdownDeadlineMs: 20,
      uncleanRetryMs: 25,
    })
    const handle = await factory.startRun(SPEC, sink)
    ecs.stopImpl = async () => {
      throw new Error('ServiceException')
    }
    await expect(handle.cancel()).rejects.toThrow(/stop|STOPPED|ServiceException/i)
    const afterCancel = ecs.of('StopTaskCommand').length
    await vi.waitFor(
      () => {
        expect(ecs.of('StopTaskCommand').length).toBeGreaterThan(afterCancel)
      },
      { timeout: 200, interval: 10 }
    )
    expect(reporter.captureMessage).toHaveBeenCalledTimes(1)
    expect(vi.mocked(reporter.captureMessage).mock.calls[0]?.[2]).toMatchObject({
      extra: { taskArn: TASK_ARN },
    })
    await expect(factory.shutdown()).rejects.toThrow(/Failed to stop|stop/i)
    expect(reporter.captureMessage).toHaveBeenCalledTimes(1)
  })

  it('shutdown StopTasks a run whose worker never connected and verifies STOPPED', async () => {
    cp.assignTo.mockImplementation(() => new Promise(() => {}))
    void factory.startRun(SPEC, sink).catch(() => {})
    await vi.waitFor(() => expect(ecs.of('RunTaskCommand')).toHaveLength(1))
    await factory.shutdown()
    expect(ecs.of('StopTaskCommand')[0]).toMatchObject({ task: TASK_ARN })
    expect(ecs.of('DescribeTasksCommand').at(-1)).toMatchObject({ tasks: [TASK_ARN] })
  })

  it('shutdown leaves a started run’s task running for the replacement server', async () => {
    await factory.startRun(SPEC, sink)
    await factory.shutdown()
    expect(ecs.of('StopTaskCommand')).toEqual([])
  })
})
