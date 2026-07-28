# syntax=docker/dockerfile:1
# Production image for @lumenwipe/api (NestJS) built from the Bun monorepo.
# Build context = repo root:  docker build -f apps/api/Dockerfile -t lumenwipe-api .
# Runtime target = Google Cloud Run (listens on $PORT / 0.0.0.0, SIGTERM-aware).

# ── Stage 1: builder — Bun on Debian/glibc (ABI-matches node:24-slim runtime) ──
FROM oven/bun:1.3 AS builder
WORKDIR /app
# bun install --frozen-lockfile needs EVERY workspace manifest present, even when
# building a single app. Copy the root lockfile + all workspace package.json first
# so dependency install caches independently of source changes.
# NOTE: the api imports @lumenwipe/types (type-only). tsc needs that package's SOURCE
# at build time to resolve it, so the builder copies packages/types/ before the build.
# It is type-only (import type -> erased at compile), so the runtime image needs neither
# the package nor its source, and the prod-deps stage rightly omits it.
COPY package.json bun.lock ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/sdk/package.json packages/sdk/
COPY packages/types/package.json packages/types/
# Install the api's full dependency graph (incl. devDeps: nest CLI, typescript).
RUN bun install --frozen-lockfile --filter '@lumenwipe/api'
# Compile: nest build (tsc + asset copy) -> apps/api/dist/main.js
COPY tsconfig.base.json ./
COPY packages/types/ packages/types/
COPY apps/api/ apps/api/
RUN bun run --filter '@lumenwipe/api' build

# ── Stage 2: prod-deps — production-only dependencies (no devDependencies) ──
FROM oven/bun:1.3 AS prod-deps
WORKDIR /app
COPY package.json bun.lock ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/sdk/package.json packages/sdk/
COPY packages/types/package.json packages/types/
# Deps hoist to /app/node_modules (Bun has no isolated per-workspace prune yet);
# copy the whole tree into the runtime stage below.
RUN bun install --frozen-lockfile --production --filter '@lumenwipe/api'

# ── Stage 3: runtime — Node (matches start:prod), glibc slim, non-root ──
FROM node:24-slim AS runtime
ENV NODE_ENV=production
# dumb-init as PID 1 forwards Cloud Run's SIGTERM to node so Nest's shutdown hooks
# run within the grace window (can't pass `docker run --init` on Cloud Run).
RUN apt-get update \
  && apt-get install -y --no-install-recommends dumb-init \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app/apps/api
# Hoisted deps live at /app/node_modules, so copy the whole prod-deps tree, then
# overlay the compiled output. Node resolves modules by walking up from apps/api.
COPY --from=prod-deps --chown=node:node /app /app
COPY --from=builder --chown=node:node /app/apps/api/dist /app/apps/api/dist
USER node
# Cloud Run injects PORT (default 8080); main.ts binds 0.0.0.0. EXPOSE is doc-only.
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/main.js"]
