#!/usr/bin/env bash
#
# Vault deployment verification. Run ON THE DASHBOARD HOST.
#
# This script exists to fail. Before it was rewritten it could not: the
# original counted nothing and ended in `exit $fail` with `fail` still 0, so
# every check could print FAIL and the script would still report success.
# A verification that cannot fail is worse than no verification, because it
# is mistaken for one. The counter below is the whole point — do not remove
# it, and do not add a check that cannot distinguish a working deployment
# from a broken one.
#
# Scope: this covers what is checkable from the host. It deliberately does
# NOT claim to prove the vault is unreachable from the internet — see the
# note under EXTERNAL REACHABILITY at the bottom.

set -uo pipefail

BASE="${BASE:-http://127.0.0.1:3000}"
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

echo "Verifying vault deployment at ${BASE}"
echo

# --- SCHEMA FIRST, and first for a reason. ---
#
# A deploy that landed new code on an old schema is indistinguishable, from
# the outside, from a dead application: /vault selects a column that does not
# exist, the route is force-dynamic, there is no error.tsx, so every request
# 500s. This script used to report "vault page did not answer" and send the
# operator to the application logs while the actual fault was one unapplied
# migration. That is exactly the mode this file's header warns about — a check
# that looks authoritative while measuring the wrong thing.
#
# So the schema is probed directly, BEFORE anything HTTP, and names itself.
# `information_schema.columns` is the authority here rather than Prisma's
# `_prisma_migrations` table: the question is whether the running database
# actually has the column the running code selects, not whether a migration
# row was written.
#
# The check FAILS when the probe cannot run at all (no docker, wrong
# directory, database down). A schema check that passes because it could not
# look is the empty-input failure this script already learned once, below.
DB_SERVICE="${DB_SERVICE:-db}"
DB_USER="${DB_USER:-bevops}"
DB_NAME="${DB_NAME:-bevops}"
ACK_COLUMN="$(docker compose exec -T "$DB_SERVICE" \
  psql -U "$DB_USER" -d "$DB_NAME" -tAc \
  "SELECT column_name FROM information_schema.columns WHERE table_name = 'VaultConfig' AND column_name = 'recoveryKeyAcknowledgedAt'" \
  2>/dev/null | tr -d '[:space:]')"

check "database schema is current (VaultConfig.recoveryKeyAcknowledgedAt exists)" \
  '[ "$ACK_COLUMN" = "recoveryKeyAcknowledgedAt" ]'

if [ "$ACK_COLUMN" != "recoveryKeyAcknowledgedAt" ]; then
  cat <<'SCHEMA'
      ^ If this failed, do NOT debug the application. Either the migration
        was never applied, or it was applied from an image that predates it
        (`docker compose run` pulls only when the tag is MISSING, so a cached
        `latest` silently migrates nothing). Pull first, then migrate:

          docker compose pull web ingest
          docker compose run --rm web /deploy/with-database-url.sh \
            npx prisma migrate deploy --schema web/prisma/schema.prisma

SCHEMA
fi

check "vault page answers on loopback" \
  '[ "$(curl -s -o /dev/null -w %{http_code} "$BASE/vault")" = 200 ]'

# Fetch the page ONCE, and record whether the fetch worked.
#
# The content checks below must never be evaluated against an empty body.
# The first draft of this script got that wrong in a way worth remembering:
# `! curl -s "$BASE/vault" | grep -q secretSealed` PASSES when the server is
# down, because curl emits nothing, grep matches nothing, and the negation
# turns "I could not look" into "I looked and it was clean". Verified: run
# against a dead port, that check reported PASS while everything around it
# failed. A negative assertion over an empty input is not evidence.
PAGE="$(curl -s --fail "$BASE/vault" 2>/dev/null)" && FETCHED=1 || FETCHED=0

check "vault page body could be fetched for inspection" \
  '[ "$FETCHED" = 1 ] && [ -n "$PAGE" ]'

# Greps the rendered HTML for the sealed-envelope format (v1:<b64>:<b64>:<b64>)
# and for the column name itself. A locked vault must not ship either, and
# neither must an unlocked one — a sealed secret is still a secret.
#
# The character class is STANDARD base64, not base64url. The first version of
# this line used `[A-Za-z0-9_-]`, which cannot match anything envelope.ts
# produces: it emits `toString('base64')`, so `+` and `/` appear in the IV and
# ciphertext, and the 16-byte auth tag always base64-encodes with trailing
# `=`. Measured against 2000 real seal() outputs, the base64url class matched
# 0 and this one matched 2000. Half of this check was dead while the script
# reported PASS — in a script whose own header warns against checks that
# cannot fail. If you touch this pattern, re-measure it against real output.
check "no sealed secret in the page source" \
  '[ "$FETCHED" = 1 ] && ! printf %s "$PAGE" | grep -qE "secretSealed|v1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:"'

# The page has three legitimate states and this check has to know which one
# it is looking at. An earlier version asserted "Locked" unconditionally and
# FAILED on the very first deploy — correctly reporting a problem that did
# not exist, because a vault that has never been created cannot be locked.
# It renders its setup call to action instead. A check that cannot pass in
# the state a fresh deployment is actually in is a false alarm, and a false
# alarm on the one run an operator pays closest attention to is worse than
# no check: it teaches them to discount the script.
#
# So: an uninitialised vault must offer setup, and an initialised one must
# render Locked. Either is a pass; neither is.
#
# CASE SENSITIVITY IS LOAD-BEARING below: "Locked" is a substring of
# "Unlocked", so the second arm only discriminates because of the capital L.
# A well-meaning `grep -qi` would make it match an unlocked page and quietly
# turn the check vacuous.
if printf %s "$PAGE" | grep -qi "set up the vault"; then
  VAULT_STATE="uninitialised"
else
  VAULT_STATE="initialised"
fi

check "the vault page renders a coherent state (found: ${VAULT_STATE})" \
  '[ "$FETCHED" = 1 ] && { [ "$VAULT_STATE" = uninitialised ] || printf %s "$PAGE" | grep -q "Locked"; }'

# Holds in BOTH states: an uninitialised vault has nothing to unlock, and a
# freshly started process always starts locked. This is the arm that would
# catch a vault claiming to be open to anyone who loads the page.
check "the vault does NOT present itself as unlocked" \
  '[ "$FETCHED" = 1 ] && ! printf %s "$PAGE" | grep -q "Unlocked"'

# The dashboard itself must still work — a vault that breaks the board it
# lives on is not a successful deployment.
check "fleet board still answers" \
  '[ "$(curl -s -o /dev/null -w %{http_code} "$BASE/")" = 200 ]'

echo
if [ "$failures" -eq 0 ]; then
  printf 'All %d checks passed.\n' "$checks"
else
  printf '%d of %d checks FAILED.\n' "$failures" "$checks"
fi

cat <<'NOTE'

EXTERNAL REACHABILITY IS NOT CHECKED HERE, ON PURPOSE.
The earlier version of this script tried to prove the page was not publicly
reachable by curling the host's own public address from the host itself.
That test is unsound in both directions: many hosts hairpin a connection to
their own public address straight back to the local interface, so the check
can report "reachable" on a correctly firewalled box, or "unreachable"
because an egress rule blocked the probe rather than because an ingress
rule blocked the world. Either way it measures the wrong thing while
looking authoritative.

Reachability from the internet can only be tested FROM the internet. Run
this from a machine outside the host, and expect a timeout:

  curl -s -m 5 -o /dev/null -w '%{http_code}\n' http://<host public address>:3000/vault

NOTE

exit $((failures > 0))
