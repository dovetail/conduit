import type { Request, Response, NextFunction } from 'express'
import type { RequestContext } from '../../shared/types'
import { isAuthEnabled } from './config'
import { getDevContext } from './devBypass'
import { getSession, deleteSession } from '../../main/db/queries/sessions'
import { getUserGroupIds } from '../../main/db/queries/groups'

declare global {
  namespace Express {
    interface Request {
      context?: RequestContext
    }
  }
}

export async function sessionMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!isAuthEnabled()) {
    req.context = getDevContext()
    next()
    return
  }

  const sessionId: string | undefined = req.cookies?.conduit_session
  if (!sessionId) {
    res.status(401).json({ error: 'Not authenticated' })
    return
  }

  try {
    const session = await getSession(sessionId)
    if (!session) {
      res.status(401).json({ error: 'Not authenticated' })
      return
    }

    if (session.expiresAt < Date.now()) {
      await deleteSession(session.id)
      res.status(401).json({ error: 'Session expired' })
      return
    }

    const userGroupIds = await getUserGroupIds(session.userId)
    req.context = {
      userId: session.userId,
      userGroupIds,
    }

    next()
  } catch (err) {
    next(err)
  }
}
