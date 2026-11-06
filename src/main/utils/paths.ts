import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { resolveProcessMode } from '../../shared/processMode'

// Detect whether we are running inside an Electron process.
// In Electron, process.versions.electron is set; in plain Node it is not.
const isElectron =
  typeof process !== 'undefined' &&
  process.versions != null &&
  process.versions.electron != null

function resolveDataDir(): string {
  // 1. Explicit override via env var (used in Docker / server mode)
  if (process.env.CONDUIT_DATA_DIR) {
    return process.env.CONDUIT_DATA_DIR
  }
  // 2. Electron userData path
  if (isElectron) {
    // Dynamic require — kept as `unknown` so this file compiles cleanly
    // in both Electron and plain-Node (server) TypeScript projects.
    const electronModule = require('electron') as any
    return (electronModule.app as { getPath(name: string): string }).getPath('userData')
  }
  // 3. Fallback for plain Node (e.g. dev server run outside Docker)
  return path.join(os.homedir(), '.conduit')
}

const dataDir = resolveDataDir()

/** Root of all Conduit on-disk state (`~/.conduit` or `$CONDUIT_DATA_DIR`). */
export const DATA_DIR: string = dataDir
export const DB_PATH: string = path.join(dataDir, 'conduit.db')
export const LOGS_DIR: string = path.join(dataDir, 'logs')
export const REPOS_DIR: string = path.join(dataDir, 'repos')
export const WORKSPACES_BASE: string = os.tmpdir()

export interface DataDirIo {
  exists: (dir: string) => boolean
  mkdir: (dir: string, options: { recursive: true }) => void
}

/**
 * Create the server's logs and repos directories.
 *
 * Fargate workers import this module (via LocalWorkerFactory) only for
 * {@link WORKSPACES_BASE}. The image sets `CONDUIT_DATA_DIR=/data` and runs
 * as the unprivileged `node` user, and `/data` is not writable in that task.
 * Creating the dirs at import then throws EACCES and the container exits
 * before the worker can connect. Workers never use these directories — run
 * workspaces live under the temp dir — so skip creation in worker mode.
 */
export function ensureDataDirectories(
  env: NodeJS.ProcessEnv = process.env,
  io: DataDirIo = {
    exists: (dir) => fs.existsSync(dir),
    mkdir: (dir, options) => {
      fs.mkdirSync(dir, options)
    },
  }
): void {
  if (resolveProcessMode(env) === 'worker') return
  const root = env.CONDUIT_DATA_DIR ? env.CONDUIT_DATA_DIR : dataDir
  for (const dir of [path.join(root, 'logs'), path.join(root, 'repos')]) {
    if (!io.exists(dir)) io.mkdir(dir, { recursive: true })
  }
}

ensureDataDirectories()
