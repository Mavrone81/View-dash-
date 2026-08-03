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

# --- Has the scheduler run RECENTLY? ---
#
# Fix round 1 (review), C1 -- CRITICAL, and confirmed live: the first version
# of this check counted `ExternalProbeRun` with NO time bound. `ExternalProbeRun`
# is append-only (a fresh row per sweep, never updated or deleted -- see its
# own docstring in schema.prisma), so once ANY sweep has ever succeeded, even
# once, that unbounded count is permanently >0 -- a scheduler dead for a month
# (`ingest` crash-looping, the scheduler silently removed from
# `ingest-server.ts`, whatever) still reads "PASS ... found: 47 sweep(s))"
# forever, off the memory of a single sweep that ran once. Reproduced exactly
# against a stubbed `docker`/real HTTP listener with a month-old row: printed
# `PASS ... found: 47 sweep(s)) / All 3 checks passed. EXIT=0` on a scheduler
# that had been dead the whole time. That is the THIRD verification script in
# this project that could not fail (see this file's own header) -- found
# before it shipped, not after.
#
# The fix is a WHERE clause, bounded to the same 15 minutes
# `EXTERNAL_RESULT_STALE_AFTER_MS` (web/src/lib/fleet-query.ts) uses to decide
# whether a stored external result is still a CURRENT opinion -- three missed
# 5-minute cadences. Using the same number here is deliberate, not a
# coincidence: this check and the board's own staleness rule should agree
# about what "current" means, or an operator could see this script pass while
# the board is already discounting every reading as stale, or the reverse.
#
# THIS CHECK IS EXPECTED TO FAIL for up to one cadence interval (5 minutes,
# `EXTERNAL_PROBE_INTERVAL_MS` in `web/src/lib/fleet-query.ts`) after a fresh
# deploy or a fresh `ingest` container start -- there is no sweep to have run
# yet. That is correct behaviour, not a fault: the board's external axis
# reads "not yet confirmed" / "certificate not checked yet" on every row
# until the first sweep completes, exactly as it does on a fresh install with
# no agents enrolled yet. If this fails immediately after `docker compose up
# -d web ingest`, wait five minutes and re-run this script before treating it
# as a real problem. (A fleet with zero hostnames configured anywhere still
# writes a run row every cadence -- see `external-probe-runner.ts`'s M4 fix --
# so this check passing does not depend on any system actually having an HTTP
# surface yet, only on the scheduler itself being alive.)
RUN_COUNT="$(docker compose exec -T "$DB_SERVICE" \
  psql -U "$DB_USER" -d "$DB_NAME" -tAc \
  "SELECT count(*) FROM \"ExternalProbeRun\" WHERE \"ranAt\" > now() - interval '15 minutes'" \
  2>/dev/null | tr -d '[:space:]')"

check "the external probe scheduler has run recently, within the last 15 minutes (found: ${RUN_COUNT:-<unreadable>} sweep(s))" \
  '[ -n "$RUN_COUNT" ] && [ "$RUN_COUNT" -gt 0 ]'

# --- Did the MOST RECENT sweep actually attempt to probe anything? ---
#
# Final whole-branch review, I2 -- THE FOURTH VERIFICATION SCRIPT IN THIS
# PROJECT THAT COULD NOT FAIL, and the data to catch it was added LAST ROUND
# (`ExternalProbeRun.targetCount`, fix round 1's M4). The check above only
# proves the SCHEDULER is alive -- `runExternalProbes` (external-probe-runner.ts)
# writes a run row UNCONDITIONALLY, including one that swept zero targets, so
# `count(*)` on its own cannot tell "hostname discovery is broken on every
# monitored host, and this deployment has never made one outbound probe" apart
# from "the scheduler is healthy and sweeping normally". Reproduced: a
# deployment where every vhost file fails to parse still prints
# `PASS ... found: 3 sweep(s)) / All 3 checks passed. EXIT=0` forever.
#
# Fix round 2, Important 5: this used to be `SUM("targetCount")` over the
# 15-minute window, which a SINGLE non-zero sweep anywhere in that window
# satisfies -- so a board that has genuinely stopped sweeping anything for
# the last two consecutive cycles (a regression that started 10 minutes ago,
# say) still reads `PASS` off the memory of one healthy sweep 14 minutes ago,
# and the INFO branch below then misdirects to egress. Reading the LATEST
# sweep's OWN `targetCount` (not an aggregate over several) answers "is
# discovery working RIGHT NOW", which is what this check claims to verify.
LATEST_TARGET_COUNT="$(docker compose exec -T "$DB_SERVICE" \
  psql -U "$DB_USER" -d "$DB_NAME" -tAc \
  "SELECT \"targetCount\" FROM \"ExternalProbeRun\" WHERE \"ranAt\" > now() - interval '15 minutes' ORDER BY \"ranAt\" DESC LIMIT 1" \
  2>/dev/null | tr -d '[:space:]')"

