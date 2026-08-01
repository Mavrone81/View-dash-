#!/bin/sh
# Constructs DATABASE_URL at container start from the `postgres_password`
# Docker secret's file contents, then execs whatever command this
# container was actually asked to run -- the image's default CMD for
# `web`; the `ingest` service's overridden `command:` for the listener --
# as the one process that inherits it. Used as `entrypoint:` (not
# `command:`) by both services in docker-compose.yml, so it wraps whichever
# command each one runs without either service needing its own copy of
# this logic.
#
# WHY THIS EXISTS: this project's standing rule is that secrets are
# file-mounted, never env-var literals (see
# scripts/ci/assert-no-environment-leakage.mjs and this repo's CI leak
# gate) -- and a Docker secret is exactly that: `postgres_password` is
# mounted read-only at /run/secrets/postgres_password, never written to
# `.env`, docker-compose.yml, or any `environment:` block. But Prisma's
# schema (web/prisma/schema.prisma) reads its connection string via
# `env("DATABASE_URL")` -- a real process environment variable is
# unavoidable at that one point. This script IS that one point: it reads
# the secret file itself, builds the connection string in memory, exports
# it into this shell's environment, and `exec`s the real command as a
# child that inherits it. DATABASE_URL therefore exists only for the
# lifetime of the running Node process -- never written to disk, and never
# visible in `docker inspect <container>`'s environment listing, which
# only reports the image/compose-declared environment, not a variable a
# script exports after the container has already started.
set -eu

secret_file="/run/secrets/postgres_password"
if [ ! -r "$secret_file" ]; then
  echo "with-database-url.sh: cannot read $secret_file -- is the postgres_password secret mounted?" >&2
  exit 1
fi

# Read into a shell variable, never interpolated straight into the URL
# string: a password containing `@`, `/`, `:`, `%`, or `+` would otherwise
# corrupt the URL's own structure or be silently misinterpreted (`+`
# decodes to a space in some parsers) rather than being treated as opaque
# password bytes. Percent-encoding it explicitly closes that off. `%` must
# be encoded FIRST, or encoding any other character would double-encode
# through the `%` it just introduced.
password=$(cat "$secret_file")
encoded_password=$(printf '%s' "$password" | sed \
  -e 's/%/%25/g' \
  -e 's/@/%40/g' \
  -e 's#/#%2F#g' \
  -e 's/:/%3A/g' \
  -e 's/+/%2B/g')

# `bevops` matches POSTGRES_USER/POSTGRES_DB in docker-compose.yml; `db` is
# the `db` service's compose DNS name, reachable only from services on
# this same compose stack's internal network (see the `db` service's own
# comment on why it publishes no host port).
export DATABASE_URL="postgresql://bevops:${encoded_password}@db:5432/bevops?schema=public"

exec "$@"
