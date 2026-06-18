import { Router } from 'express'
import type { Request, Response } from 'express'
import { isAuthEnabled, getOktaConfig } from './config'
import { getDevContext, DEV_USER } from './devBypass'
import { getUser } from '../../main/db/queries/users'
import { upsertUser } from '../../main/db/queries/users'
import { getUserGroupIds, listGroups, upsertGroup, syncUserGroups } from '../../main/db/queries/groups'
import { getAuthorizationUrl, exchangeCode } from './okta'
import { createSession, getSession, deleteSession } from '../../main/db/queries/sessions'

// In-memory PKCE verifier storage keyed by state
const pendingAuthRequests = new Map<string, string>()

const router = Router()

router.get('/login', async (_req: Request, res: Response) => {
  if (!isAuthEnabled()) {
    res.redirect('/')
    return
  }

  try {
    const { url, codeVerifier, state } = await getAuthorizationUrl()
    pendingAuthRequests.set(state, codeVerifier)
    res.redirect(url.toString())
  } catch (err) {
    console.error('[auth] Failed to build authorization URL:', err)
    res.status(500).json({ error: 'Failed to start authentication' })
  }
})

router.get('/callback', async (req: Request, res: Response) => {
  if (!isAuthEnabled()) {
    res.redirect('/')
    return
  }

  try {
    const state = req.query.state as string | undefined
    if (!state) {
      res.status(400).json({ error: 'Missing state parameter' })
      return
    }

    const codeVerifier = pendingAuthRequests.get(state)
    if (!codeVerifier) {
      res.status(400).json({ error: 'Invalid or expired state parameter' })
      return
    }
    pendingAuthRequests.delete(state)

    // Build the full callback URL from the incoming request
    const { redirectUri } = getOktaConfig()
    const callbackUrl = new URL(redirectUri)
    callbackUrl.search = new URL(req.url, `http://${req.headers.host}`).search

    const { accessToken, refreshToken, expiresIn, claims } = await exchangeCode(
      callbackUrl,
      codeVerifier,
      state
    )

    // Extract user info from claims
    const sub = claims.sub as string
    const email = (claims.email as string) || `${sub}@unknown`
    const name = (claims.name as string) || email
    const claimGroups = (claims.groups as string[]) || []

    // Upsert user
    await upsertUser({
      id: sub,
      email,
      name,
      avatarUrl: claims.picture as string | undefined,
    })

    // Upsert groups and sync membership
    const groupIds: string[] = []
    for (const groupName of claimGroups) {
      const group = await upsertGroup({ id: groupName, name: groupName })
      groupIds.push(group.id)
    }
    await syncUserGroups(sub, groupIds)

    // Create session
    const { sessionTtlMs } = getOktaConfig()
    const expiresAt = Date.now() + (expiresIn ? expiresIn * 1000 : sessionTtlMs)
    const session = await createSession({
      userId: sub,
      accessToken,
      refreshToken,
      expiresAt,
    })

    // Set cookie
    const isLocalhost = req.hostname === 'localhost' || req.hostname === '127.0.0.1'
    res.cookie('conduit_session', session.id, {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: sessionTtlMs,
      secure: !isLocalhost,
    })

    res.redirect('/')
  } catch (err) {
    console.error('[auth] Callback error:', err)
    res.status(500).json({ error: 'Authentication failed' })
  }
})

router.post('/logout', async (req: Request, res: Response) => {
  const sessionId: string | undefined = req.cookies?.conduit_session
  if (sessionId) {
    await deleteSession(sessionId)
  }
  res.clearCookie('conduit_session')
  res.status(200).json({ ok: true })
})

router.get('/me', async (req: Request, res: Response) => {
  if (!isAuthEnabled()) {
    res.json({
      user: DEV_USER,
      groups: [],
      isAuthenticated: true,
      isDevMode: true,
    })
    return
  }

  const sessionId: string | undefined = req.cookies?.conduit_session
  if (!sessionId) {
    res.status(401).json({ error: 'Not authenticated' })
    return
  }

  const session = await getSession(sessionId)
  if (!session) {
    res.status(401).json({ error: 'Not authenticated' })
    return
  }

  const user = await getUser(session.userId)
  if (!user) {
    res.status(401).json({ error: 'User not found' })
    return
  }

  const userGroupIds = await getUserGroupIds(user.id)
  const allGroups = await listGroups()
  const userGroups = allGroups.filter((g) => userGroupIds.includes(g.id))

  res.json({
    user,
    groups: userGroups,
    isAuthenticated: true,
    isDevMode: false,
  })
})

export { router as authRouter }
