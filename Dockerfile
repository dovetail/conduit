# ─── Build stage ─────────────────────────────────────────────────────────────
FROM node:22-slim AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

# Build renderer (out/renderer/) + server JS (out/server/)
RUN npm run build

# ─── Production stage ────────────────────────────────────────────────────────
FROM node:22-slim

WORKDIR /app

# git is required at runtime for repository sync (clone/fetch/worktree).
# No PID-1 wrapper (tini/dumb-init): Node 22 receives signals correctly when
# used as PID 1 with an exec-form ENTRYPOINT, and the server installs its
# own SIGTERM/SIGINT handlers for graceful shutdown.
RUN apt-get update && \
    apt-get install -y --no-install-recommends git ca-certificates && \
    rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Compiled JS only — no TS source / tsx runtime in the image.
COPY --from=builder /app/out ./out

# /data is the persistent volume for run logs and bare git clones.
# The Postgres database lives in RDS (see DATABASE_URL).
VOLUME /data
ENV CONDUIT_DATA_DIR=/data
ENV PORT=7456
ENV NODE_ENV=production

EXPOSE 7456

# Run an unprivileged user. The `node` user is provided by the official image.
USER node

ENTRYPOINT ["node", "out/server/index.js"]
