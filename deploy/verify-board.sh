#!/usr/bin/env bash
#
# External-probe deployment verification. Run ON THE DASHBOARD HOST.
#
# Like `deploy/verify-vault.sh`, this exists to fail. A check that passes
# before the feature it verifies exists is not testing what it claims to --
# this project has already shipped two such scripts (one whose failure
# counter never incremented, one whose regex could never match real output),
# both of which looked authoritative while proving nothing. Run this BEFORE
# deploying, on the pre-migration schema, and confirm it reports FAIL on the
# schema check below -- that failure is the proof this script can actually
# tell a working deployment from a broken one.
#
# What this verifies: that migrations for `ExternalProbeResult` /
# `ExternalProbeRun` are applied, that the scheduler wired up in
# `web/src/server/ingest-server.ts` (Task 9's one production caller for the
# external prober -- see `web/src/lib/probe-scheduler.ts`) has actually run
# at least once, and that the fleet board still answers. It deliberately does
# NOT assert that `ExternalProbeResult` holds any rows -- see that check's own
# comment for why a fleet-wide network fault correctly leaves it empty
# forever, by design (Task 7a/8), and asserting non-emptiness would fight
# that design rather than verify it.

set -uo pipefail

BASE="${BASE:-http://127.0.0.1:3000}"
DB_SERVICE="${DB_SERVICE:-db}"
DB_USER="${DB_USER:-bevops}"
DB_NAME="${DB_NAME:-bevops}"
failures=0
checks=0

check() {
  checks=$((checks + 1))
  if eval "$2"; then
    printf 'PASS  %s\n' "$1"
  else
    printf 'FAIL  %s\n' "$1"
    failures=$((failures + 1))
  fi
}

echo "Verifying external probe deployment at ${BASE}"
echo

# --- SCHEMA FIRST, same reasoning as verify-vault.sh: a deploy that landed
# new code on an old schema is indistinguishable, from the outside, from a
# dead application, and looking at `information_schema` directly answers
# "does the running database actually have this table" rather than trusting
# a migration-history row.
TABLES="$(docker compose exec -T "$DB_SERVICE" \
  psql -U "$DB_USER" -d "$DB_NAME" -tAc \
  "SELECT table_name FROM information_schema.tables WHERE table_name IN ('ExternalProbeResult', 'ExternalProbeRun') ORDER BY table_name" \
  2>/dev/null)"

check "database schema is current (ExternalProbeResult and ExternalProbeRun both exist)" \
  '[ "$(printf %s "$TABLES" | tr -d "[:space:]")" = "ExternalProbeResultExternalProbeRun" ]'

if [ "$(printf %s "$TABLES" | tr -d '[:space:]')" != "ExternalProbeResultExternalProbeRun" ]; then
  cat <<'SCHEMA'
      ^ If this failed, do NOT debug the application. Either the migration
        was never applied, or it was applied from an image that predates it
        (`docker compose run` pulls only when the tag is MISSING, so a cached
        `latest` silently migrates nothing). Pull first, then migrate --
        NEVER the reverse, or the migrate step runs inside the stale cached
        image and reports "No pending migrations" while landing new code on
        the old schema:

          docker compose pull web ingest
          docker compose run --rm --pull always web /deploy/with-database-url.sh \
            npx prisma migrate deploy --schema web/prisma/schema.prisma
          docker compose up -d web ingest

SCHEMA
fi

check "fleet board still answers on loopback" \
  '[ "$(curl -s -o /dev/null -w %{http_code} "$BASE/")" = 200 ]'

# --- Has the scheduler actually run? ---
#
# `ExternalProbeRun` (schema.prisma) is written on EVERY sweep, including one
# that reached nothing -- see `external-probe-runner.ts`'s own docstring --
# so its row count answers "did the scheduler in
# `web/src/server/ingest-server.ts` actually fire" directly, independent of
# whatever `ExternalProbeResult` does or does not hold.
#
# THIS CHECK IS EXPECTED TO FAIL for up to one cadence interval (5 minutes,
# `EXTERNAL_PROBE_INTERVAL_MS` in `web/src/lib/fleet-query.ts`) after a fresh
# deploy or a fresh `ingest` container start -- there is no sweep to have run
# yet. That is correct behaviour, not a fault: the board's external axis
# reads "not yet confirmed" / "certificate not checked yet" on every row
# until the first sweep completes, exactly as it does on a fresh install with
# no agents enrolled yet. If this fails immediately after `docker compose up
# -d web ingest`, wait five minutes and re-run this script before treating it
# as a real problem.
RUN_COUNT="$(docker compose exec -T "$DB_SERVICE" \
  psql -U "$DB_USER" -d "$DB_NAME" -tAc \
  'SELECT count(*) FROM "ExternalProbeRun"' \
  2>/dev/null | tr -d '[:space:]')"

check "the external probe scheduler has run at least once (found: ${RUN_COUNT:-<unreadable>} sweep(s))" \
  '[ -n "$RUN_COUNT" ] && [ "$RUN_COUNT" -gt 0 ]'

RESULT_COUNT="$(docker compose exec -T "$DB_SERVICE" \
  psql -U "$DB_USER" -d "$DB_NAME" -tAc \
  'SELECT count(*) FROM "ExternalProbeResult"' \
  2>/dev/null | tr -d '[:space:]')"
echo "INFO  ExternalProbeResult currently holds ${RESULT_COUNT:-<unreadable>} row(s) -- not asserted on: a"
echo "      persistent fleet-wide network fault correctly leaves this at 0 forever (Task 7a's guard), so a"
echo "      hard PASS/FAIL here would contradict that design rather than verify it. Zero here alongside a"
echo "      non-zero sweep count above means every recent sweep reached nothing -- check this HOST's own"
echo "      egress, not the monitored fleet."

echo
if [ "$failures" -eq 0 ]; then
  printf 'All %d checks passed.\n' "$checks"
else
  printf '%d of %d checks FAILED.\n' "$failures" "$checks"
fi

cat <<'NOTE'

MANUAL CONFIRMATION, NOT AUTOMATED HERE:
Once at least one sweep has run, open the fleet board (see deploy/README.md's
SSH tunnel step) and confirm that a hostname with NO certificate reads
"TLS fails", never "app down" -- that distinction (route/certificate faults
named separately from the application itself) is this slice's core claim,
and this host already has real hostnames in that state to check it against.
This can't be scripted here without hardcoding which real hostnames those
are, which this repository -- being public -- must never do.

NOTE

exit $((failures > 0))
