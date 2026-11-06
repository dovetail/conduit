import { describe, it, expect, vi } from 'vitest'
import * as path from 'path'
import { ensureDataDirectories } from './paths'

describe('ensureDataDirectories', () => {
  it('does not create server data directories when the process is a worker', () => {
    const mkdir = vi.fn()
    const exists = vi.fn(() => false)
    ensureDataDirectories(
      { CONDUIT_PROCESS_MODE: 'worker', CONDUIT_DATA_DIR: '/data' },
      { exists, mkdir }
    )
    expect(exists).not.toHaveBeenCalled()
    expect(mkdir).not.toHaveBeenCalled()
  })

  it('creates logs and repos for the server when they are missing', () => {
    const mkdir = vi.fn()
    const exists = vi.fn(() => false)
    ensureDataDirectories(
      { CONDUIT_PROCESS_MODE: 'server', CONDUIT_DATA_DIR: '/data' },
      { exists, mkdir }
    )
    expect(mkdir).toHaveBeenCalledWith(path.join('/data', 'logs'), { recursive: true })
    expect(mkdir).toHaveBeenCalledWith(path.join('/data', 'repos'), { recursive: true })
  })

  it('leaves existing server directories alone', () => {
    const mkdir = vi.fn()
    const exists = vi.fn(() => true)
    ensureDataDirectories({ CONDUIT_DATA_DIR: '/data' }, { exists, mkdir })
    expect(mkdir).not.toHaveBeenCalled()
  })
})
