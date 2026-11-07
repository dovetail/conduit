# ─── Build stage ─────────────────────────────────────────────────────────────
FROM node:24-slim AS builder

WORKDIR /app

# ── Build/release metadata + optional Sentry source-map upload ───────────────
# All optional — a plain `docker build` with none of these still succeeds.
#   GIT_SHA         generic build identifier. Baked into the runtime image (prod
#                   stage below) and used as the Sentry release, so uploaded
#                   source maps line up with runtime events.
#   SENTRY_ORG /    only used to upload source maps. `npm run build` self-skips
#   SENTRY_PROJECT  the upload unless ORG + PROJECT + the sentry_auth_token
#                   secret are all present (see scripts/upload-server-sourcemaps.mjs
#                   and vite.server.config.ts). None of this is Buildkite- or
#                   Sentry-specific to the Dockerfile — the CI that supplies the
#                   values lives outside it (.buildkite/pipeline.yml here).
ARG GIT_SHA=""
ARG SENTRY_ORG=""
ARG SENTRY_PROJECT=""

# AWS RDS CA bundle for IAM-auth Postgres connections.
# https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/UsingWithRDS.SSL.html
# Fetched here so the certificate becomes part of the build cache, and so the
# build fails cleanly if AWS ever takes the URL down — rather than failing at
# pod startup. Validated on first DB connect via tls.rejectUnauthorized.
# --chmod=644: ADD'ed URLs default to 600 root:root, which survives the cp +
# COPY --from=builder into the prod stage and is unreadable by `USER node`.
ADD --chmod=644 https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem /tmp/global-bundle.pem

COPY package*.json ./
RUN npm ci

COPY . .

# Build renderer (out/renderer/) + server JS (out/server/). The Sentry auth
# token is mounted as a BuildKit secret (never baked into an image layer) and is
# optional — absent ⇒ empty ⇒ the source-map upload is skipped. (This Dockerfile
# already requires BuildKit for `ADD --chmod` above.)
RUN --mount=type=secret,id=sentry_auth_token \
    GIT_SHA="$GIT_SHA" SENTRY_ORG="$SENTRY_ORG" SENTRY_PROJECT="$SENTRY_PROJECT" \
    SENTRY_AUTH_TOKEN="$(cat /run/secrets/sentry_auth_token 2>/dev/null || true)" \
    npm run build

# Place the RDS CA bundle next to the compiled DB module so `path.join(
# __dirname, 'global-bundle.pem')` finds it in `out/main/db/`.
RUN cp /tmp/global-bundle.pem out/main/db/global-bundle.pem

# ─── Production stage ────────────────────────────────────────────────────────
FROM node:24-slim

WORKDIR /app

