# Conduit

A self-hosted web app for managing and running AI CLI agents (Claude Code, Amp, Cursor) — live terminal streaming, MCP server management, scheduled runs, and publish targets, with pluggable local or remote execution.

![Conduit screenshot](docs/screenshot.png)

## Features

- **Multi-runner** — Claude Code, Amp, and Cursor agents
- **Live terminal streaming** — xterm.js with full ANSI colour output
- **MCP management** — global and per-agent servers with OAuth support and health indicators
- **Pluggable execution** — run agents in-process, on remote workers, or as ephemeral EKS Jobs / Fargate tasks
- **Scheduled runs** — cron triggers per agent
- **Publish targets** — deliver agent output to Slack, email (SMTP), or signed webhooks
- **Managed repositories** — run agents against git repos with PAT, SSH, or GitHub App auth
- **GitHub Gist integration** — save/load/browse prompts; AI-assisted prompt crafting
- **Docker-ready** — single-image deploy via `docker compose`

## Quick start

### Prerequisites

- Node.js 20+
- One or more agent CLIs on your PATH: [`claude`](https://claude.ai/code), [`amp`](https://ampcode.com), or `cursor-agent`
- Postgres 16 — the bundled container below is the easiest option (or point `DATABASE_URL` at your own)

### Install and run

```bash
npm install
npm run db:up   # Postgres 16 in a container
npm run dev
```

Open **http://localhost:7456**. No login needed in dev — auth runs in bypass mode (a "DEV" badge shows top-left). Vite watches the renderer and `tsx watch` restarts the server on changes.

Create your first agent: **New agent** → pick a runner → write a prompt → **Run**. Each run gets an ephemeral workspace and streams output live to the browser.

### Production

```bash
npm run build   # renderer → out/renderer/, server → out/server/
npm start
```

Or with Docker — app and Postgres together:

```bash
docker compose up
```

To try **remote worker mode** locally, uncomment `CONDUIT_WORKER_FACTORY`/`CONDUIT_WORKER_TOKEN` on the `conduit` service in `docker-compose.yml`, then:

```bash
docker compose --profile worker up
```

## Configuration

All configuration is via environment variables. A fresh clone needs none of these for local dev.

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `7456` | HTTP/WebSocket listen port |
| `DATABASE_URL` | `postgres://conduit:conduit@localhost:5432/conduit` | Postgres connection string. SSL is enabled by default for explicit URLs — set `DATABASE_SSL=disable` for a plain local Postgres. |
| `CONDUIT_DATA_DIR` | `~/.conduit` | Run logs, repo clones, preferences |
| `CONDUIT_BASE_URL` | `http://localhost:7456` | Canonical public URL. **Required in production** — MCP OAuth redirect URIs are derived from it and must be byte-stable. |
| `CONDUIT_ALLOWED_IPS` | *(open)* | Comma-separated CIDR allowlist, e.g. `10.0.0.0/8,127.0.0.1/32` |
| `CONDUIT_SECRET_KEY` | *(none)* | 64-hex-char key encrypting secrets at rest (GitHub App keys, MCP OAuth tokens). Generate with `openssl rand -hex 32`. **Required in production** — do not rotate once secrets are stored. |
| `CONDUIT_WORKER_FACTORY` | `local` | Execution backend: `local`, `remote`, `eks`, or `fargate` — see [Architecture](#architecture) |
| `CONDUIT_WORKER_TOKEN` | *(none)* | Shared secret authenticating workers on `/ws/worker`. Required for non-local factories |
| `CONDUIT_SERVER_URL` | *(none)* | `wss://<host>/ws/worker` — set on the worker side so it can dial the control plane |

**Multi-user auth (production):** with no auth env vars, Conduit runs in single-user dev bypass. Set `CONDUIT_OKTA_ISSUER`, `CONDUIT_OKTA_CLIENT_ID`, `CONDUIT_OKTA_CLIENT_SECRET`, and `CONDUIT_SESSION_SECRET` to enable Okta OIDC login with per-user ownership and sharing. The full env-var list (session TTL, group sync, API token) is in `CLAUDE.md`.

## Architecture

Conduit splits into two planes with a hard boundary:

- **Orchestration** (always in the server process) — run records, log persistence, browser broadcasts, credential resolution, publishing, cleanup.
- **Execution** (pluggable) — workspace materialization, CLI spawn, event streaming, cancellation, delegated to a `WorkerFactory`.

The orchestrator hands the factory a **`RunSpec`** — a fully self-contained, serializable job description (prompt, resolved env, materialized MCP config, workspace spec) — and events stream back through a `WorkerEventSink`. Because the `RunSpec` carries everything a run needs, execution can happen in the server process, on a separate host, or in ephemeral cloud compute, with no orchestrator changes.

```mermaid
flowchart LR
    subgraph Browser
        UI["React SPA"]
    end
    subgraph Server["Conduit Server"]
        API["Express + /ws JSON-RPC"]
        ORCH["Run Orchestrator<br/>server/runner.ts"]
        REG["WorkerFactory registry<br/>CONDUIT_WORKER_FACTORY"]
        CP["Worker Control Plane<br/>/ws/worker (WSS + Bearer)"]
        DB[("Postgres, logs, repos")]
    end
    subgraph Exec["Execution (pluggable)"]
        LOCAL["LocalWorkerFactory<br/>in-process spawn"]
        REMOTE["conduit-worker<br/>processes"]
        EKS["EKS Jobs<br/>1 per run"]
        FARG["Fargate tasks<br/>1 per run"]
    end
    UI <-->|"/ws JSON-RPC + push events"| API
    API --> ORCH
    ORCH --> REG
    ORCH --> DB
    REG --> LOCAL
    REG --> CP
    CP <-->|"WSS + Bearer token"| REMOTE
    CP <-->|"WSS + Bearer token"| EKS
    CP <-->|"WSS + Bearer token"| FARG
```

### Worker factories

`CONDUIT_WORKER_FACTORY` selects the execution backend:

| Value | Execution | Notes |
|-------|-----------|-------|
| `local` *(default)* | In-process spawn | Identical to classic single-process behavior; zero config |
| `remote` | Pooled `conduit-worker` processes | Workers run on any host and dial back over the control plane |
| `eks` | One Kubernetes Job per run | Pod dials back; Job deleted on exit, TTL self-cleans |
| `fargate` | One ECS task per run | Task dials back; task stopped on exit |

`eks` and `fargate` create **one ephemeral unit of compute per run** with a deterministic worker ID (`eks-<runId>` / `fargate-<runId>`). The unit connects *outbound* to the control plane and receives its `RunSpec` there — secrets only ever travel over the authenticated WSS channel, never through Job specs or task definitions.

### Worker control plane

Remote execution uses a dedicated endpoint, **`GET /ws/worker`**, kept separate from the browser `/ws` socket: workers authenticate with `Authorization: Bearer <CONDUIT_WORKER_TOKEN>` at upgrade and never join the browser broadcast set (no log leakage, no RPC access). Use `wss://` outside localhost — `RunSpec`s carry resolved secrets.

```mermaid
sequenceDiagram
    participant W as conduit-worker
    participant C as Control Plane (server)
    W->>C: WSS upgrade + Bearer token (401 if wrong)
    W->>C: worker:hello (capabilities, activeRunIds)
    loop every 30s
        W->>C: worker:heartbeat (activeRunIds)
    end
    C->>W: run:assign (RunSpec)
    W->>C: run:started (workspacePath)
    W->>C: run:event (batched stdout/stderr)
    W->>C: run:exit (status, exitCode)
    Note over C: socket close or 75s without a heartbeat<br/>= dead worker: synthesize a failed exit<br/>into each of its runs' sinks
```

75 seconds without a heartbeat (2.5 missed beats) declares a worker dead; its runs are failed via a synthesized exit, so the normal finalize path (log, broadcast, publish, sweep) still runs — runs can never be stuck in `running` forever.

### Run lifecycle

```mermaid
sequenceDiagram
    participant B as Browser
    participant O as Orchestrator
    participant F as WorkerFactory
    participant W as Worker (any kind)
    B->>O: run:start
    O->>O: create run record, build RunSpec<br/>(prompt, env, MCP config, workspace)
    O->>F: startRun(spec, sink)
    alt local
        F->>W: materialize workspace, spawn CLI
    else remote / eks / fargate
        F->>W: provision / dispatch via control plane
    end
    W-->>F: output events
    F-->>O: sink.onEvent
    O-->>B: broadcast (log events)
    O->>O: append to logs/runId.jsonl
    W-->>F: exit
    F-->>O: sink.onExit (status, exitCode)
    O->>O: finalize: status, publish targets, workspace sweep
    O-->>B: broadcast (run:statusChange)
```

Repo-backed agents on remote factories use a `repo-clone` workspace: the worker shallow-clones straight from the remote with the run's short-lived token — no dependency on the server's bare clone. `fixedDir` agents are rejected on remote factories (the path only exists on the server host).

## Using Conduit

### Agents and workspaces

By default each run gets an ephemeral temp workspace, deleted after the run. Two alternatives:

- **Working directory** — an absolute path on the server host (e.g. a checkout the agent should work in). Never deleted.
- **Managed repository** — Conduit keeps a bare clone in sync; each run gets an isolated git worktree (or, on remote factories, a shallow clone of its own).

### MCP servers

Agent-specific and global MCP servers are merged before each run (agent config wins on key conflict). `${ENV_VAR}` placeholders in `env` and `args` are expanded from the server's process environment, and OAuth tokens are injected as `Authorization: Bearer` headers automatically. `npm run seed` adds Sentry, Datadog, and Buildkite as global servers (idempotent) — set `SENTRY_ACCESS_TOKEN`, `DD_API_KEY`, `DD_APP_KEY`, `DD_SITE`, `BUILDKITE_API_TOKEN` first.

### Driving Conduit from an MCP client

Conduit is itself an MCP server at `POST /api/mcp`, so an LLM client can create and edit agents, start and debug runs, manage triggers, and iterate on prompts (with revision history and per-revision success rates) without the UI. Mint a token in **Settings → MCP access** (`read` or `write` scope), then:

```bash
claude mcp add --transport http conduit http://localhost:7456/api/mcp --header "Authorization: Bearer cdt_…"
```

Or in an `mcp.json`: `{ "mcpServers": { "conduit": { "url": "http://localhost:7456/api/mcp", "headers": { "Authorization": "Bearer cdt_…" } } } }`. For stdio-only clients, run the bridge: `CONDUIT_MCP_URL=http://localhost:7456/api/mcp CONDUIT_MCP_TOKEN=cdt_… npm run mcp:stdio`. In dev-bypass mode tokens are optional unless `CONDUIT_MCP_REQUIRE_TOKEN=true`; set `CONDUIT_MCP_ENABLED=false` to turn the endpoint off. Secrets are always returned as `[redacted]`.

### Publish targets

Publish targets deliver agent output to external channels. Create targets in the **Publish Targets** panel and assign them to agents in the agent editor.

| Type | Delivery | Config |
|------|----------|--------|
| **Slack** | `chat.postMessage` API or incoming webhook | Bot token + channel ID, or webhook URL |
| **Email** | SMTP | Host, port, TLS, credentials, from/to, subject template |
| **Webhook** | HTTP POST/PUT | URL, custom headers, optional HMAC-SHA256 signing secret |

The agent controls what gets published. If its output contains a publish block, only the content between the tags is sent; otherwise the full stdout is delivered:

```
<!--CONDUIT:PUBLISH-->
Your formatted summary here (supports **markdown** and [links](url))
<!--/CONDUIT:PUBLISH-->
```

Parsing accepts a few common agent mistakes (HTML-escaped comments, `<!--CONDUIT:END-->`, a repeated opening tag as the closer, or a missing closer). Once an opening marker appears, surrounding run narration is never used as a fallback.

For Slack, markdown is converted to mrkdwn; for email, to HTML. Webhooks receive `{ content, agent, runId, timestamp }`.

### GitHub App authentication

A managed repository can authenticate to GitHub with a **GitHub App** instead of a PAT — preferred for org-owned repos (the install belongs to the org, scoped to specific repos).

1. Create a GitHub App with the **Contents** repository permission; download its private key (`.pem`).
2. Install the app on the org or specific repos — Conduit auto-discovers the installation at run time.
3. Set `CONDUIT_SECRET_KEY` in the server environment (encrypts the stored PEM — don't rotate it afterwards).
4. In Conduit's repository settings, choose **GitHub App**, enter the **App ID**, and upload the PEM.

The PEM is encrypted (AES-256-GCM) before it touches the database and is never returned to the client. At run time Conduit mints a short-lived (~1h) installation token and injects it into the HTTPS git URL.

## Development

### Stack

| Layer | Technology |
|-------|-----------|
| Server | Node.js + Express + WebSocket (`ws`), `tsx` in dev |
| Database | Postgres + Drizzle ORM |
| Frontend | React 18 + Vite + Tailwind CSS v3 |
| Terminal | xterm.js |
| State | Zustand + TanStack Query |
| Prompt editor | CodeMirror 6 |

### Project structure

```
src/
├── server/              # Express + WebSocket server
│   ├── index.ts         # Entry point, all IPC channel handlers
│   ├── runner.ts        # Run orchestrator: records, logs, broadcasts, finalize
│   ├── workerControl.ts # /ws/worker control plane (registry, leases, assignment)
│   └── workers/         # WorkerFactory impls: local, remote, eks, fargate
├── worker/index.ts      # conduit-worker: standalone execution agent
├── main/
│   ├── db/              # Schema, initDb, per-table queries
│   ├── execution/       # Runner adapters (claude/amp/cursor), workspace helpers
│   └── utils/           # MCP config build + file write, paths
├── renderer/            # React SPA (components, hooks, Zustand store, WS client)
└── shared/              # Types-only contracts: types.ts, worker.ts, workerControl.ts
e2e/                     # E2E suites: lib/ (shared harness), local/, remote/
```

### Data model

**`agents`** — id, name, runner, prompt, envVars/mcpConfig (JSON), gistId, workingDir, repositoryId, timestamps, ownerId
**`runs`** — id, agentId, status (`running|completed|failed|stopped|launched`), startedAt/endedAt, durationMs, workspacePath, logPath, exitCode, workerKind, workerId
**`global_mcp_servers`**, **`publish_targets`**, **`repositories`**, **`triggers`** — config (JSON) + enabled flags + ownerId
**`oauth_tokens`**, **`shares`** — encrypted MCP OAuth tokens; polymorphic sharing (user/group/everyone)

Run output is stored as NDJSON RunEvents (`{t, kind, …}`) in `{CONDUIT_DATA_DIR}/logs/{runId}.jsonl`.

### Testing

```bash
npm test            # vitest unit + component suites
npm run typecheck   # all tsconfigs
npm run build       # full production build
```

End-to-end suites (require a build and a reachable Postgres — `npm run db:up`; each spins up the real server on a dedicated port with a stub `claude` CLI — no API keys needed):

```bash
npm run e2e:local    # in-process factory: run/stop/log/concurrency guard
npm run e2e:remote   # decoupled mode: server + standalone conduit-worker over the
                     # /ws/worker control plane, worker-death (SIGKILL mid-run →
                     # run fails, never stuck), and worker-reconnect scenarios
```

### Notes

- **No Electron** — originally an Electron app, converted to a pure web server; `src/main/` predates the conversion.
- **WebSocket protocol** — all frontend↔backend traffic uses one `/ws` connection with a `{type, id, channel, args}` invoke/response protocol plus server-push events.
