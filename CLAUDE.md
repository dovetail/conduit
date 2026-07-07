# Conduit

A managed execution environment for AI CLI agents (Claude Code, Amp, Cursor). Node.js/Express server with React frontend served at `http://localhost:7456`.

## Quick Reference

```bash
npm run dev       # Start dev server (Vite watch + tsx watch)
npm run build     # Production build (Vite + tsc)
npm start         # Run production server
```

## Architecture

- **Server**: Express + WebSocket (`src/server/`) — all client-server communication is WebSocket JSON-RPC at `/ws`
- **Database**: SQLite via better-sqlite3 + Drizzle ORM (`src/main/db/`)
- **Frontend**: React 18 + Vite + TailwindCSS (`src/renderer/`)
- **State**: TanStack Query (server state) + Zustand (UI state)
- **Shared types**: `src/shared/types.ts` — single source of truth for all TypeScript types and the `ConduitAPI` interface

## Key Patterns

**Adding a new entity type** — follow the publish targets pattern:
1. Types in `src/shared/types.ts` (interface + extend `ConduitAPI`)
2. Drizzle schema in `src/main/db/schema.ts`
3. Migrations in `src/main/db/index.ts` (CREATE TABLE IF NOT EXISTS + ALTER TABLE try/catch)
4. Query layer in `src/main/db/queries/<entity>.ts` (rowToEntity, list/get/create/update/delete)
5. Server handlers in `src/server/index.ts` (channel-based: `'entity:list'`, `'entity:create'`, etc.)
6. WS client in `src/renderer/lib/ws-client.ts` + accessor in `src/renderer/lib/ipc.ts`
7. React hooks in `src/renderer/hooks/use<Entity>.ts` (TanStack Query + mutations)
8. UI component in `src/renderer/components/`

**Database conventions:**
- IDs: `crypto.randomUUID()`
- Timestamps: `Date.now()` (unix ms) for `createdAt`/`updatedAt`
- JSON fields stored as TEXT, serialized/deserialized in `rowTo*()` helpers
- Migrations: `ALTER TABLE ... ADD COLUMN` wrapped in try/catch (idempotent)

**WebSocket protocol:**
- Client → Server: `{ type: 'invoke', id, channel, args }`
- Server → Client: `{ type: 'response', id, result }` or `{ type: 'error', id, error }`
- Server → All: `{ type: 'event', channel, payload }` (broadcasts)

## Authentication & Multi-User

Conduit supports multi-user authentication via Okta OIDC. When Okta is not configured, it runs in **dev bypass mode** — identical to the original single-user behavior with zero configuration.

**Dev mode** (default): No login required. A synthetic `dev-user` owns all entities. Set no env vars.

**Production mode**: Set these environment variables to enable Okta OIDC:

