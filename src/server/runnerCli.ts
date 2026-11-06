import { execFile } from 'child_process'
import { promisify } from 'util'
import type { RunnerCliStatus, RunnerType } from '../shared/types'

const run = promisify(execFile)

// Binary each runner shells out to (see server/runner.ts spawn). Cursor's
// headless agent binary is `cursor-agent`.
const RUNNER_BINARIES: Record<RunnerType, string> = {
  claude: 'claude',
  amp: 'amp',
  cursor: 'cursor-agent',
}

/** Report which runner CLIs are installed and on this server's PATH. */
export function checkRunnerClis(): Promise<RunnerCliStatus[]> {
  const runners = Object.keys(RUNNER_BINARIES) as RunnerType[]
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
}
