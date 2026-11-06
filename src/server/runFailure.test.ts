import { describe, it, expect } from 'vitest'
import {
  buildRunFailureReport,
  classifyRunFailure,
  cliKillDiagnostic,
  failedStartLastLine,
  isDerivedWorkerControlFailure,
  redactFailureLastLine,
} from './runFailure'

describe('buildRunFailureReport', () => {
  it('flags a disk-full failure at error level with a diskFull tag', () => {
    const r = buildRunFailureReport({
      runId: 'r1',
      runner: 'claude',
      exitCode: 128,
      lastLine: 'error: unable to create file x: No space left on device',
    })
    expect(r.level).toBe('error')
    expect(r.ctx.tags?.diskFull).toBe('true')
    expect(r.ctx.tags?.exitCode).toBe('128')
    expect(r.message).toMatch(/failed/i)
  })

  it('reports a non-disk failure at warning level', () => {
    const r = buildRunFailureReport({
      runId: 'r2',
      runner: 'amp',
      exitCode: 1,
      lastLine: 'TypeError: something broke',
    })
    expect(r.level).toBe('warning')
    expect(r.ctx.tags?.diskFull).toBe('false')
    expect(r.ctx.tags?.runId).toBe('r2')
  })

  it('renders a null exit code (killed by signal) as "signal" and escalates to error', () => {
    const r = buildRunFailureReport({ runId: 'r3', runner: 'claude', exitCode: null, lastLine: '' })
    expect(r.ctx.tags?.exitCode).toBe('signal')
    expect(r.message).toContain('signal')
    // A signal kill (OOM / disk-pressure eviction) is the "log just stops" failure
    // — surface it at error level, not hidden at warning, with a flagging tag.
    expect(r.level).toBe('error')
    expect(r.ctx.tags?.killedBySignal).toBe('true')
  })

  it('tags a normal exit as not killed by signal', () => {
    const r = buildRunFailureReport({ runId: 'r4', runner: 'claude', exitCode: 1, lastLine: 'boom' })
    expect(r.ctx.tags?.killedBySignal).toBe('false')
  })
})

describe('failedStartLastLine', () => {
  it('prefixes the thrown message so run history is not blank', () => {
    expect(failedStartLastLine(new Error('Not enough disk space to start this run. Free space on the Conduit server or increase its data volume, then retry.'))).toMatch(
      /^Failed to start run: Not enough disk space/
    )
  })
})

describe('cliKillDiagnostic', () => {
  it('ignores a clean exit and a cooperative SIGTERM', () => {
    expect(cliKillDiagnostic(0, null)).toBeUndefined()
    expect(cliKillDiagnostic(null, 'SIGTERM')).toBeUndefined()
    expect(cliKillDiagnostic(1, null)).toBeUndefined()
  })

  it('describes SIGKILL / exit 137 as an OOM-or-disk eviction', () => {
    expect(cliKillDiagnostic(null, 'SIGKILL')).toMatch(/killed \(SIGKILL\)/)
    expect(cliKillDiagnostic(137, null)).toMatch(/killed \(SIGKILL\)/)
  })

  it('points remote runs at the worker task, not only the Conduit pod', () => {
    const text = cliKillDiagnostic(null, 'SIGKILL')
    expect(text).toMatch(/Conduit pod for local runs/)
    expect(text).toMatch(/worker task for remote\/Fargate runs/)
    expect(text).toMatch(/workerMemoryMib/)
  })
})

