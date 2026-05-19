import type { RequestContext } from '../../shared/types'

export const DEV_USER_ID = 'dev-user'

export const DEV_CONTEXT: RequestContext = {
  userId: DEV_USER_ID,
  userGroupIds: ['everyone'],
}

export function isAuthEnabled(): boolean {
  return !!process.env.CONDUIT_OKTA_ISSUER
}

export function getOktaConfig() {
  return {
    issuer: process.env.CONDUIT_OKTA_ISSUER!,
    clientId: process.env.CONDUIT_OKTA_CLIENT_ID!,
    clientSecret: process.env.CONDUIT_OKTA_CLIENT_SECRET!,
    redirectUri: process.env.CONDUIT_OKTA_REDIRECT_URI || 'http://localhost:7456/auth/callback',
    sessionSecret: process.env.CONDUIT_SESSION_SECRET || 'conduit-dev-secret',
    sessionTtlMs: parseInt(process.env.CONDUIT_SESSION_TTL_MS || '86400000', 10),
    apiToken: process.env.CONDUIT_OKTA_API_TOKEN,
  }
}
