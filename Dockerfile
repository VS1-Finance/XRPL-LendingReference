# Production image for the engine. The engine runs its TypeScript source directly through tsx, so no
# compile step is needed — the image carries the workspace, its installed dependencies, and the
# generated Prisma client. The whole monorepo is copied because the engine imports every @lending/*
# package.

FROM node:22-slim AS base
WORKDIR /app
# Prisma needs openssl at runtime; install it once on the shared base.
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable && corepack prepare pnpm@10.0.0 --activate

# ---- deps: install the whole workspace from the lockfile ----
FROM base AS deps
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.json tsconfig.base.json ./
COPY packages ./packages
RUN pnpm install --frozen-lockfile

# ---- build: generate the Prisma client and compile the workspace packages ----
FROM deps AS build
# Generate the Prisma client first — the engine's source imports it, so it must exist before the
# workspace typecheck runs.
RUN pnpm --filter @lending/engine exec prisma generate
# The engine runs its own source through tsx, but it imports the other @lending/* packages, which
# resolve to their compiled dist/. Build them so those imports exist.
RUN pnpm exec tsc -b

# ---- run ----
FROM build AS run
ENV NODE_ENV=production
ENV PORT=4000
ENV HOST=0.0.0.0
EXPOSE 4000
# Apply any pending migrations, then start the engine. migrate deploy is idempotent and safe to run on
# every boot.
CMD ["sh", "-c", "pnpm --filter @lending/engine exec prisma migrate deploy && pnpm engine"]
