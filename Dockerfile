# ─── Build stage ─────────────────────────────────────────────────────────────
FROM node:22-slim AS builder

WORKDIR /app

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

# Build renderer (out/renderer/) + server JS (out/server/)
RUN npm run build

# Place the RDS CA bundle next to the compiled DB module so `path.join(
# __dirname, 'global-bundle.pem')` finds it in `out/main/db/`.
RUN cp /tmp/global-bundle.pem out/main/db/global-bundle.pem

# ─── Production stage ────────────────────────────────────────────────────────
FROM node:22-slim

WORKDIR /app

# git is required at runtime for repository sync (clone/fetch/worktree); curl
# is needed to fetch the Cursor CLI installer below.
# No PID-1 wrapper (tini/dumb-init): Node 22 receives signals correctly when
# used as PID 1 with an exec-form ENTRYPOINT, and the server installs its
# own SIGTERM/SIGINT handlers for graceful shutdown.
RUN apt-get update && \
    apt-get install -y --no-install-recommends git ca-certificates curl && \
    rm -rf /var/lib/apt/lists/*

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

# /data is the persistent volume for run logs and bare git clones.
# The Postgres database lives in RDS. In production / staging the pod uses
# IAM auth (DATABASE_USE_RDS_IAM=true + DATABASE_HOST/PORT/NAME/USER); local
# dev uses DATABASE_URL against the docker-compose Postgres.
VOLUME /data
ENV CONDUIT_DATA_DIR=/data
ENV PORT=7456
ENV NODE_ENV=production

EXPOSE 7456

# Run an unprivileged user. The `node` user is provided by the official image.
USER node

ENTRYPOINT ["node", "out/server/index.js"]
