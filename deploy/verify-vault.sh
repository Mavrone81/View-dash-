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
check "no sealed secret in the page source" \
  '[ "$FETCHED" = 1 ] && ! printf %s "$PAGE" | grep -qE "secretSealed|v1:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+:"'

# The word Locked must appear before anyone has unlocked. Note this is a
# weaker statement than it looks: it confirms the page renders its locked
# branch, not that the lock is enforced. Enforcement is proven by the
# restart check in the runbook, which is a human step.
check "a freshly started vault renders as locked" \
  '[ "$FETCHED" = 1 ] && printf %s "$PAGE" | grep -q "Locked"'

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
