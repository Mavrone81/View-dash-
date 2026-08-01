#!/usr/bin/env bash
# deploy/verify.sh -- live probe for the dashboard deployment. Every line
# below is a REAL check that can fail; nothing here is scaffolding. PASS on
# every line is the only acceptable result before this deployment is
# considered live (see .superpowers/sdd/.../task-14-brief.md, Step 4).
#
# Run the first four checks on the DASHBOARD host, from the same directory
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

check "web is NOT on the public interface" \
  '! curl -s -m 5 -o /dev/null "http://$(hostname -I | awk "{print \$1}"):3000/"'

# `ws` (the WebSocketServer library web/src/server/ingest-server.ts uses)
# answers a plain HTTP GET with 426 Upgrade Required -- that status code is
# the proof the listener is up and speaking the WebSocket protocol, not
# just that *something* is bound to the port.
check "ingest answers on loopback" \
  '[ "$(curl -s -o /dev/null -w %{http_code} http://127.0.0.1:4100/)" = 426 ]'

check "ingest is NOT on the public interface" \
  '! curl -s -m 5 -o /dev/null "http://$(hostname -I | awk "{print \$1}"):4100/"'

check "postgres publishes no host port" \
  '[ -z "$(ss -lnt | grep -E ":5432\b")" ]'

check "agent unit is active" \
  'systemctl is-active --quiet bevora-agent'

exit $fail
