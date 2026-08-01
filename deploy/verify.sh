#!/usr/bin/env bash
# deploy/verify.sh -- live probe for the dashboard deployment. Every line
# below is a REAL check that can fail; nothing here is scaffolding. PASS on
# every line is the only acceptable result before this deployment is
# considered live (see .superpowers/sdd/.../task-14-brief.md, Step 4).
#
# Run the first five checks on the DASHBOARD host, from the same directory
# as docker-compose.yml, after `docker compose up -d`. The last check is
# about the AGENT, which normally runs on a separate MONITORED host -- if
# you are bootstrapping by having the dashboard host monitor itself as its
# first system, run this whole script there; otherwise run (or copy) just
# that last line on the monitored host instead.
set -u
fail=0
check() {
  if eval "$2"; then
    echo "PASS  $1"
  else
    echo "FAIL  $1"
    fail=1
  fi
}

check "web answers on loopback" \
  '[ "$(curl -s -o /dev/null -w %{http_code} http://127.0.0.1:3000/)" = 200 ]'

# The two "NOT on the public interface" checks below need this host's real
# PUBLIC address to probe against. If it cannot be determined, the checks
# that depend on it must FAIL loudly, not quietly pass -- a `curl` against
# a malformed URL like `http://:3000/` (what `$public_ip` empty would
# build) fails for a reason that has nothing to do with whether the service
# is actually unreachable, and `! curl ...` would turn that unrelated
# failure into a false "PASS" for a check whose entire job is to catch real
# exposure. This was found and fixed as exactly that bug: an earlier
# version of this script built the URL inline, per check, with no guard on
# an empty lookup -- meaning a broken interface lookup certified a
# public-exposure check as passing instead of failing it.
#
# The lookup itself was ALSO wrong in a quieter way, and that is what
# deploy/detect-public-ip.sh now fixes: `hostname -I | awk '{print $1}'`
# takes whichever address the kernel lists first, which on any host with a
# private NIC, a VPN, or a Docker bridge (i.e. every host in this estate)
# can easily be a PRIVATE address. Probing a private address and finding
# nothing there proves nothing about what the internet can reach -- but it
# makes both exposure checks report PASS. See that script's header for the
# full reasoning and the override for NAT'd hosts; it fails rather than
# guessing, and this script fails with it.
public_ip="$(bash "$(dirname "$0")/detect-public-ip.sh" 2>/dev/null || true)"

check "determined this host's PUBLIC (globally-routable) interface address" \
  '[ -n "$public_ip" ]'

check "web is NOT on the public interface" \
  '[ -n "$public_ip" ] && ! curl -s -m 5 -o /dev/null "http://$public_ip:3000/"'

# `ws` (the WebSocketServer library web/src/server/ingest-server.ts uses)
# answers a plain HTTP GET with 426 Upgrade Required -- that status code is
# the proof the listener is up and speaking the WebSocket protocol, not
# just that *something* is bound to the port.
check "ingest answers on loopback" \
  '[ "$(curl -s -o /dev/null -w %{http_code} http://127.0.0.1:4100/)" = 426 ]'

check "ingest is NOT on the public interface" \
  '[ -n "$public_ip" ] && ! curl -s -m 5 -o /dev/null "http://$public_ip:4100/"'

check "postgres publishes no host port" \
  '[ -z "$(ss -lnt | grep -E ":5432\b")" ]'

check "agent unit is active" \
  'systemctl is-active --quiet bevora-agent'

exit $fail