describe('classifyRunFailure', () => {
  it('classifies Cursor API-key rejection as authentication', () => {
    expect(classifyRunFailure('Warning: The provided API key is invalid.', 1)).toBe('authentication')
  })

  it.each(['invalid api key', 'unauthorized', 'authentication failed'])(
    'classifies Claude/Amp %s as authentication',
    (text) => {
      expect(classifyRunFailure(`claude: ${text}`, 1)).toBe('authentication')
      expect(classifyRunFailure(`AMP: ${text.toUpperCase()}`, 1)).toBe('authentication')
    }
  )

  it.each([
    'CURSOR_API_KEY is not set',
    'ANTHROPIC_API_KEY is not set',
    'API key not set',
    'No API key',
    'Error: No API key provided',
    'cursor: not logged in',
    'Login required',
    'claude: login required to continue',
  ])('classifies missing-credential / login CLI line %j as authentication', (lastLine) => {
    expect(classifyRunFailure(lastLine, 1)).toBe('authentication')
  })

  it('classifies a missing API key on the trailing line of multi-line CLI output', () => {
    expect(classifyRunFailure('some preamble\nCURSOR_API_KEY is not set\n', 1)).toBe(
      'authentication'
    )
    expect(classifyRunFailure('noise\nnot logged in', 1)).toBe('authentication')
  })

  it.each([
    'Cannot use this model: foo. Available models: …',
    'cannot use this model: composer-9',
    'error: unknown option "--legacy-flag"',
    'Unknown option: --foo',
  ])('classifies runner startup rejection %j as launch_config', (lastLine) => {
    expect(classifyRunFailure(lastLine, 1)).toBe('launch_config')
  })

  it('classifies a launch-config rejection on the trailing CLI line', () => {
    expect(classifyRunFailure('starting…\nCannot use this model: bad-id', 1)).toBe('launch_config')
  })

  it('classifies a framed Conduit worker-control line as worker_control even with a signal exit', () => {
    const lastLine = '[Conduit: worker worker-1 lost contact (lease expired) — failing this run.]'
    expect(classifyRunFailure(lastLine, null)).toBe('worker_control')
    expect(isDerivedWorkerControlFailure(lastLine)).toBe(true)
  })

  it('treats a 140-character-truncated worker-control prefix as worker_control', () => {
    const lastLine =
      '[Conduit: worker ip-10-0-12-34.ec2.internal-98765-' + 'a'.repeat(80) + '…'
    expect(lastLine.endsWith('— failing this run.]')).toBe(false)
    expect(isDerivedWorkerControlFailure(lastLine)).toBe(true)
    expect(classifyRunFailure(lastLine, null)).toBe('worker_control')
  })

  it('does not treat an unframed mention of a worker failure as worker_control', () => {
    expect(classifyRunFailure('agent said the worker died — failing this run.', 1)).toBe('agent_error')
    expect(isDerivedWorkerControlFailure('agent said the worker died — failing this run.')).toBe(false)
    expect(isDerivedWorkerControlFailure('[conduit: worker x — failing this run.]')).toBe(false)
  })

  it('preserves disk, signal, and generic classifications', () => {
    expect(
      classifyRunFailure('error: unable to create file x: No space left on device', 128)
    ).toBe('disk_full')
    expect(classifyRunFailure('', null)).toBe('process_signal')
    expect(classifyRunFailure('TypeError: something broke', 1)).toBe('agent_error')
  })

  it.each([
    'Linear API returned 401 Unauthorized',
    'S3: unauthorized access',
    'tool returned authentication failed while calling upstream',
  ])('keeps %s as agent_error with the diagnostic lastLine', (lastLine) => {
    expect(classifyRunFailure(lastLine, 1)).toBe('agent_error')
    const r = buildRunFailureReport({
      runId: 'r-up',
      runner: 'claude',
      exitCode: 1,
      lastLine,
    })
    expect(r.ctx.tags?.failureKind).toBe('agent_error')
    expect(r.message).toBe('Agent run failed (exit 1)')
    expect(r.ctx.extra).toEqual({ lastLine })
  })

  it('lets a framed worker-control line win over embedded unauthorized text', () => {
    const lastLine = '[Conduit: worker worker-1 unauthorized — failing this run.]'
    expect(classifyRunFailure(lastLine, 1)).toBe('worker_control')
  })
})

