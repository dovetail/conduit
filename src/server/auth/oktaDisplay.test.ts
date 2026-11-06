import { describe, expect, it } from 'vitest'
import { isOpaqueOktaId } from '../../shared/oktaId'
import { needsDirectoryLookup, oktaGroupDisplayName, oktaUserDisplayName } from './oktaDisplay'

const OPAQUE_USER_ID = '00u1a2b3c4d5e6f7g8h9'
const OPAQUE_GROUP_ID = '00g1a2b3c4d5e6f7g8h9'

describe('isOpaqueOktaId', () => {
  it('is true for a 00u Okta user id (00u + 17 alphanumerics)', () => {
    expect(isOpaqueOktaId(OPAQUE_USER_ID)).toBe(true)
  })

  it('is true for a 00g Okta group id (00g + 17 alphanumerics)', () => {
    expect(isOpaqueOktaId(OPAQUE_GROUP_ID)).toBe(true)
  })

  it('is false for a human groups-claim label', () => {
    expect(isOpaqueOktaId('Engineering')).toBe(false)
  })

  it('is false when the id is one character short', () => {
    expect(isOpaqueOktaId('00u1a2b3c4d5e6f7g8h')).toBe(false)
  })
})

describe('needsDirectoryLookup', () => {
  it('is false when name equals id and the id is a human label like Engineering', () => {
    expect(needsDirectoryLookup('Engineering', 'Engineering')).toBe(false)
  })

  it('is true when name and id are the same opaque 00g id', () => {
    expect(needsDirectoryLookup(OPAQUE_GROUP_ID, OPAQUE_GROUP_ID)).toBe(true)
  })

  it('is true when name is blank', () => {
    expect(needsDirectoryLookup('', OPAQUE_USER_ID)).toBe(true)
    expect(needsDirectoryLookup('   ', OPAQUE_USER_ID)).toBe(true)
    expect(needsDirectoryLookup(null, OPAQUE_USER_ID)).toBe(true)
    expect(needsDirectoryLookup(undefined, OPAQUE_USER_ID)).toBe(true)
  })

  it('is true when the stored name is itself an opaque Okta id', () => {
    expect(needsDirectoryLookup(OPAQUE_USER_ID, 'someone-else')).toBe(true)
  })

  it('is false when the stored name is a human label even if the id is opaque', () => {
    expect(needsDirectoryLookup('Ada Lovelace', OPAQUE_USER_ID)).toBe(false)
  })
})

describe('oktaUserDisplayName', () => {
  it('prefers displayName over first and last name', () => {
    expect(
      oktaUserDisplayName(
        {
          displayName: 'Ada Lovelace',
          firstName: 'Ada',
          lastName: 'Byron',
          email: 'ada@example.com',
          login: 'ada',
        },
        OPAQUE_USER_ID
      )
    ).toBe('Ada Lovelace')
  })

  it('joins first and last when displayName is missing', () => {
    expect(
      oktaUserDisplayName(
        { firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.com' },
        OPAQUE_USER_ID
      )
    ).toBe('Ada Lovelace')
  })

  it('falls back to the id when the profile is empty', () => {
    expect(oktaUserDisplayName(null, OPAQUE_USER_ID)).toBe(OPAQUE_USER_ID)
    expect(oktaUserDisplayName(undefined, OPAQUE_USER_ID)).toBe(OPAQUE_USER_ID)
    expect(oktaUserDisplayName({}, OPAQUE_USER_ID)).toBe(OPAQUE_USER_ID)
  })

  it('uses email then login before the fallback id', () => {
    expect(oktaUserDisplayName({ email: 'ada@example.com', login: 'ada' }, OPAQUE_USER_ID)).toBe(
      'ada@example.com'
    )
    expect(oktaUserDisplayName({ login: 'ada' }, OPAQUE_USER_ID)).toBe('ada')
  })
})

describe('oktaGroupDisplayName', () => {
  it('uses profile.name when it is non-empty', () => {
    expect(oktaGroupDisplayName({ name: 'Engineering' }, OPAQUE_GROUP_ID)).toBe('Engineering')
  })

  it('falls back to the id when the profile is empty', () => {
    expect(oktaGroupDisplayName(null, OPAQUE_GROUP_ID)).toBe(OPAQUE_GROUP_ID)
    expect(oktaGroupDisplayName({ name: '  ' }, OPAQUE_GROUP_ID)).toBe(OPAQUE_GROUP_ID)
  })
})
