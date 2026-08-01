# Bevora Ops -- deployment runbook

This covers two machines, and they are not the same one:

- **The dashboard host** -- runs `docker-compose.yml` at the repo root
  (`db`, `web`, `ingest`) and this host's own reverse proxy
  (`deploy/nginx-ingest.conf`).
- **Each monitored host** -- one of the systems you want on the fleet
  board. It runs nothing from this repo except `deploy/agent.service` and
  one bundled file (`agent-bundle.cjs`); it has no monorepo, no
  `node_modules`, and no TypeScript.

No hostnames, IP addresses, or domains appear anywhere below, including
this file: every value that would identify a real machine is a placeholder
in angle brackets, and the real value comes from this deployment's own
inventory/DNS/secrets, never from this repo. (The CI leak gate enforces
this for the repo's own files; treat it as the same rule for anything you
type into a runbook, ticket, or chat while following these steps.)

## 1. Prerequisites on the dashboard host

- Docker and the Docker Compose plugin installed.
- A container image for this app published somewhere `docker compose` can
  pull it from, referenced by `docker-compose.yml` as
  `ghcr.io/${GHCR_OWNER}/bevora-ops:${TAG:-latest}`. **Building and
  publishing that image is not part of this task** -- there is no
  `Dockerfile` in this repo yet. Before the first real deploy, someone
  needs to: write one that builds this monorepo's `web` workspace
  (producing whatever `next start` needs) AND runs
  `npm run build:ingest` / `npm run build:enrol` as part of the image
  build, so `web/dist/ingest-server.mjs` and `web/dist/enrol-cli.mjs`
  exist inside it; then decide where it gets published, and set
  `GHCR_OWNER` (and optionally `TAG`) accordingly. Until then, treat
  `docker-compose.yml`'s `web`/`ingest` service definitions as reviewed
  and ready, not yet runnable.
- This host's own reverse proxy (nginx or equivalent) already installed
  and serving other TLS vhosts, so `deploy/nginx-ingest.conf` can be added
  as one more site.

## 2. Generate secrets (dashboard host)

From the repo root, on the dashboard host:

```bash
mkdir -p secrets
openssl rand -base64 32 > secrets/postgres_password
openssl rand -base64 32 > secrets/kek
chmod 600 secrets/postgres_password secrets/kek
```

Neither file is ever committed (`secrets/` is git-ignored) or referenced
by an env var anywhere in `docker-compose.yml` -- Postgres reads its
password via `POSTGRES_PASSWORD_FILE`, and `deploy/with-database-url.sh`
builds `DATABASE_URL` from the same file at container start. See that
script's own comment for the full mechanism if you need to change it.
`secrets/kek` is not yet consumed by any running code in this slice
(envelope encryption, `web/src/lib/crypto/envelope.ts`, is wired up to
read it in a later slice) -- it is generated now so the file-mounted
convention is already in place when that lands.

## 3. Bring up the dashboard stack

```bash
GHCR_OWNER=<your-org> TAG=<image-tag> docker compose up -d
```

`web` and `ingest` will not start (and `depends_on: db: condition:
service_healthy` will hold them back) until Postgres reports healthy.

Confirm the four dashboard-side checks pass:

```bash
bash deploy/verify.sh
```

(The fifth check, `agent unit is active`, is checked separately in the
next section -- it runs on a monitored host, not necessarily this one.)

## 4. Reach the UI (loopback only, on purpose)

`web` is bound to `127.0.0.1:3000` on the dashboard host and nowhere else
-- authentication does not ship until a later slice, so this UI must never
be reachable from the internet. From your own machine:

```bash
ssh -L 3000:127.0.0.1:3000 <dashboard-host>
```

then open `http://127.0.0.1:3000` in a browser on YOUR machine. Nothing
about this changes when the fleet grows -- the tunnel is the access
control until slice 3 ships real authentication.

## 5. Install the reverse proxy vhost (dashboard host)

Copy `deploy/nginx-ingest.conf` into this host's reverse proxy config
(e.g. its sites-available directory), replace the placeholder
`dashboard.example.invalid` with this deployment's real hostname, point
`ssl_certificate`/`ssl_certificate_key` at that host's real certificate,
then reload the proxy. Read that file's own header comment before
touching it -- it deliberately has no location block for the UI, and
should stay that way.

## 6. Enrol a monitored host and mint its token

Run this on the dashboard host, where `DATABASE_URL` is already
constructed by the running `web` container's entrypoint:

```bash
docker compose exec web /deploy/with-database-url.sh \
  node web/dist/enrol-cli.mjs <host-name>
```

(`<host-name>` is whatever you want this system to be called on the fleet
board -- it does not need to match any DNS name.) This prints the new
host's id and, on its own final line, a **token shown exactly once**.
Copy it now. There is no "show it again" command: only the token's SHA-256
hash is ever stored (see `web/src/server/auth-agent.ts`), by design --
losing this output means re-running the command above, which mints a new
token and revokes the old one in the same transaction. That is a feature,
not a workaround: re-enrolment is how a token gets rotated at all.

