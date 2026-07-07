import { describe, it, expect } from 'vitest'
import { buildCloneInput } from './agentClone'
import type { AgentConfig } from './types'

const source: AgentConfig = {
  id: 'agent-123',
  name: 'Prod Deployer',
  runner: 'claude',
  prompt: 'Do the thing.',
  envVars: { FOO: 'bar' },
  mcpConfig: { mcpServers: { sentry: { url: 'https://mcp.sentry.dev' } } },
  gistId: 'gist-abc',
  workingDir: '/tmp/work',
  publishTargetIds: ['pt-1', 'pt-2'],
  repositoryId: 'repo-9',
  effort: 'high',
  enableRepoMcps: true,
  ownerId: 'owner-1',
  createdAt: 1000,
  updatedAt: 2000,
}

describe('buildCloneInput', () => {
  it('copies all configuration fields', () => {
    const clone = buildCloneInput(source)
    expect(clone.runner).toBe('claude')
    expect(clone.prompt).toBe('Do the thing.')
    expect(clone.envVars).toEqual({ FOO: 'bar' })
    expect(clone.mcpConfig).toEqual({ mcpServers: { sentry: { url: 'https://mcp.sentry.dev' } } })
    expect(clone.workingDir).toBe('/tmp/work')
    expect(clone.publishTargetIds).toEqual(['pt-1', 'pt-2'])
    expect(clone.repositoryId).toBe('repo-9')
    expect(clone.effort).toBe('high')
    expect(clone.enableRepoMcps).toBe(true)
  })

  it('blanks the name so the user must rename', () => {
    expect(buildCloneInput(source).name).toBe('')
  })

  it('drops the gist link (gistId) to avoid overwriting the source gist', () => {
    expect(buildCloneInput(source).gistId).toBeUndefined()
  })

  it('does not carry over identity, ownership, or history fields', () => {
    const clone = buildCloneInput(source) as Record<string, unknown>
    expect(clone.id).toBeUndefined()
    expect(clone.ownerId).toBeUndefined()
    expect(clone.createdAt).toBeUndefined()
    expect(clone.updatedAt).toBeUndefined()
  })

  it('does not mutate the source agent', () => {
    const before = JSON.parse(JSON.stringify(source))
    buildCloneInput(source)
    expect(source).toEqual(before)
  })
})
