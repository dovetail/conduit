import { describe, expect, it } from 'vitest'
import { isOpaqueOktaId } from '@shared/oktaId'
import { shareTargetSubtitle, shareTargetTitle } from './shareTargetLabel'

const opaqueUserId = '00uabcdefghijklmnopq'
const opaqueGroupId = '00g0123456789ABCDEF1'

describe('isOpaqueOktaId', () => {
  it('matches 00u / 00g plus 17 alphanumerics', () => {
    expect(isOpaqueOktaId(opaqueUserId)).toBe(true)
    expect(isOpaqueOktaId(opaqueGroupId)).toBe(true)
  })

  it('rejects friendly names and malformed ids', () => {
    expect(isOpaqueOktaId('Ada Lovelace')).toBe(false)
    expect(isOpaqueOktaId('00uabcdefghijklmnop')).toBe(false)
    expect(isOpaqueOktaId('00uabcdefghijklmnopqr')).toBe(false)
    expect(isOpaqueOktaId('00xabcdefghijklmnop')).toBe(false)
  })
})

describe('shareTargetTitle', () => {
  it('prefers a friendly targetName over an opaque knownName and targetId', () => {
    expect(
      shareTargetTitle({
        targetType: 'user',
        targetName: 'Ada Lovelace',
        knownName: opaqueUserId,
        targetId: opaqueUserId,
      })
    ).toBe('Ada Lovelace')
  })

  it('uses a friendly knownName when targetName is an opaque id', () => {
    expect(
      shareTargetTitle({
        targetType: 'group',
        targetName: opaqueGroupId,
        knownName: 'Platform',
        targetId: opaqueGroupId,
      })
    ).toBe('Platform')
  })

  it('shows an opaque targetName when no friendly alternative exists', () => {
    expect(
      shareTargetTitle({
        targetType: 'user',
        targetName: opaqueUserId,
        knownName: opaqueUserId,
        targetId: opaqueUserId,
      })
    ).toBe(opaqueUserId)
  })

  it('falls through blank names to Unknown user / Unknown group', () => {
    expect(shareTargetTitle({ targetType: 'user', targetName: '  ', knownName: null })).toBe(
      'Unknown user'
    )
    expect(shareTargetTitle({ targetType: 'group', targetName: '', knownName: undefined })).toBe(
      'Unknown group'
    )
  })

  it('titles everyone as Everyone', () => {
    expect(shareTargetTitle({ targetType: 'everyone', targetName: opaqueUserId })).toBe('Everyone')
  })
})

describe('shareTargetSubtitle', () => {
  it('subtitles everyone as Everyone', () => {
    expect(shareTargetSubtitle({ targetType: 'everyone', targetEmail: 'ada@example.com' })).toBe(
      'Everyone'
    )
  })

  it('prefers a trimmed user email over the User fallback', () => {
    expect(shareTargetSubtitle({ targetType: 'user', targetEmail: '  ada@example.com  ' })).toBe(
      'ada@example.com'
    )
    expect(shareTargetSubtitle({ targetType: 'user', targetEmail: '   ' })).toBe('User')
  })

  it('subtitles groups as Group', () => {
    expect(shareTargetSubtitle({ targetType: 'group', targetEmail: 'ignored@example.com' })).toBe(
      'Group'
    )
  })
})
