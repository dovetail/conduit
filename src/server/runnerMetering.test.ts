/**
 * Run metering: the CLI-reported usage is persisted on the run, broadcast with
 * the status change, and summarized in a structured `metering` log event.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import type { ExecutionRun } from '../shared/types'

const updateRunIfRunning = vi.fn(async (id: string, data: Partial<ExecutionRun>) => ({
  id,
  agentId: 'agent-1',
  status: data.status ?? 'failed',
  startedAt: 1_000_000,
  logPath: '',
  ...data,
}))
const publishRunResult = vi.fn(async () => {})
const captureMessage = vi.fn()
const captureException = vi.fn()

vi.mock('../main/db/queries/runs', () => ({
  updateRunIfRunning: (id: string, data: Partial<ExecutionRun>) => updateRunIfRunning(id, data),
  createRun: vi.fn(),
  updateRun: vi.fn(),
  getRunningRunForAgent: vi.fn(),
}))

vi.mock('./publisher', () => ({
  publishRunResult: (...args: unknown[]) => publishRunResult(...args),
}))

vi.mock('./observability', () => ({
  reporter: {
    captureMessage: (...args: unknown[]) => captureMessage(...args),
    captureException: (...args: unknown[]) => captureException(...args),
    setUser: vi.fn(),
    addBreadcrumb: vi.fn(),
    flush: vi.fn(async () => {}),
  },
}))

import { createRunOrchestration } from './runner'

function tmpDir(): { dir: string; close: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conduit-runner-reporting-'))
  return { dir, close: () => fs.rmSync(dir, { recursive: true, force: true }) }
}

describe('createRunOrchestration metering', () => {
  const temps: Array<{ close: () => void }> = []
  const broadcasts: Array<[string, unknown]> = []
  let stdout: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    updateRunIfRunning.mockClear()
    broadcasts.length = 0
    stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  })

  afterEach(() => {
    stdout.mockRestore()
    while (temps.length > 0) temps.pop()!.close()
  })

  function seedRun(): ExecutionRun {
    const tmp = tmpDir()
    temps.push(tmp)
    const id = `run-metering-${temps.length}`
    const logPath = path.join(tmp.dir, `${id}.jsonl`)
    fs.writeFileSync(logPath, '')
    return { id, agentId: 'agent-1', status: 'running', startedAt: Date.now() - 5_000, logPath }
  }

  const broadcast = (channel: string, payload: unknown): void => {
    broadcasts.push([channel, payload])
  }

  const usage = { costUsd: 0.42, inputTokens: 100, outputTokens: 200 }

  function logEvents(run: ExecutionRun): Array<Record<string, unknown>> {
    return fs
      .readFileSync(run.logPath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
  }

  it('persists, broadcasts and logs the usage the CLI reported', async () => {
    const run = seedRun()
    const orch = createRunOrchestration({ run, broadcast, runner: 'claude' })
    orch.sink.onEvent({ kind: 'result', isError: false, text: 'Completed', usage })

    await orch.sink.onExit('completed', 0)

    expect(updateRunIfRunning).toHaveBeenCalledWith(run.id, expect.objectContaining({ status: 'completed', usage }))
    const status = broadcasts.find(([ch]) => ch === 'run:statusChange')![1] as { usage?: unknown }
    expect(status.usage).toEqual(usage)

    const metering = logEvents(run).find((e) => e.kind === 'metering')!
    expect(metering).toMatchObject({ runner: 'claude', usage })
    expect(metering.durationMs).toBeGreaterThanOrEqual(5_000)
    expect(metering.text).toContain('cost $0.42')
    expect(metering.text).toContain('(completed)')

    const forwarded = stdout.mock.calls
      .map((c) => String(c[0]))
      .filter((l) => l.includes('"kind":"metering"'))
    expect(forwarded).toHaveLength(1)
    expect(JSON.parse(forwarded[0])).toMatchObject({ runId: run.id, agentId: 'agent-1', usage })
  })

  it('still reports session duration when the CLI reported no usage', async () => {
    const run = seedRun()
    const orch = createRunOrchestration({ run, broadcast, runner: 'cursor' })

    await orch.sink.onExit('stopped', null)

    const metering = logEvents(run).find((e) => e.kind === 'metering')!
    expect(metering.usage).toBeUndefined()
    expect(metering.durationMs).toBeGreaterThanOrEqual(5_000)
    expect(metering.text).not.toContain('cost')
  })
})