# git is required at runtime for repository sync (clone/fetch/worktree), and
# openssh-client for SSH clone URLs (deploy-key and server-SSH repos); curl
# is needed to fetch the Cursor CLI installer below. git-lfs is required for
# repos that store assets in git-LFS (e.g. a Yarn zero-install `.yarn/cache`):
# without it, worktree checkouts contain LFS *pointer* files instead of content,
# which breaks the agent's `yarn install`/build and stalls the run. `git lfs
# install --system` registers the smudge/clean filters for every later git op.
# No PID-1 wrapper (tini/dumb-init): the mode-aware entrypoint exec's node so
# it remains PID 1 and receives SIGTERM/SIGINT. The server and worker install
# their own handlers for graceful shutdown.
#
# The rest is the agents' shell toolbox — without them agent scripts fail
# with "command not found" and burn turns on workarounds: jq for JSON, xz for
# .tar.xz release archives, and python3 + make + g++ so node-gyp can build
# native modules (e.g. sharp) during a repo's `yarn install`.
RUN apt-get update && \
    apt-get install -y --no-install-recommends git git-lfs openssh-client ca-certificates curl \
      jq xz-utils python3 make g++ && \
    git lfs install --system && \
    rm -rf /var/lib/apt/lists/*

# pnpm via corepack. The shims must be created at build time: the runtime
# user (`node`) can't write /usr/local/bin, so `corepack enable` from inside a
# run fails with EACCES. The binary is pre-cached in COREPACK_HOME so runs
# don't each download it; the cache is owned by `node` so a repo pinning a
# different pnpm version can still fetch it. Download prompts are disabled so
# a headless run never blocks waiting for confirmation.
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 COREPACK_HOME=/opt/corepack
RUN corepack enable pnpm && \
    corepack install --global pnpm@latest && \
    chown -R node:node "$COREPACK_HOME" && \
    pnpm --version

# GitHub CLI (`gh`), installed from GitHub's official apt repo (needs the `curl`
# installed above to fetch the signing key). Agents use it for API/PR operations
# (`gh pr create`, `gh api`); at run time the runner injects the repo's git
# credential as GH_TOKEN so `gh` authenticates as the same identity `git push`
# uses. Install steps per https://github.com/cli/cli/blob/trunk/docs/install_linux.md
RUN mkdir -p -m 755 /etc/apt/keyrings && \
    curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      -o /etc/apt/keyrings/githubcli-archive-keyring.gpg && \
    chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list && \
    apt-get update && \
    apt-get install -y --no-install-recommends gh && \
    rm -rf /var/lib/apt/lists/* && \
    # Fail the build loudly if `gh` ever fails to land on PATH.
    gh --version

# GitLab CLI (`glab`), the GitLab counterpart of `gh`: for GitLab-token repos the
# runner injects GITLAB_TOKEN (+ GITLAB_HOST for self-managed instances) so
# `glab mr create` / `glab api` authenticate as the same identity `git push`
# uses. Pinned release .deb from GitLab's package registry.
ARG GLAB_VERSION=1.128.0
RUN arch="$(dpkg --print-architecture)" && \
    curl -fsSL -o /tmp/glab.deb \
      "https://gitlab.com/gitlab-org/cli/-/releases/v${GLAB_VERSION}/downloads/glab_${GLAB_VERSION}_linux_${arch}.deb" && \
    dpkg -i /tmp/glab.deb && rm /tmp/glab.deb && \
    glab --version

# Front the real gh so it reads the run's refreshed token (see the script).
COPY --chmod=755 scripts/gh-token-shim.sh /usr/local/bin/gh
RUN test "$(command -v gh)" = /usr/local/bin/gh && gh --version

# Agent CLIs the runner shells out to. Without these the deployed host reports
# every runner as "not installed" on the agent select screen and runs fail.
#   - claude       → @anthropic-ai/claude-code (npm, bin: claude)
#   - amp          → @sourcegraph/amp          (npm, bin: amp)
#   - cursor-agent → cursor.com/install script (not on npm)
# npm globals land in /usr/local/bin (on PATH for every user, incl. `node`).
RUN npm install -g @anthropic-ai/claude-code @sourcegraph/amp && \
    npm cache clean --force

# Cursor's installer chooses its install dir purely from $HOME: it drops a
# versioned build under $HOME/.local/share/cursor-agent and a `cursor-agent`
# launcher into $HOME/.local/bin. Point $HOME at a shared, world-readable dir
# (not /root, which is mode 700 and unreadable by `node`), then symlink the
# launcher onto PATH.
#
# The env assignment MUST sit on `bash`, not `curl`: in a pipeline
# `VAR=v curl ... | bash` the prefix binds only to `curl`, so the installer
# (bash) would inherit the build's HOME=/root and write there instead — leaving
# the symlink below dangling and `which cursor-agent` (the runtime install
# check) failing on the deployed host.
ENV CURSOR_HOME=/opt/cursor
RUN mkdir -p "$CURSOR_HOME" && \
    curl -fsS https://cursor.com/install | HOME="$CURSOR_HOME" bash && \
    ln -sf "$CURSOR_HOME/.local/bin/cursor-agent" /usr/local/bin/cursor-agent && \
    chmod -R a+rX "$CURSOR_HOME" && \
    # Fail the build loudly if the install layout ever drifts again: -x follows
    # the whole symlink chain and confirms the agent is actually executable,
    # mirroring the runtime `which cursor-agent` check.
    test -x /usr/local/bin/cursor-agent

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Compiled JS only — no TS source / tsx runtime in the image.
COPY --from=builder /app/out ./out

# Same image, two roles: CONDUIT_PROCESS_MODE=server|worker (default server).
# exec inside the script keeps node as PID 1 so SIGTERM/SIGINT reach it.
COPY --chmod=755 scripts/container-entrypoint.sh /app/scripts/container-entrypoint.sh

# /data is the persistent volume for run logs and bare git clones.
# The Postgres database lives in RDS. In production / staging the pod uses
# IAM auth (DATABASE_USE_RDS_IAM=true + DATABASE_HOST/PORT/NAME/USER); local
# dev uses DATABASE_URL against the docker-compose Postgres.
VOLUME /data
ENV CONDUIT_DATA_DIR=/data
ENV PORT=7456
ENV NODE_ENV=production
ENV CONDUIT_PROCESS_MODE=server

# Baked-in build identifier — used as the Sentry release at runtime so error
# events match the source maps uploaded for this commit. Empty in local/dev
# builds (harmless; Sentry release just goes untagged).
ARG GIT_SHA=""
ENV GIT_SHA=${GIT_SHA}

EXPOSE 7456

# Run an unprivileged user. The `node` user is provided by the official image.
USER node

ENTRYPOINT ["/app/scripts/container-entrypoint.sh"]
