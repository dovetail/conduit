/**
 * Runner exit reporting: derived worker-control failures must not emit a
 * second generic runner issue. Finalization and unrelated agent failures stay.
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

import { summarizeEvent } from '../shared/runEvents'
import { createRunOrchestration } from './runner'

const WORKER_CONTROL_LINE =
  '[Conduit: worker worker-1 lost contact (lease expired) — failing this run.]'

function longWorkerControlLine(): string {
  const workerId = `ip-10-0-12-34.ec2.internal-98765-${'a'.repeat(160)}`
  return `[Conduit: worker ${workerId} did not reconnect within 300000ms — failing this run.]`
}

function tmpDir(): { dir: string; close: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conduit-runner-reporting-'))
  return { dir, close: () => fs.rmSync(dir, { recursive: true, force: true }) }
}

describe('createRunOrchestration reporting', () => {
  const temps: Array<{ close: () => void }> = []
  const broadcasts: Array<[string, unknown]> = []

  beforeEach(() => {
    updateRunIfRunning.mockClear()
    publishRunResult.mockClear()
    captureMessage.mockClear()
    captureException.mockClear()
    broadcasts.length = 0
  })

  afterEach(() => {
    while (temps.length > 0) temps.pop()!.close()
  })

  function seedRun(): ExecutionRun {
    const tmp = tmpDir()
    temps.push(tmp)
    const id = `run-report-${temps.length}`
    const logPath = path.join(tmp.dir, `${id}.jsonl`)
    fs.writeFileSync(logPath, '')
    return {
      id,
      agentId: 'agent-1',
      status: 'running',
      startedAt: 1_000_000,
      logPath,
    }
  }

  function broadcast(channel: string, payload: unknown): void {
    broadcasts.push([channel, payload])
  }

  it('does not emit a derived runner report after a worker-control system line', async () => {
    const run = seedRun()
    const orch = createRunOrchestration({ run, broadcast, runner: 'claude' })
    orch.emitSystemMessage(WORKER_CONTROL_LINE)

    await orch.sink.onExit('failed', null)

    expect(captureMessage).not.toHaveBeenCalled()
    expect(updateRunIfRunning).toHaveBeenCalledWith(
      run.id,
      expect.objectContaining({
        status: 'failed',
        lastLine: WORKER_CONTROL_LINE,
      })
    )
    expect(publishRunResult).toHaveBeenCalledOnce()
    expect(broadcasts.some(([ch]) => ch === 'run:statusChange')).toBe(true)
  })

  it('suppresses the derived runner report when summarizeEvent truncates a long worker-control line', async () => {
    const fullLine = longWorkerControlLine()
    const summarized = summarizeEvent({ kind: 'raw', stream: 'system', text: fullLine })
    expect(fullLine.length).toBeGreaterThan(140)
    expect(summarized.startsWith('[Conduit: worker ')).toBe(true)
    expect(summarized.endsWith('— failing this run.]')).toBe(false)

    const run = seedRun()
    const orch = createRunOrchestration({ run, broadcast, runner: 'claude' })
    orch.emitSystemMessage(fullLine)
    await orch.sink.onExit('failed', null)

    expect(captureMessage).not.toHaveBeenCalled()
    expect(updateRunIfRunning).toHaveBeenCalledWith(
      run.id,
      expect.objectContaining({
        status: 'failed',
        lastLine: summarized,
      })
    )
  })

  it('reports a generic failed agent exit exactly once', async () => {
    const run = seedRun()
    const orch = createRunOrchestration({ run, broadcast, runner: 'claude' })
    orch.emitSystemMessage('TypeError: something broke')

    await orch.sink.onExit('failed', 1)

    expect(captureMessage).toHaveBeenCalledTimes(1)
    expect(captureMessage).toHaveBeenCalledWith(
      'Agent run failed (exit 1)',
      'warning',
      expect.objectContaining({
        tags: expect.objectContaining({ failureKind: 'agent_error', runId: run.id }),
        extra: expect.objectContaining({ lastLine: 'TypeError: something broke' }),
      })
    )
    expect(updateRunIfRunning).toHaveBeenCalledWith(
      run.id,
      expect.objectContaining({ status: 'failed' })
    )
  })

  it('still reports an authentication failure', async () => {
    const run = seedRun()
    const orch = createRunOrchestration({ run, broadcast, runner: 'cursor' })
    orch.emitSystemMessage('Warning: The provided API key is invalid.')

    await orch.sink.onExit('failed', 1)

    expect(captureMessage).toHaveBeenCalledTimes(1)
    expect(captureMessage).toHaveBeenCalledWith(
      'Agent credential rejected (cursor)',
      'warning',
      expect.objectContaining({
        tags: expect.objectContaining({ failureKind: 'authentication' }),
      })
    )
  })
})
