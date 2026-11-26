import { describe, expect, it } from 'vitest'
import { assertAgentRepositoryChangeAllowed } from './agentRepoAccess'

type Access = 'visible' | 'hidden' | 'missing'

/** Repositories listed as visible; any other id is hidden, unless listed as missing. */
const access =
  (visible: string[] = [], missing: string[] = []) =>
  async (id: string): Promise<Access> =>
    missing.includes(id) ? 'missing' : visible.includes(id) ? 'visible' : 'hidden'

describe('assertAgentRepositoryChangeAllowed', () => {
  it('allows an unchanged repository the editor cannot see', async () => {
    await expect(assertAgentRepositoryChangeAllowed('hidden', 'hidden', access())).resolves.toBeUndefined()
  })

  it('treats null, undefined and empty as the same "no repository"', async () => {
    await expect(assertAgentRepositoryChangeAllowed(null, undefined, access())).resolves.toBeUndefined()
    await expect(assertAgentRepositoryChangeAllowed(undefined, '', access())).resolves.toBeUndefined()
  })

  it('allows choosing a repository the editor can see', async () => {
    await expect(assertAgentRepositoryChangeAllowed(null, 'a', access(['a']))).resolves.toBeUndefined()
  })

  it('refuses choosing a repository the editor cannot see', async () => {
    await expect(assertAgentRepositoryChangeAllowed(null, 'hidden', access(['a']))).rejects.toThrow(
      'do not have access'
    )
  })

  it('allows replacing or clearing a repository the editor cannot see', async () => {
    await expect(assertAgentRepositoryChangeAllowed('hidden', 'a', access(['a']))).resolves.toBeUndefined()
    await expect(assertAgentRepositoryChangeAllowed('hidden', null, access(['a']))).resolves.toBeUndefined()
  })

  it('refuses replacing a repository the editor cannot see with another one they cannot see', async () => {
    await expect(assertAgentRepositoryChangeAllowed('hidden', 'other', access(['a']))).rejects.toThrow(
      'do not have access'
    )
  })

  it('allows clearing or replacing a repository that no longer exists', async () => {
    await expect(assertAgentRepositoryChangeAllowed('gone', null, access([], ['gone']))).resolves.toBeUndefined()
    await expect(assertAgentRepositoryChangeAllowed('gone', 'a', access(['a'], ['gone']))).resolves.toBeUndefined()
  })

  it('refuses choosing a repository that does not exist', async () => {
    await expect(assertAgentRepositoryChangeAllowed(null, 'gone', access([], ['gone']))).rejects.toThrow(
      'do not have access'
    )
  })

  it('allows swapping between two repositories the editor can see', async () => {
    await expect(assertAgentRepositoryChangeAllowed('a', 'b', access(['a', 'b']))).resolves.toBeUndefined()
  })
})