# Fix round 2, Important 4: THE PATHOLOGY THAT SANK THE PREVIOUS THREE
# SCRIPTS, ARRIVING FROM THE OTHER DIRECTION. A `targetCount` check with no
# further qualifier fails on the FIRST RUN of a genuinely healthy deploy:
# schema present, board answering, scheduler alive, but no agent has
# reported yet (`deploy/README.md` runs this script immediately after
# `compose up`, with the agent rollout a SEPARATE step) -- `FAIL ... (found:
# 0 target(s))`, exit 1, on a deployment that is not broken. Worse, the
# header comment's usual "wait five minutes and re-run" advice never helps
# here, because `startExternalProbeScheduler` ticks IMMEDIATELY: the
# run-count check above passes in seconds while this one fails until an
# agent actually reports, however long that takes.
#
# The discriminator was already sitting in the database, unread: has ANY
# system EVER reported hostnames, at any point in this deployment's whole
# history (not just the 15-minute window)? If none has, hostname discovery
# has never had a chance to prove itself one way or the other -- this is a
# fresh deploy (or one where agents simply are not rolled out yet), and a
# zero target count is the EXPECTED state, not a fault: say so and pass. If
# some system HAS reported hostnames before, discovery has already proven
# it CAN work, so a zero count now (on top of a recent, live sweep) is a
# genuine regression: fail.
EVER_REPORTED_HOSTNAMES="$(docker compose exec -T "$DB_SERVICE" \
  psql -U "$DB_USER" -d "$DB_NAME" -tAc \
  'SELECT EXISTS (SELECT 1 FROM "SystemObservation" WHERE "hostnames" IS NOT NULL)' \
  2>/dev/null | tr -d '[:space:]')"

check "the most recent sweep attempted to probe something, once any system has ever reported hostnames (latest targetCount: ${LATEST_TARGET_COUNT:-<none this window>}; any system ever reported hostnames: ${EVER_REPORTED_HOSTNAMES:-<unreadable>})" \
  '[ "$EVER_REPORTED_HOSTNAMES" = "f" ] || [ -z "$LATEST_TARGET_COUNT" ] || [ "$LATEST_TARGET_COUNT" -gt 0 ]'

RESULT_COUNT="$(docker compose exec -T "$DB_SERVICE" \
  psql -U "$DB_USER" -d "$DB_NAME" -tAc \
  'SELECT count(*) FROM "ExternalProbeResult"' \
  2>/dev/null | tr -d '[:space:]')"
if [ "$EVER_REPORTED_HOSTNAMES" = "f" ]; then
  # Fix round 2, Important 4's branch: no system has EVER reported
  # hostnames, so this is (most likely) a fresh deploy still waiting on its
  # first agent, not a broken one -- do not blame egress OR discovery for a
  # capability that has simply never been exercised yet.
  echo "INFO  ExternalProbeResult currently holds ${RESULT_COUNT:-<unreadable>} row(s) -- no system in this"
  echo "      deployment's whole history has ever reported hostnames yet, so this looks like a fresh deploy"
  echo "      (or agents simply not rolled out yet), not a fault. Re-run this script once at least one agent"
  echo "      has connected and reported."
elif [ -n "$LATEST_TARGET_COUNT" ] && [ "$LATEST_TARGET_COUNT" -eq 0 ]; then
  # Branched on the latest targetCount = 0, with at least one system having
  # proven hostname discovery CAN work at some point (final whole-branch
  # review, I2): the OLD, single-branch version of this INFO text always
  # blamed "this host's own egress" for a zero `ExternalProbeResult` count --
  # which is actively WRONG here, because zero targets means no outbound
  # request was ever attempted at all. There is no egress to have failed;
  # the fault is upstream, in hostname discovery/config, not in
  # reachability.
  echo "INFO  ExternalProbeResult currently holds ${RESULT_COUNT:-<unreadable>} row(s) -- and the check just"
  echo "      above already failed for the same reason: the most recent sweep found ZERO targets to probe,"
  echo "      even though this deployment HAS reported real hostnames before. Do NOT look at this host's"
  echo "      egress -- nothing left it. Check hostname discovery instead: is the reverse-proxy config"
  echo "      directory reachable, and does every enrolled system's latest observation genuinely carry"
  echo "      hostnames: null or []?"
else
  echo "INFO  ExternalProbeResult currently holds ${RESULT_COUNT:-<unreadable>} row(s) -- not asserted on: a"
  echo "      persistent fleet-wide network fault correctly leaves this at 0 forever (Task 7a's guard), so a"
  echo "      hard PASS/FAIL here would contradict that design rather than verify it. Zero here alongside a"
  echo "      non-zero sweep count and a non-zero target count above means every recent sweep DID attempt to"
  echo "      probe real hostnames and reached nothing -- check this HOST's own egress, not the monitored"
  echo "      fleet's."
fi

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
