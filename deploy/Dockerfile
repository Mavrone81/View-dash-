# syntax=docker/dockerfile:1
#
# Builds the ONE image docker-compose.yml's `web` and `ingest` services
# both run (see that file's top-of-file comment for how they differ only
# by `command:`). Build from the REPO ROOT so the npm workspaces
# (shared, agent, web) are all in context:
#
#   docker build -f deploy/Dockerfile -t bevora-ops:<tag> .
#
# Every step below was verified locally before being written down here --
# not assumed. In particular, two things fail in ways that are NOT obvious
# from reading the source, and are called out where they matter:
#   1. `next build` (the default, Turbopack) cannot resolve this repo's
#      NodeNext-style relative imports (`from './foo.js'` importing a
#      sibling `foo.ts`) -- confirmed by actually running it. Plain
#      webpack can, via web/next.config.ts's `resolve.extensionAlias`
#      hook, which is why the build step below passes `--webpack`
#      explicitly rather than using this Next version's default.
#   2. Next's standalone output does not include `.next/static` --
#      confirmed by running the standalone server and getting a 404 on
#      every asset until it was copied in by hand, below.

# ---- deps: install workspace dependencies once, cached by lockfile ------
FROM node:22-alpine AS deps
WORKDIR /repo
# Alpine ships OpenSSL 3, which is what Prisma's generated query-engine
# binary links against at runtime -- installed here because `prisma
# generate` (triggered by `web`'s `postinstall`, below) targets whatever
# platform it runs ON, and this stage IS that platform for every later
# stage that copies its output forward.
RUN apk add --no-cache openssl libc6-compat
COPY package.json package-lock.json ./
COPY shared/package.json shared/package.json
COPY agent/package.json agent/package.json
COPY web/package.json web/package.json
COPY web/prisma web/prisma
# At the REPO ROOT, not inside web/ -- these are npm workspaces (shared,
# agent, web); a root install is what makes `@bevora-ops/shared` resolve
# for every other workspace via its node_modules symlink, exactly as
# local dev and this repo's CI (`npm ci` in .github/workflows) already do.
# `web`'s `postinstall` (`prisma generate`) runs as part of this.
RUN npm ci

# ---- build: compile everything that ships -------------------------------
FROM deps AS build
WORKDIR /repo
COPY . .
# A stray local `web/.env` (git-ignored, so absent from a clean checkout,
# but not guaranteed absent from every possible build context) must never
# end up baked into the image: Next's standalone output copies any
# `.env*` file it finds next to `web/` VERBATIM into the runtime bundle --
# confirmed locally, with a real local DATABASE_URL. This app only ever
# receives DATABASE_URL at container start, from
# deploy/with-database-url.sh -- never from a file shipped inside the
# image -- so any such file is removed before the build reads the
# directory, as a second, independent guard alongside .dockerignore.
RUN rm -f web/.env web/.env.local web/.env.production web/.env.production.local

# See this file's header for why `--webpack` is not optional here.
RUN npm run build --workspace web -- --webpack
# web/dist/ingest-server.mjs and web/dist/enrol-cli.mjs -- neither is
# reachable from anything Next's own build traces (see
# scripts/build/bundle-ingest.mjs's header for why `ws` is bundled INTO
# these rather than relying on that trace), so they are built and copied
# in as their own step below.
RUN npm run build:ingest
RUN npm run build:enrol

# ---- runtime: slim image, no source, no dev dependencies ----------------
FROM node:22-alpine AS runtime
WORKDIR /app
RUN apk add --no-cache openssl
ENV NODE_ENV=production
# The `prisma` CLI -- NOT just `@prisma/client` -- so `prisma migrate
# deploy` can run against this exact image via `docker compose run`,
# as its own one-off command, never inside `web`/`ingest`'s entrypoint or
# CMD (see deploy/README.md's migration step for why: with `web` and
# `ingest` sharing one image and both starting at once, a migration run
# from a shared entrypoint would race itself with no lock coordination).
# Version pinned to match web/package.json's own `prisma` devDependency --
# the CLI and the generated `@prisma/client` it manages must agree.
RUN npm install -g prisma@6.19.3

# Next's own standalone output: server.js, a dependency-traced
# node_modules subset (this includes the generated `@prisma/client` and
# its query-engine binary, since `web`'s pages import it -- and does NOT
# include `ws`, which nothing Next traces ever imports; see
# scripts/build/bundle-ingest.mjs for why that dependency is bundled
# directly into web/dist/ingest-server.mjs instead), and this monorepo's
# relative layout preserved (./web, ./shared).
COPY --from=build /repo/web/.next/standalone ./
# Static assets are NOT part of standalone output -- Next's own documented
# gap, not an oversight here. Confirmed locally: every /_next/static/*
# request 404s without this line, even though the page itself renders.
COPY --from=build /repo/web/.next/static ./web/.next/static
COPY --from=build /repo/web/dist ./web/dist
# schema.prisma + the migrations/ directory -- needed by the `prisma`
# CLI above, not by @prisma/client at runtime (its generated code embeds
# what it needs from the schema already; nothing here is read by
# `web`/`ingest`'s own request-handling code).
COPY --from=build /repo/web/prisma ./web/prisma
# Belt-and-suspenders only: docker-compose.yml bind-mounts this same file
# from the dashboard host's own checkout at
# /deploy/with-database-url.sh, which is what both services actually run
# in a real deployment (see that file's comment on the `web`/`ingest`
# services). Baking a copy in here too means the image is still correct
# on its own if that bind mount is ever misconfigured or removed.
COPY --from=build /repo/deploy/with-database-url.sh /deploy/with-database-url.sh

EXPOSE 3000
# A convenience default for running this image directly (`docker run
# <image>`) -- docker-compose.yml sets BOTH services' `command:` explicitly
# (`web` repeats this exact line; `ingest` overrides it to
# `["node", "web/dist/ingest-server.mjs"]`), because overriding
# `entrypoint:` the way both services do (to run
# deploy/with-database-url.sh first) discards this CMD entirely unless a
# compose `command:` is also given -- see docker-compose.yml's comment on
# the `web` service for how that was found the hard way.
CMD ["node", "web/server.js"]
