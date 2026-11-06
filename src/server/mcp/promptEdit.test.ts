import { describe, it, expect } from 'vitest'
import { applyPromptEdit, summarizePromptDiff } from './promptEdit'

describe('applyPromptEdit', () => {
  it('replaces a unique occurrence', () => {
    expect(applyPromptEdit('Open a PR.\nBe brief.', 'Be brief.', 'Be thorough.')).toEqual({
      prompt: 'Open a PR.\nBe thorough.',
      replacements: 1,
    })
  })

  it('refuses an ambiguous edit unless replaceAll is set', () => {
    expect(() => applyPromptEdit('x y x', 'x', 'z')).toThrow(/occurs 2 times/)
    expect(applyPromptEdit('x y x', 'x', 'z', true)).toEqual({ prompt: 'z y z', replacements: 2 })
  })

  it('reports missing text and no-op edits', () => {
    expect(() => applyPromptEdit('abc', 'zzz', 'y')).toThrow(/not found/)
    expect(() => applyPromptEdit('abc', 'a', 'a')).toThrow(/identical/)
    expect(() => applyPromptEdit('abc', '', 'a')).toThrow(/empty/)
  })

  it('treats special replacement characters literally', () => {
    expect(applyPromptEdit('cost: X', 'X', '$& $1').prompt).toBe('cost: $& $1')
  })
})

describe('summarizePromptDiff', () => {
  it('shows the changed lines with the first changed line number', () => {
    expect(summarizePromptDiff('a\nb\nc', 'a\nB\nc')).toBe('@@ line 2 @@\n- b\n+ B')
  })
  it('handles pure additions and no changes', () => {
    expect(summarizePromptDiff('a', 'a\nb')).toBe('@@ line 2 @@\n+ b')
    expect(summarizePromptDiff('same', 'same')).toBe('No changes.')
  })
})
