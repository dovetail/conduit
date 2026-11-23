import { describe, it, expect } from 'vitest'
import type { AgentReferences, PublishTarget, Repository } from '@shared/types'
import { unlistedPublishTargets, unlistedRepositoryOption, workspaceLabel } from './agentReferenceLabels'

const REPO: Repository = {
  id: 'repo-1',
  name: 'platform',
  url: 'https://github.com/org/platform.git',
  defaultBranch: 'main',
  authMethod: 'pat',
  syncStatus: 'ready',
  createdAt: 0,
  updatedAt: 0,
}

const TARGET: PublishTarget = {
  id: 'target-1',
  name: 'Team Slack',
  type: 'slack',
  config: { channel: 'C123', webhookUrl: 'https://hooks.slack.com/services/x' },
  enabled: true,
  createdAt: 0,
  updatedAt: 0,
}

describe('workspaceLabel', () => {
  it('names a visible repository with its branch', () => {
    expect(
      workspaceLabel({ repositoryId: 'repo-1', workingDir: undefined, visibleRepo: REPO, reference: undefined })
    ).toBe('platform (main)')
  })

  it('does not call an agent with a hidden repository ephemeral', () => {
    const label = workspaceLabel({
      repositoryId: 'repo-1',
      workingDir: undefined,
      visibleRepo: undefined,
      reference: { id: 'repo-1', access: 'hidden', name: 'platform', defaultBranch: 'main', syncStatus: 'ready' },
    })
    expect(label).toBe('platform (main), not shared with you')
  })

  it('does not call an agent ephemeral while the reference is still loading', () => {
    expect(
      workspaceLabel({ repositoryId: 'repo-1', workingDir: undefined, visibleRepo: undefined, reference: undefined })
    ).toBe('repository not shared with you')
  })

  it('reports a deleted repository', () => {
    expect(
      workspaceLabel({
        repositoryId: 'repo-1',
        workingDir: undefined,
        visibleRepo: undefined,
        reference: { id: 'repo-1', access: 'missing' },
      })
    ).toBe('repository no longer exists')
  })

  it('falls back to the working directory, then ephemeral, only without a repository', () => {
    const base = { repositoryId: undefined, visibleRepo: undefined, reference: undefined }
    expect(workspaceLabel({ ...base, workingDir: '/code' })).toBe('custom dir')
    expect(workspaceLabel({ ...base, workingDir: undefined })).toBe('ephemeral')
  })
})

describe('unlistedRepositoryOption', () => {
  it('adds nothing when there is no repository or it is in the list', () => {
    expect(unlistedRepositoryOption(undefined, [REPO], undefined)).toBeUndefined()
    expect(unlistedRepositoryOption('repo-1', [REPO], undefined)).toBeUndefined()
  })

  it('adds a labelled option for a repository outside the list', () => {
    expect(
      unlistedRepositoryOption('repo-2', [REPO], {
        id: 'repo-2',
        access: 'hidden',
        name: 'secret-repo',
        defaultBranch: 'main',
      })
    ).toEqual({ value: 'repo-2', label: 'secret-repo (not shared with you)' })
  })

  it('still adds an option before the reference has loaded', () => {
    expect(unlistedRepositoryOption('repo-2', [REPO], undefined)).toEqual({
      value: 'repo-2',
      label: 'Attached repository (not shared with you)',
    })
  })

  it('labels a deleted repository', () => {
    expect(unlistedRepositoryOption('repo-2', [], { id: 'repo-2', access: 'missing' })).toEqual({
      value: 'repo-2',
      label: 'Repository no longer exists',
    })
  })
})

describe('unlistedPublishTargets', () => {
  const references: AgentReferences = {
    publishTargets: [
      { id: 'hidden', access: 'hidden', name: 'Private Slack', type: 'slack', enabled: false },
      { id: 'gone', access: 'missing' },
    ],
  }

  it('returns only the stored targets that are not in the visible list', () => {
    expect(unlistedPublishTargets(['target-1', 'hidden'], [TARGET], references)).toEqual([
      {
        id: 'hidden',
        name: 'Private Slack',
        type: 'slack',
        enabled: false,
        access: 'hidden',
        note: 'Not shared with you',
      },
    ])
  })

  it('marks deleted targets and falls back to a generic name', () => {
    const [gone, unknown] = unlistedPublishTargets(['gone', 'other'], [], references)
    expect(gone).toMatchObject({ id: 'gone', access: 'missing', note: 'No longer exists' })
    expect(unknown).toMatchObject({ id: 'other', name: 'Attached publish target', access: 'hidden' })
  })

  it('returns nothing when the agent has no targets', () => {
    expect(unlistedPublishTargets(undefined, [TARGET], undefined)).toEqual([])
  })
})
