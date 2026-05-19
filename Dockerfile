# ─── Build stage ─────────────────────────────────────────────────────────────
FROM node:22-slim AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

# Build React renderer → out/renderer/
RUN npx vite build --config vite.server.config.ts

# ─── Production stage ────────────────────────────────────────────────────────
FROM node:22-slim

WORKDIR /app

# git is required at runtime for repository sync (clone/fetch/worktree).
# tini provides proper signal handling for the Node process.
RUN apt-get update && \
    apt-get install -y --no-install-recommends git tini ca-certificates && \
    rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY tsconfig*.json ./

# Copy built frontend from builder
COPY --from=builder /app/out/renderer ./out/renderer

# /data is the persistent volume for run logs and bare git clones.
# The Postgres database lives in RDS (see DATABASE_URL).
VOLUME /data
ENV CONDUIT_DATA_DIR=/data
ENV PORT=7456

EXPOSE 7456

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["npx", "tsx", "src/server/index.ts"]
