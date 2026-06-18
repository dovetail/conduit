import type { User, RequestContext } from '../../shared/types'
import { DEV_USER_ID, DEV_CONTEXT } from './config'
import { upsertUser } from '../../main/db/queries/users'

export const DEV_USER: User = {
  id: DEV_USER_ID,
  email: 'dev@localhost',
  name: 'Developer',
  lastLoginAt: 0,
  createdAt: 0,
}

export function getDevContext(): RequestContext {
  return DEV_CONTEXT
}

export async function ensureDevUser(): Promise<void> {
  await upsertUser({
    id: DEV_USER_ID,
    email: 'dev@localhost',
    name: 'Developer',
  })
}
