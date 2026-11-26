import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { RunSpec, WorkerEventSink, WorkerExitStatus } from '../../shared/worker'
import { LocalWorkerFactory } from './localWorker'

/** A stand-in `cursor-agent` that records the NODE_OPTIONS it was spawned with. */
const FAKE_CURSOR_AGENT = `#!/usr/bin/env node
const fs = require('fs')
process.stdin.on('data', () => {})
process.stdin.on('end', () => {
  fs.writeFileSync(process.env.FAKE_LOG, JSON.stringify({ nodeOptions: process.env.NODE_OPTIONS ?? '' }))
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false }) + '\\n')
  process.exit(0)
})
`

describe('LocalWorkerFactory memory cap', () => {
  let binDir: string
  let logFile: string

  beforeEach(() => {
    binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'conduit-fake-cursor-'))
    logFile = path.join(binDir, 'spawn.json')
    fs.writeFileSync(path.join(binDir, 'cursor-agent'), FAKE_CURSOR_AGENT, { mode: 0o755 })
  })

  afterEach(() => {
    fs.rmSync(binDir, { recursive: true, force: true })
  })

  async function spawnedNodeOptions(overrides: Partial<RunSpec> & { extraEnv?: Record<string, string> }): Promise<string> {
    const { extraEnv, ...rest } = overrides
    let resolve!: (v: WorkerExitStatus) => void
    const exit = new Promise<WorkerExitStatus>((r) => (resolve = r))
    const sink: WorkerEventSink = { onEvent: () => {}, onExit: (status) => resolve(status) }
    await new LocalWorkerFactory({ resumeMaxAttempts: 0 }).startRun(
      {
        runId: `memcap-test-${Math.random().toString(36).slice(2)}`,
        agentId: 'agent-1',
        runner: 'cursor',
        prompt: 'go',
        env: { PATH: `${binDir}${path.delimiter}${process.env.PATH}`, FAKE_LOG: logFile, ...extraEnv },
        workspace: { kind: 'ephemeral' },
        ...rest,
      },
      sink
    )
    expect(await exit).toBe('completed')
    return (JSON.parse(fs.readFileSync(logFile, 'utf8')) as { nodeOptions: string }).nodeOptions
  }

  it('caps the heap of the processes the run spawns', async () => {
    expect(await spawnedNodeOptions({ memoryCapMb: 2048 })).toContain('--max-old-space-size=2048')
  })

  it("keeps the agent's own NODE_OPTIONS flags alongside the cap", async () => {
    const opts = await spawnedNodeOptions({ memoryCapMb: 2048, extraEnv: { NODE_OPTIONS: '--enable-source-maps' } })
    expect(opts).toBe('--enable-source-maps --max-old-space-size=2048')
  })

  it('lets an explicit --max-old-space-size win over the cap', async () => {
    const opts = await spawnedNodeOptions({ memoryCapMb: 2048, extraEnv: { NODE_OPTIONS: '--max-old-space-size=6144' } })
    expect(opts).toBe('--max-old-space-size=6144')
  })

  it('leaves NODE_OPTIONS alone when the run is uncapped', async () => {
    expect(await spawnedNodeOptions({ extraEnv: { NODE_OPTIONS: '--enable-source-maps' } })).toBe('--enable-source-maps')
  })
})
