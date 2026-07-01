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
