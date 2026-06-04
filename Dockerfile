# ─── Build stage ─────────────────────────────────────────────────────────────
FROM node:22-slim AS builder

WORKDIR /app

# AWS RDS CA bundle for IAM-auth Postgres connections.
# https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/UsingWithRDS.SSL.html
# Fetched here so the certificate becomes part of the build cache, and so the
# build fails cleanly if AWS ever takes the URL down — rather than failing at
# pod startup. Validated on first DB connect via tls.rejectUnauthorized.
ADD https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem /tmp/global-bundle.pem

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