| Variable | Description |
|----------|-------------|
| `CONDUIT_OKTA_ISSUER` | Okta issuer URL (e.g., `https://company.okta.com/oauth2/default`) |
| `CONDUIT_OKTA_CLIENT_ID` | OIDC application client ID |
| `CONDUIT_OKTA_CLIENT_SECRET` | OIDC application client secret |
| `CONDUIT_OKTA_REDIRECT_URI` | Callback URL (default: `http://localhost:7456/auth/callback`) |
| `CONDUIT_SESSION_SECRET` | Secret for signing session cookies |
| `CONDUIT_SESSION_TTL_MS` | Session lifetime in ms (default: 86400000 / 24h) |
| `CONDUIT_OKTA_API_TOKEN` | Okta API token for user search (optional — enables sharing with users who haven't logged in yet) |
| `CONDUIT_SECRET_KEY` | Symmetric key for encrypting secrets (GitHub App private keys, MCP OAuth tokens) at rest. Hex-encoded, must decode to exactly 32 bytes (64 hex chars). Generate with `openssl rand -hex 32`. **Local dev:** if unset, a key is auto-generated and persisted to `.conduit.key` at the repo root (via `process.cwd()`); **production must set this explicitly** — no auto-gen, no silent rotation. **No rotation:** changing it after secrets are stored makes all existing encrypted data undecryptable. |
| `CONDUIT_BASE_URL` | Base URL of the Conduit server (default: `http://localhost:7456`). Used to build the MCP OAuth redirect URI `${CONDUIT_BASE_URL}/mcp/oauth/callback`. Set this in production to your public hostname. |

**Auth flow**: OIDC Authorization Code + PKCE. Sessions stored in SQLite. Groups synced from Okta ID token `groups` claim on each login.

**Auth routes** (HTTP, not WebSocket):
- `GET /auth/login` — redirects to Okta
- `GET /auth/callback` — exchanges code, creates session
- `POST /auth/logout` — destroys session
- `GET /auth/me` — returns current user + groups

**Auth files**:
- `src/server/auth/config.ts` — env var reading, `isAuthEnabled()`
- `src/server/auth/okta.ts` — OIDC client (openid-client v6)
- `src/server/auth/middleware.ts` — session validation middleware
- `src/server/auth/devBypass.ts` — dev mode synthetic user
- `src/server/auth/routes.ts` — Express auth router

## MCP OAuth

MCP servers that require OAuth use **server-mode OAuth 2.0 + PKCE** — Conduit holds the tokens on behalf of users so agents can authenticate to upstream APIs without manual token handling.

**Discovery & registration**: Conduit attempts RFC 7591 Dynamic Client Registration (DCR) via the server's `/.well-known/oauth-authorization-server` or `/.well-known/openid-configuration` metadata document. If the server does not support DCR, fall back to a manually configured `clientId` stored in `mcp_oauth_clients`.

**Redirect URI (must be stable)**: `getRedirectUri` returns `${CONDUIT_BASE_URL}/mcp/oauth/callback` and **prefers `CONDUIT_BASE_URL`** over the browser origin — the redirect URI registered at DCR time must be byte-identical to the one sent on every later auth/token request, or providers reject it (Sentry → "Invalid redirect URI"; Datadog, OAuth 2.1 → "Mismatching redirect URI"). **Production must set `CONDUIT_BASE_URL`** to the canonical public URL. `ensureRegisteredClient` records the exact redirect URI it registered with (`mcp_oauth_clients.redirect_uri`) and reuses a cached client only when that matches the current redirect URI; otherwise the client is stale (registered against an earlier origin) and it re-registers. Legacy rows with no recorded redirect URI fall back to the `redirect_uris` echoed in `registrationData`, and re-register when those can't be verified (rather than reusing a possibly-stale client).

**Resource indicator (RFC 8707)**: `mcp_oauth_clients.resource` holds the canonical MCP resource URI, discovered from the protected-resource metadata `resource` field (RFC 9728) or the AS metadata, falling back to the server URL. It is sent as the `resource` param on the authorization request, the token exchange, **and** refreshes so the issued token is audience-bound to the MCP server. Omitting it makes spec-compliant servers (e.g. Linear) return `401 invalid_token` on every call even though the handshake succeeds. **Existing tokens obtained before this must be re-authenticated** to pick up the audience binding.

**Token ownership**:
- Per-agent MCPs: tokens are scoped to the acting user (`tokenOwner = userId`).
- Global MCPs: tokens are shared under `tokenOwner = '__global__'`. The UI shows which user first connected ("Connected by …") so operators know whose credential is in use.

**Encryption**: access tokens, refresh tokens, and DCR client secrets are all encrypted at rest using `CONDUIT_SECRET_KEY` via `src/server/crypto.ts` (AES-256-GCM). Local dev auto-generates and persists the key to `.conduit.key` at the repo root; production must set `CONDUIT_SECRET_KEY` explicitly.

**HTTP route** (mounted *before* session middleware, so the browser redirect always lands):
- `GET /mcp/oauth/callback` — receives the authorization code, exchanges it for tokens, stores them, and closes the popup.

**WebSocket channels** (`mcp:oauth:*`):
- `mcp:oauth:startAuth` — initiates the flow; returns a URL to open in a popup.
- `mcp:oauth:getStatus` — returns the current `McpOAuthStatus` (object with `connected: boolean`, `connectedByUserId?: string`, `connectedByName?: string`, `scope: 'user' | 'global'`, `expiresAt?: number`) for a given server URL + token owner.
- `mcp:oauth:revoke` — deletes stored tokens for a given server URL + token owner.

**Run-time injection**: `writeMcpConfig` (called when launching an agent run) reads the stored access token and injects an `Authorization: Bearer <token>` header into the MCP server configuration. Tokens are auto-refreshed before injection when a refresh token is available.

**Files**:
- `src/server/crypto.ts` — `encryptSecret` / `decryptSecret` (AES-256-GCM)
- `src/server/mcpOAuth/` — discovery.ts (DCR + metadata), flow.ts (PKCE + code exchange), state.ts (pending-auth store), service.ts (startAuth/getStatus/revoke/handleCallback), routes.ts (callback handler)
- `src/main/db/queries/oauthTokens.ts` — `getToken`, `saveToken`, `deleteToken`, `getTokenStatus`, `getConnectedByUserId` (owner-scoped, encrypted tokens)
- `src/main/db/queries/mcpOAuthClients.ts` — `getClient`, `saveClient`, `deleteClient` (DCR client cache)
- `src/renderer/hooks/useMcpOAuth.ts` — TanStack Query hooks for OAuth status + mutations

## Ownership & Sharing

Every entity (agents, publish targets, repositories, global MCP servers) has an `ownerId` column linking to a user. Triggers inherit visibility from their parent agent.

**Ownership rules:**
- Entities are owned by whoever creates them (`ownerId` set on creation)
- Only the owner can delete an entity or modify its shares
- Shared users can view, edit, and run — but not delete or reshare

**Sharing model**: Polymorphic `shares` table maps `(entityType, entityId)` → `(user | group | everyone)`.

**Visibility rule** — a user sees an entity if any of:
1. They own it
2. It's shared directly with them
3. It's shared with a group they belong to
4. It's shared with everyone

**Sharing files**:
- `src/main/db/queries/access.ts` — visibility queries (`getVisibleEntityIds`, `canAccessEntity`, `isEntityOwner`)
- `src/main/db/queries/shares.ts` — share CRUD
- `src/renderer/components/ShareDialog.tsx` — sharing UI modal
- `src/renderer/hooks/useShares.ts` — TanStack Query hooks for shares

**Frontend**: The sidebar splits entities into "My Agents" / "Shared Agents" sections. The share button and delete button only appear for owners.

## Repository Authentication

Managed repositories authenticate to GitHub via one of four methods (`authMethod` in `src/shared/types.ts`, `RepoAuthMethod`):

- `none` — public repo, no credentials
- `pat` — global GitHub PAT from `prefs.json` / env (`getGithubPat`)
- `ssh` — SSH key (handled outside HTTPS token injection)
- `githubapp` — per-repo GitHub App (App ID + private key PEM)

**GitHub App auth**: two columns on the `repositories` table — `github_app_id` (TEXT, the App ID, not secret) and `github_private_key_enc` (TEXT, the PEM **encrypted** at rest). The PEM is encrypted with **AES-256-GCM** via `src/server/crypto.ts`; the key comes from `CONDUIT_SECRET_KEY` (see env-var table above).

The PEM is **write-only** from the client: it's sent on create/update and never returned. The API exposes only `githubAppId` and `hasGithubKey: boolean` (see `rowToRepository` in `src/main/db/queries/repositories.ts`; raw credentials are read server-side via `getRepositoryCredentials`).

**Runtime token flow** (`src/server/githubApp.ts`, `@octokit/auth-app`): App ID + decrypted PEM → signed app JWT → installation auto-discovered for the repo's owner/repo via GitHub's API → short-lived (~1h) installation access token injected into the HTTPS git URL.

**Files**:
- `src/server/crypto.ts` — `encryptSecret` / `decryptSecret` (AES-256-GCM, `iv:authTag:ciphertext` base64)
- `src/server/githubApp.ts` — `resolveRepoToken`, `mintInstallationToken`, `parseGithubOwnerRepo`

## Agent Credentials

The **Settings** screen (left nav → Settings, route `/settings`) lets each user store
API keys/tokens for the agent CLIs. Keys are **per-user**, encrypted at rest with
`CONDUIT_SECRET_KEY` (`src/server/crypto.ts`), and injected into the runner process
environment at launch.

- Table `agent_credentials` — PK `(user_id, runner)`, column `value_enc` (encrypted).
- Runner → env var mapping: `claude → ANTHROPIC_API_KEY`, `amp → AMP_API_KEY`,
  `cursor → CURSOR_API_KEY` (`RUNNER_ENV_VAR` in `src/server/runner.ts`).
- Injection (`buildRunnerEnv` in `src/server/runner.ts`): resolves the run's acting user
  (`startedBy`, else the agent owner), decrypts their stored key, and sets the env var —
  but an explicit per-agent `envVars` entry always wins, and a missing key falls back to
  the host environment.
- Status is **write-only** from the client: the API exposes only whether a key is
  configured (`AgentCredentialStatus`), never the secret.

**Files**: `src/main/db/queries/agentCredentials.ts` (get/set/getValue),
`agentCreds:getStatus` / `agentCreds:set` handlers in `src/server/index.ts`,
`src/renderer/components/settings/SettingsManager.tsx`,
`src/renderer/hooks/useAgentCredentials.ts`.

## Error Reporting / Observability

Error reporting is **provider-agnostic**. Application code never calls a vendor SDK
directly — it calls a generic `ErrorReporter`, and one or more concrete providers
(Sentry, console, …) are fanned out to behind the scenes. Sentry is just the first
provider; swapping or adding backends is a local change with no call-site churn.

**The seam** (`src/shared/observability.ts` — types only, no SDK imports):
- `ErrorReporter` interface: `captureException`, `captureMessage`, `setUser`,
  `addBreadcrumb`, `flush`.
- `CaptureContext` (`tags` / `extra` / `level` / `user`) — passed per call. On the
  **server**, attach the affected user per-capture via `ctx.user` (avoids global-scope
  races across concurrent users); on the **frontend** use `setUser` (one user per tab).
- `CompositeReporter` fans every call out to N child reporters (`flush` = `Promise.all`;
  a throwing child never breaks the others). **Zero children = silent no-op** — that is
  how "reporting disabled" is represented, so callers always hold a real reporter.

**Providers** (platform-specific, one dir per side):
- Server — `src/server/observability/`: `sentryReporter.ts` (`@sentry/node`),
  `consoleReporter.ts`, `index.ts`.
- Frontend — `src/renderer/observability/`: `sentryReporter.ts` (`@sentry/react`),
  `consoleReporter.ts`, `index.ts`.
- Both `index.ts` export a stable **delegating singleton** `reporter` (its identity never
  changes; the inner composite is swapped in place by `initObservability`, so
  `import { reporter }` is safe regardless of init order). Import `reporter` everywhere;
  never import a vendor SDK outside its `*Reporter.ts`.

**Adding a provider**: implement `ErrorReporter` in a new `<name>Reporter.ts` on each side
you need, add its name to the known-reporters list + `switch` in that side's `index.ts`.
No call sites change.

**Selecting providers** — env var **`CONDUIT_ERROR_REPORTER`**, a comma list
(e.g. `sentry,console`; whitespace/case-tolerant, unknown names ignored). When unset:
`sentry` if `SENTRY_DSN` is set, else empty (silent). The server resolves the list at
startup and echoes it to the browser via `GET /api/runtime-config` (`errorReporters`), so
both sides build the same composite.

**Coverage** (server, all via `reporter.*`): the WS-handler catch (tagged with channel +
user), the startup catch, an Express error-handling middleware (last `app.use`, catches
all HTTP routes), `unhandledRejection` / `uncaughtException` handlers, and the agent
runner / trigger service / repo-sync background paths. `reporter.flush(2000)` runs on
graceful shutdown. Frontend: the React `ErrorBoundary` reports via `reporter`.

**Runtime env vars**: `SENTRY_DSN`, `SENTRY_ENVIRONMENT` (falls back to `NODE_ENV`),
`SENTRY_RELEASE` (falls back to `GIT_SHA`), `SENTRY_TRACES_SAMPLE_RATE` (default `0`).

**Source maps** (readable production traces) — build-time, gated on **`SENTRY_AUTH_TOKEN`**;
builds without it skip upload entirely and emit no public maps:
- Frontend: `@sentry/vite-plugin` in `vite.server.config.ts` uploads renderer maps and
  deletes them from `out/renderer/` after upload (never served).
- Server: `tsconfig.server.json` emits maps; `scripts/upload-server-sourcemaps.mjs`
  (run as the last step of `npm run build`) uploads `out/server|main|shared` via
  `@sentry/cli`. Also set `SENTRY_ORG`, `SENTRY_PROJECT`, and a release
  (`SENTRY_RELEASE` / `GIT_SHA`).

## Data Storage

All data lives under `~/.conduit/` (or `$CONDUIT_DATA_DIR`):
- `conduit.db` — SQLite database
- `logs/` — NDJSON run logs (`{runId}.jsonl`)
- `repos/` — Bare git clones for managed repositories
- `prefs.json` — Key-value preferences (GitHub PAT stored as base64)

## TypeScript Configs

- `tsconfig.json` — Root config (shared settings)
- `tsconfig.web.json` — Renderer/frontend (uses path aliases: `@renderer/`, `@shared/`)
- `tsconfig.server.json` — Server compilation to `out/`

## Design Docs & Planning Artifacts

Brainstorming/design specs and implementation plans (under `docs/superpowers/`)
are **local working artifacts — never commit them to repo history**. They live
in the working tree only (gitignored) and are not shared through the repo.

## Testing Changes

After modifying code, verify with:
```bash
npx tsc --noEmit                          # Type-check all configs
npx tsc --noEmit --project tsconfig.web.json    # Frontend only
npx tsc --noEmit --project tsconfig.server.json # Server only
npm run build                             # Full production build
```
