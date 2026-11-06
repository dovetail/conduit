import { describe, it, expect } from 'vitest'
import {
  REDACTED,
  applyRecordPatch,
  mergeMcpEntry,
  redactAgent,
  redactPublishTarget,
  redactTrigger,
  redactUrl,
} from './redact'
import type { AgentConfig, PublishTarget, Trigger } from '../../shared/types'

const agent: AgentConfig = {
  id: 'a1',
  name: 'Agent',
  runner: 'claude',
  prompt: 'do things',
  envVars: { GITHUB_TOKEN: 'ghp_secret', EMPTY: '' },
  mcpConfig: {
    mcpServers: {
      linear: { type: 'http', url: 'https://mcp.linear.app/mcp?key=abc', headers: { Authorization: 'Bearer xyz' } },
      local: { command: 'npx', args: ['server'], env: { API_KEY: 'k' } },
    },
  },
  createdAt: 1,
  updatedAt: 2,
}

describe('redactAgent', () => {
  it('hides env, header, and URL query values but keeps names', () => {
    const out = redactAgent(agent)
    expect(out.envVars).toEqual({ GITHUB_TOKEN: REDACTED, EMPTY: '' })
    expect(out.mcpConfig.mcpServers.linear!.headers).toEqual({ Authorization: REDACTED })
    expect(out.mcpConfig.mcpServers.linear!.url).toBe(`https://mcp.linear.app/mcp?key=${REDACTED}`)
    expect(out.mcpConfig.mcpServers.local!.env).toEqual({ API_KEY: REDACTED })
    expect(out.mcpConfig.mcpServers.local!.args).toEqual(['server'])
    expect(out.prompt).toBe('do things')
  })

  it('does not mutate the input', () => {
    redactAgent(agent)
    expect(agent.envVars.GITHUB_TOKEN).toBe('ghp_secret')
  })
})

describe('redactUrl', () => {
  it('strips credentials embedded in the URL', () => {
    expect(redactUrl('https://user:pw@example.com/x')).toBe(`https://${REDACTED}@example.com/x`)
  })
  it('leaves plain URLs and non-URLs alone', () => {
    expect(redactUrl('https://example.com/mcp')).toBe('https://example.com/mcp')
    expect(redactUrl('not a url')).toBe('not a url')
  })
})

describe('redactPublishTarget / redactTrigger', () => {
  it('redacts secret-looking config keys and header values', () => {
    const target = {
      id: 'p', name: 'n', type: 'webhook', enabled: true, createdAt: 0, updatedAt: 0,
      config: { url: 'https://hook', method: 'POST', headers: { 'X-Key': 'v' }, secret: 's' },
    } as PublishTarget
    expect(redactPublishTarget(target).config).toEqual({
      url: 'https://hook', method: 'POST', headers: { 'X-Key': REDACTED }, secret: REDACTED,
    })
    const slack = { ...target, type: 'slack', config: { botToken: 'xoxb', webhookUrl: 'https://hooks.slack', channel: 'C1' } } as PublishTarget
    expect(redactPublishTarget(slack).config).toEqual({ botToken: REDACTED, webhookUrl: REDACTED, channel: 'C1' })
  })

  it('redacts webhook trigger secrets', () => {
    const trigger = { id: 't', agentId: 'a', name: 'n', type: 'webhook', config: { secret: 's' }, enabled: true, createdAt: 0, updatedAt: 0 } as Trigger
    expect(redactTrigger(trigger).config).toEqual({ secret: REDACTED })
  })
})

describe('applyRecordPatch', () => {
  it('sets, deletes, and keeps redacted values', () => {
    expect(
      applyRecordPatch({ A: '1', B: '2', C: '3' }, { A: 'new', B: null, C: REDACTED, D: '4' }, 'Env var')
    ).toEqual({ A: 'new', C: '3', D: '4' })
  })
  it('rejects the placeholder for a key with no stored value', () => {
    expect(() => applyRecordPatch({}, { X: REDACTED }, 'Env var')).toThrow(/no stored value/)
  })
})

describe('mergeMcpEntry', () => {
  const stored = agent.mcpConfig.mcpServers.linear!

  it('round-trips a redacted definition back to the stored secrets', () => {
    const redacted = redactAgent(agent).mcpConfig.mcpServers.linear!
    expect(mergeMcpEntry(redacted, stored)).toEqual(stored)
  })

  it('takes new values while keeping redacted ones', () => {
    const merged = mergeMcpEntry(
      { type: 'http', url: 'https://other/mcp', headers: { Authorization: REDACTED, 'X-New': 'v' } },
      stored
    )
    expect(merged).toEqual({ type: 'http', url: 'https://other/mcp', headers: { Authorization: 'Bearer xyz', 'X-New': 'v' } })
  })

  it('rejects a redacted URL that does not match the stored one', () => {
    expect(() => mergeMcpEntry({ url: `https://evil/mcp?key=${REDACTED}` }, stored)).toThrow(/redacted/)
  })

  it('rejects placeholders for a brand-new server', () => {
    expect(() => mergeMcpEntry({ url: 'https://x', headers: { Authorization: REDACTED } }, undefined)).toThrow(
      /no stored value/
    )
  })
})