Running the same command again with a host name that is already enrolled
revokes that host's current token and mints a new one -- use this to
rotate a credential you suspect is compromised, then repeat step 7 on that
host with the new token.

## 7. Install the token on the monitored host

On the monitored host (not the dashboard host):

```bash
sudo mkdir -p /etc/bevora-agent
sudo tee /etc/bevora-agent/token > /dev/null   # paste the token, then Ctrl-D
sudo chmod 600 /etc/bevora-agent/token
sudo chown root:root /etc/bevora-agent/token
```

The token file's permissions matter as much as the token itself: anything
that can read it can impersonate this host to the dashboard.

## 8. Build and copy the agent (no monorepo on the target)

From the repo root, on any machine with this repo checked out (does not
need to be the monitored host):

```bash
npm run build:agent
```

This produces **one file**, `agent/dist/agent-bundle.cjs` -- a
self-contained bundle (esbuild, see `scripts/build/bundle-agent.mjs` for
exactly what is and is not inlined) with every dependency, including the
`@bevora-ops/shared` workspace package, built in. The monitored host needs
none of this repo, no `npm install`, and no TypeScript -- only this one
file and a plain `node` binary:

```bash
scp agent/dist/agent-bundle.cjs <monitored-host>:/tmp/
ssh <monitored-host> 'sudo mkdir -p /opt/bevora-agent && sudo mv /tmp/agent-bundle.cjs /opt/bevora-agent/'
```

## 9. Configure and start the agent (monitored host)

Create `/etc/bevora-agent/agent.env` (see `agent/src/config.ts` for the
authoritative list -- every one of these is required except
`AGENT_INTERVAL_MS`):

```ini
AGENT_HOST_NAME=<same host-name you used in step 6>
AGENT_DASHBOARD_URL=wss://<dashboard-hostname>/agent/ingest
AGENT_TOKEN_FILE=/etc/bevora-agent/token
AGENT_DEPLOY_LOG_GLOB=<glob matching this host's deploy-log files>
AGENT_REPO_ROOT=<root directory this host's system checkouts live under>
# AGENT_INTERVAL_MS=30000   # optional; default shown
```

`AGENT_DASHBOARD_URL`'s path (`/agent/ingest` above) must match whatever
`location` you configured in `deploy/nginx-ingest.conf` -- the listener
itself accepts an upgrade on any path, so this is purely a proxy routing
choice.

Then install and start the unit:

```bash
sudo cp deploy/agent.service /etc/systemd/system/bevora-agent.service
sudo systemctl daemon-reload
sudo systemctl enable --now bevora-agent
systemctl status bevora-agent
```

**Decide who runs this before enabling it.** The agent talks to the local
Docker socket to discover this host's systems, and that access is
root-equivalent by design (Docker's own, well-known caveat: anyone who can
talk to the socket can run a container with an arbitrary bind mount,
including the host root filesystem). Running the unit as `root`, or as a
dedicated user added to the `docker` group, are both common choices and
neither one avoids this trade-off -- `deploy/agent.service`'s hardening
directives lock down everything else (filesystem, capabilities, kernel
access, namespaces) precisely because this one avenue cannot be sandboxed
away. This is a decision for whoever owns the monitored host, not
something this file should make silently.

Confirm it:

```bash
bash deploy/verify.sh   # the "agent unit is active" line, run on this host
```

Then, on the dashboard host, open the tunnel from step 4 and confirm this
host's row appears on the fleet board.

## 10. Prove the staleness rule (recommended before calling a host "live")

```bash
sudo systemctl stop bevora-agent
# wait 2 minutes, then reload the fleet board
sudo systemctl start bevora-agent
# reload again -- the row should recover
```

Every row for a host whose agent has stopped reporting must read `stale`,
never `healthy` -- this is the property Task 11 exists to guarantee, and
the one most worth re-proving live rather than trusting from tests alone.

## Reference: agent environment variables

| Variable | Meaning |
|---|---|
| `AGENT_HOST_NAME` | This host's display name on the fleet board (must match the name used at enrolment). |
| `AGENT_DASHBOARD_URL` | `wss://` URL of the dashboard's ingest listener, including the proxy path you configured. |
| `AGENT_TOKEN_FILE` | Path to the file-mounted bearer token from step 7. Never set the token itself as an env var. |
| `AGENT_DEPLOY_LOG_GLOB` | Glob the agent reads per-system deploy logs from. |
| `AGENT_REPO_ROOT` | Root directory this host's system checkouts live under. |
| `AGENT_INTERVAL_MS` | Optional. Poll interval in milliseconds (default `30000`). |
