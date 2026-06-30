import { describe, it, expect } from 'vitest'
import { redactCredentials, buildAuthUrl } from './gitOps'

describe('redactCredentials', () => {
  it('redacts an embedded token in an https URL', () => {
    const url = buildAuthUrl('https://github.com/acme/widgets.git', 'ghs_secrettoken')
    expect(url).toContain('ghs_secrettoken')
    const redacted = redactCredentials(`git clone failed: ${url}`)
    expect(redacted).not.toContain('ghs_secrettoken')
    expect(redacted).toContain('https://***@github.com/acme/widgets.git')
  })

  it('leaves credential-free strings unchanged', () => {
    const msg = 'git fetch failed (exit 128): fatal: repository not found'
    expect(redactCredentials(msg)).toBe(msg)
  })
})