describe('buildRunFailureReport authentication', () => {
  it('reports a stable sanitized authentication message without the raw last line', () => {
    const lastLine = 'Warning: The provided API key is invalid.'
    const r = buildRunFailureReport({
      runId: 'r-auth',
      runner: 'cursor',
      exitCode: 1,
      lastLine,
    })
    expect(r.message).toBe('Agent credential rejected (cursor)')
    expect(r.ctx.tags?.failureKind).toBe('authentication')
    expect(r.level).toBe('warning')
    expect(r.ctx.extra).not.toHaveProperty('lastLine')
    expect(JSON.stringify(r.ctx.extra ?? {})).not.toContain(lastLine)
  })

  it('reports missing API key / login failures as authentication without lastLine', () => {
    for (const lastLine of ['CURSOR_API_KEY is not set', 'not logged in']) {
      const r = buildRunFailureReport({
        runId: 'r-auth-miss',
        runner: 'cursor',
        exitCode: 1,
        lastLine,
      })
      expect(r.message).toBe('Agent credential rejected (cursor)')
      expect(r.ctx.tags?.failureKind).toBe('authentication')
      expect(r.ctx.extra).toEqual({})
    }
  })

  it('tags disk, signal, worker-control, launch_config, and generic reports with their failureKind', () => {
    expect(
      buildRunFailureReport({
        runId: 'r-disk',
        runner: 'claude',
        exitCode: 128,
        lastLine: 'No space left on device',
      }).ctx.tags?.failureKind
    ).toBe('disk_full')
    expect(
      buildRunFailureReport({ runId: 'r-sig', runner: 'claude', exitCode: null, lastLine: '' }).ctx
        .tags?.failureKind
    ).toBe('process_signal')
    expect(
      buildRunFailureReport({
        runId: 'r-wc',
        runner: 'claude',
        exitCode: null,
        lastLine: '[Conduit: worker w1 shutting down — failing this run.]',
      }).ctx.tags?.failureKind
    ).toBe('worker_control')
    expect(
      buildRunFailureReport({
        runId: 'r-launch',
        runner: 'cursor',
        exitCode: 1,
        lastLine: 'Cannot use this model: bad-id',
      }).ctx.tags?.failureKind
    ).toBe('launch_config')
    expect(
      buildRunFailureReport({
        runId: 'r-gen',
        runner: 'amp',
        exitCode: 1,
        lastLine: 'TypeError: something broke',
      }).ctx.tags?.failureKind
    ).toBe('agent_error')
  })
})

describe('buildRunFailureReport launch_config', () => {
  it('reports a stable launch-config message with a redacted lastLine at warning', () => {
    const lastLine = 'Cannot use this model: bad-id'
    const r = buildRunFailureReport({
      runId: 'r-lc',
      runner: 'cursor',
      exitCode: 1,
      lastLine,
    })
    expect(r.message).toBe('Agent runner rejected the launch configuration (cursor)')
    expect(r.level).toBe('warning')
    expect(r.ctx.tags?.failureKind).toBe('launch_config')
    expect(r.ctx.extra).toEqual({ lastLine })
  })

  it('keeps ordinary agent failures as agent_error with the exit-1 message', () => {
    const r = buildRunFailureReport({
      runId: 'r-agent',
      runner: 'cursor',
      exitCode: 1,
      lastLine: 'TypeError: something broke',
    })
    expect(r.message).toBe('Agent run failed (exit 1)')
    expect(r.ctx.tags?.failureKind).toBe('agent_error')
    expect(r.level).toBe('warning')
    expect(r.ctx.extra).toEqual({ lastLine: 'TypeError: something broke' })
  })
})

describe('redactFailureLastLine', () => {
  it('redacts synthetic sk-/Bearer/assignment secrets so Sentry keeps the diagnostic', () => {
    expect(redactFailureLastLine('rejected key sk-test-secret at startup')).toBe(
      'rejected key [redacted] at startup'
    )
    expect(redactFailureLastLine('Authorization: Bearer abcdef')).toBe(
      'Authorization: Bearer [redacted]'
    )
    expect(redactFailureLastLine('failed with api_key=supersecret')).toBe(
      'failed with api_key=[redacted]'
    )
    expect(redactFailureLastLine('token: hush-token-value')).toBe('token: [redacted]')
    expect(redactFailureLastLine('secret=also-secret password=pw123')).toBe(
      'secret=[redacted] password=[redacted]'
    )
  })

  it('attaches a redacted lastLine on non-auth reports and never embeds the raw secret', () => {
    const secret = 'sk-test-secret'
    const lastLine = `startup failed; echo ${secret}`
    const r = buildRunFailureReport({
      runId: 'r-redact',
      runner: 'cursor',
      exitCode: 1,
      lastLine,
    })
    expect(r.ctx.tags?.failureKind).toBe('agent_error')
    expect(r.ctx.extra?.lastLine).toBe('startup failed; echo [redacted]')
    const serialized = JSON.stringify(r)
    expect(serialized).not.toContain(secret)
    expect(serialized).not.toContain('sk-test')
  })

  it('leaves ordinary diagnostics unchanged', () => {
    expect(redactFailureLastLine('TypeError: something broke')).toBe('TypeError: something broke')
    expect(redactFailureLastLine('Cannot use this model: foo')).toBe('Cannot use this model: foo')
  })
})
