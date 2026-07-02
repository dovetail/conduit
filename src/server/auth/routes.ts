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

/**
 * Render a friendly, self-contained HTML error page for auth failures.
 * Served directly (not through the SPA), so all styling is inline. `variant`
 * = 'denied' when the identity provider refused the user (e.g. not assigned to
 * the app) vs. 'error' for an unexpected failure on our side.
 */
function renderAuthErrorPage(opts: {
  variant: 'denied' | 'error'
  title: string
  message: string
}): string {
  const { variant, title, message } = opts
  const accent = variant === 'denied' ? '#f59e0b' : '#ef4444'
  const glyph = variant === 'denied' ? '&#128274;' : '&#9888;' // lock / warning
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title} — Conduit</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    background: #0b0d10; color: #e5e7eb; padding: 24px;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  }
  .card {
    width: 100%; max-width: 420px; background: #14181d; border: 1px solid #262c34;
    border-radius: 14px; padding: 32px; text-align: center;
    box-shadow: 0 10px 40px rgba(0,0,0,0.4);
  }
  .icon {
    width: 56px; height: 56px; margin: 0 auto 20px; border-radius: 50%;
    display: flex; align-items: center; justify-content: center; font-size: 26px;
    background: ${accent}1a; color: ${accent};
  }
  h1 { font-size: 18px; font-weight: 600; margin: 0 0 10px; color: #f3f4f6; }
  p { font-size: 14px; line-height: 1.55; margin: 0 0 24px; color: #9ca3af; }
  a.btn {
    display: inline-block; text-decoration: none; font-size: 14px; font-weight: 500;
    padding: 10px 20px; border-radius: 8px; background: #2563eb; color: #fff;
    transition: background 0.15s ease;
  }
  a.btn:hover { background: #1d4ed8; }
  .hint { margin-top: 18px; font-size: 12px; color: #6b7280; }
</style>
</head>
<body>
  <div class="card">
    <div class="icon">${glyph}</div>
    <h1>${title}</h1>
    <p>${message}</p>
    <a class="btn" href="/auth/login">Try signing in again</a>
    <div class="hint">If this keeps happening, contact your Conduit administrator.</div>
  </div>
</body>
</html>`
}

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
    // The IdP redirected back with an OAuth error (e.g. the user isn't assigned
    // to the Okta app). There's no code to exchange — show a friendly page.
    const oauthError = req.query.error as string | undefined
    if (oauthError) {
      // Clean up any pending PKCE verifier for this state.
      const st = req.query.state as string | undefined
      if (st) pendingAuthRequests.delete(st)

      const isAccessDenied = oauthError === 'access_denied'
      res.status(403).type('html').send(
        renderAuthErrorPage({
          variant: 'denied',
          title: isAccessDenied ? "You don't have access to Conduit" : 'Sign-in was declined',
          message: isAccessDenied
            ? 'Your account is not assigned to this application. Ask your administrator to grant you access in Okta, then try again.'
            : 'Your identity provider declined the sign-in request. Please try again, or contact your administrator if the problem continues.',
        })
      )
      return
    }

    const state = req.query.state as string | undefined
    if (!state) {
      res.status(400).type('html').send(
        renderAuthErrorPage({
          variant: 'error',
          title: 'Sign-in link was incomplete',
          message: 'The sign-in request was missing required information. Please start again from the login page.',
        })
      )
      return
    }

    const codeVerifier = pendingAuthRequests.get(state)
    if (!codeVerifier) {
      res.status(400).type('html').send(
        renderAuthErrorPage({
          variant: 'error',
          title: 'Sign-in link expired',
          message: 'This sign-in link has expired or was already used. Please start again from the login page.',
        })
      )
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
    res.status(500).type('html').send(
      renderAuthErrorPage({
        variant: 'error',
        title: 'Something went wrong signing you in',
        message: 'We hit an unexpected error while completing your sign-in. Please try again in a moment.',
      })
    )
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
