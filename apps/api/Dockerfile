# syntax=docker/dockerfile:1.29.0@sha256:572cebbc2b15e6f84c077742952674889cb63cd5e9b80abdffcbe587b6f19183
# Production image for @lumenwipe/api (NestJS) built from the Bun monorepo.
# Build context = repo root:  docker build -f apps/api/Dockerfile -t lumenwipe-api .
# Runtime target = Google Cloud Run (listens on $PORT / 0.0.0.0, SIGTERM-aware).
#
# Every base image and the syntax frontend are pinned by tag AND digest, so the same commit builds
# from the same bases on any day, with nothing fetched from the Debian archive. Renovate moves the
# tags and digests. The Bun tag is the Bun in .tool-versions and CI; the distroless runtime's tag
# carries no Node version, so its image name must name the Node major in .tool-versions and the CI
# api image job checks the built image's `node --version` against .tool-versions exactly.
# scripts/check-image-pins.ts fails CI when a version drifts or a pin loses its digest.

# ── Stage 1: builder - Bun on Debian 13/glibc (ABI-matches the distroless Debian 13 runtime) ──
FROM oven/bun:1.4.4@sha256:1d22548f177f4ff38e0c15baa3c2c46c6c2060ba2d1bc573bb4720b407548f1d AS builder
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
COPY apps/playground/package.json apps/playground/
COPY packages/sdk/package.json packages/sdk/
COPY packages/types/package.json packages/types/
COPY packages/verify/package.json packages/verify/
COPY tools/lab/package.json tools/lab/
# Install the api's full dependency graph (incl. devDeps: nest CLI, typescript).
RUN bun install --frozen-lockfile --filter '@lumenwipe/api'
# Compile: nest build (tsc + asset copy) -> apps/api/dist/main.js
COPY tsconfig.base.json ./
COPY packages/types/ packages/types/
COPY apps/api/ apps/api/
RUN bun run --filter '@lumenwipe/api' build

# ── Stage 2: prod-deps - production-only dependencies (no devDependencies) ──
FROM oven/bun:1.4.4@sha256:1d22548f177f4ff38e0c15baa3c2c46c6c2060ba2d1bc573bb4720b407548f1d AS prod-deps
WORKDIR /app
COPY package.json bun.lock ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/playground/package.json apps/playground/
COPY packages/sdk/package.json packages/sdk/
COPY packages/types/package.json packages/types/
COPY packages/verify/package.json packages/verify/
COPY tools/lab/package.json tools/lab/
# Deps hoist to /app/node_modules (Bun has no isolated per-workspace prune yet);
# copy the whole tree into the runtime stage below.
RUN bun install --frozen-lockfile --production --filter '@lumenwipe/api'

# ── Stage 3: runtime - distroless Node (matches start:prod), glibc, non-root ──
# Node and the libraries it links (glibc, libstdc++, libgcc_s, libatomic), with no shell, package
# manager, npm or other tool the API never runs.
FROM gcr.io/distroless/nodejs26-debian13:nonroot@sha256:1d736cf8b5716c07a245301f92717143215d248fd55771ee1936ef4b3302e531 AS runtime
ENV NODE_ENV=production
WORKDIR /app/apps/api
# Hoisted deps live at /app/node_modules, so copy the whole prod-deps tree, then
# overlay the compiled output. Node resolves modules by walking up from apps/api.
# Owned by root, so the process can read its code but not change it.
COPY --from=prod-deps /app /app
COPY --from=builder /app/apps/api/dist /app/apps/api/dist
# The commit this image was built from, reported at `/`. Declared last so a new commit
# invalidates no earlier layer.
ARG GIT_SHA=""
ENV GIT_SHA=${GIT_SHA}
USER nonroot
# Node runs as PID 1 with no init: app.enableShutdownHooks() (main.ts) installs the SIGTERM handler
# that runs Nest's shutdown hooks when Cloud Run stops the instance, and the API starts no child
# processes to reap. Cloud Run injects PORT (default 8080); main.ts binds 0.0.0.0.
ENTRYPOINT ["/nodejs/bin/node"]
CMD ["dist/main.js"]
