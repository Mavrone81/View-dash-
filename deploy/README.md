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
- A container image for this app, published to GHCR. `.github/workflows/ci.yml`'s
  `publish` job builds `deploy/Dockerfile` and pushes it automatically on
  every push to `main`, tagged with the commit sha (and `latest`) --
  `docker-compose.yml`'s `image: ghcr.io/${GHCR_OWNER}/bevora-ops:${TAG:-latest}`
  is exactly that tag. Set `GHCR_OWNER` to this repository's (lowercased)
  `owner/repo` path and, if you want a specific commit rather than
  whatever `main` last published, `TAG` to that commit's sha. You can also
  build it yourself, from the repo root, without pushing anywhere:
  `docker build -f deploy/Dockerfile -t <local-tag> .` -- useful for
  testing a change to the Dockerfile itself before it reaches CI.
- This host's own reverse proxy (nginx or equivalent) already installed
  and serving other TLS vhosts, so `deploy/nginx-ingest.conf` can be added
  as one more site.

Everything from `docker build` through a live fleet board was run
end-to-end, locally, before this file was written: the image builds,
migrations apply, `web` renders real data, and `ingest` answers on its
published port. Two things about `deploy/Dockerfile` and
`docker-compose.yml` are NOT obvious from reading the source and are
worth knowing before you touch either file:

- `next build`'s default bundler (Turbopack, in this Next version) cannot
  resolve this codebase's NodeNext-style relative imports (`from
  './foo.js'` pointing at a sibling `foo.ts`) -- confirmed by actually
  running it. `deploy/Dockerfile` builds with `--webpack` instead, which
  can, via `web/next.config.ts`'s `resolve.extensionAlias` hook. Don't
  drop `--webpack` from that build step without re-verifying this.
- Overriding a Compose service's `entrypoint:` WITHOUT also giving it a
  `command:` does not fall back to the image's own default CMD the way it
  looks like it should -- Docker clears the effective command to empty in
  that case. `docker-compose.yml`'s `web` and `ingest` services both set
  `command:` explicitly for exactly this reason (see that file's comment
  on the `web` service, which documents the exact failure this caused --
  a silent restart loop, exit code 0, no log output -- before it was
  fixed).

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

## 3. Bring up Postgres, then apply migrations, then bring up the rest

```bash
export GHCR_OWNER=<your-org> TAG=<image-tag>
docker compose config >/dev/null   # pre-flight: the file resolves cleanly
docker compose up -d db
```

`docker compose config` is worth running first because it fails fast on
anything wrong with the file itself before any container starts. It needs
no `.env` file: this repo's compose file deliberately has no `env_file:`
directive, because nothing the containers run reads one (`DATABASE_URL` is
built at container start by `deploy/with-database-url.sh`, `NODE_ENV` comes
from the image, and `INGEST_SERVER_HOST` is set inline on the `ingest`
service). Do not add one back.

Wait for it to report healthy (`docker compose ps db`), then run
migrations as their own, separate, one-off command -- **never** as part of
`web` or `ingest`'s startup:

```bash
docker compose run --rm web /deploy/with-database-url.sh \
  npx prisma migrate deploy --schema web/prisma/schema.prisma
```

This has to be a separate step rather than something in
`deploy/with-database-url.sh` itself: that script is the shared
`entrypoint:` for BOTH `web` and `ingest`, which start at the same time --
if it ran `prisma migrate deploy` on every container start, both
services' containers would race to apply the same migration
simultaneously, with no lock coordination between them. Running it once,
by hand (or from a deploy pipeline step that runs before `docker compose
up`), avoids that entirely.

Now bring up the rest:

```bash
docker compose up -d
```

`web` and `ingest` will not start (and `depends_on: db: condition:
service_healthy` will hold them back) until Postgres reports healthy.

Confirm the dashboard-side checks pass:

```bash
bash deploy/verify.sh
```

Two of those checks probe this host's **public** address to confirm `web`
and `ingest` are NOT reachable on it. That address is resolved by
`deploy/detect-public-ip.sh`, which deliberately fails rather than falling
back to a private NIC's address — probing a private address, finding
nothing, and reporting PASS would certify the exact exposure the check
exists to catch. If this host is behind NAT and has no globally-routable
address of its own, set `BEVORA_PUBLIC_IP` to the address the internet
reaches it on and re-run.

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

### Decommissioning a host (revoke without re-enrolling)

To take a host off the fleet permanently -- or to kill a leaked credential
without handing out a working replacement -- revoke it:

```bash
docker compose exec web /deploy/with-database-url.sh \
  node web/dist/enrol-cli.mjs --revoke <host-name>
```

This invalidates every active enrolment for that host and mints nothing.
Use it, not a re-enrolment, when the goal is to REMOVE a machine:
re-enrolling would create a fresh working token for a host you are trying
to retire.

It is scoped to the one host named and never touches any other host's
token. It is safe to re-run (a host whose tokens are already revoked
succeeds silently), but a host name that does not exist FAILS rather than
reporting success -- so a typo cannot leave you believing a live
credential is dead.

Afterwards, that host's agent keeps dialling in and keeps being rejected;
its rows go `stale` and then `unknown` on the board rather than
disappearing. Stop and disable `bevora-agent` on the host itself to finish
the job.

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
AGENT_HOST_NAME=<the host-name you used in step 6>
AGENT_DASHBOARD_URL=wss://<dashboard-hostname>/agent/ingest
AGENT_TOKEN_FILE=/etc/bevora-agent/token
AGENT_DEPLOY_LOG_GLOB=<glob matching this host's deploy-log files>
AGENT_REPO_ROOT=<root directory this host's system checkouts live under>
# AGENT_INTERVAL_MS=30000   # optional; default shown
# AGENT_SYSTEM_URLS=<key>=https://...,<key>=https://...   # optional; see below
# AGENT_PROBE_TIMEOUT_MS=5000                             # optional; default shown
```

**`AGENT_HOST_NAME` does not identify this agent, and cannot.** Identity
comes entirely from the token: the dashboard hashes it, finds the
enrolment, and files everything this agent reports under THAT host, no
matter what this variable says. (An earlier version of this runbook said it
"must match the name used at enrolment", which would have sent someone
debugging a mismatch that cannot exist.) What it is actually for: the agent
states it once when it connects, and the dashboard logs a warning if it
disagrees with the token's host. That catches one host's token being
installed on a different host -- which otherwise silently files this
machine's systems under someone else's row. Set it to the enrolment name so
that check is meaningful; a mismatch is logged, never enforced, so a typo
here cannot take this host off the board.

**`AGENT_SYSTEM_URLS` (optional) turns on the HTTP health probe.** Comma
separated `key=url` pairs, where `key` is the system's compose-project name
as it appears on the board:

```ini
AGENT_SYSTEM_URLS=alpha=https://alpha.example.test/,beta=https://beta.example.test/health
```

Health is then the **worst of** the system's container state and this
probe, which is what stops a stack whose containers all read `Up` from
rendering green while the app returns 502 to every real visitor. A system
with no entry here is simply not probed and is reported exactly as its
containers describe it -- never downgraded for the absence of a URL. Note
that a malformed entry makes the agent refuse to start, deliberately:
silently skipping it would leave a system unprobed while you believed it
was covered. 4xx reads as `degraded` and 5xx (or no answer at all) as
`down`, so point this at a URL that returns 2xx when the app is well.

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
including the host root filesystem). `deploy/agent.service` ships with
`root` as its default (no `User=`/`Group=` set) because that requires no
extra setup -- but the file also contains a commented-out, ready-to-use
alternative (`User=bevora-agent` / `Group=bevora-agent` /
`SupplementaryGroups=docker`, plus the one `useradd` command it needs
first) if you'd rather run it as a dedicated non-root user in the `docker`
group. Read that file's own "Identity" comment before choosing -- it is
honest that this choice buys defense-in-depth against unrelated bugs in
this process, not containment of the Docker-socket access itself, which
is root-equivalent either way.

**Smoke-test the hardening block for real before trusting it.** The
directives in `deploy/agent.service` (`ProtectSystem=strict`,
`ProtectHome=read-only`, the capability/namespace/syscall restrictions)
were reasoned through against this agent's actual code and against
`systemd.exec(5)`'s documented behavior, but could not be measured on a
real systemd host while writing this file (no systemd on the development
machine used). That file's own comment says so. So, the first time you
enable this unit on any given host:

```bash
sudo systemctl start bevora-agent
systemctl status bevora-agent          # should be "active (running)", not failing/restarting
sudo journalctl -u bevora-agent -n 50  # look for permission-denied errors reading
                                        # AGENT_REPO_ROOT, AGENT_DEPLOY_LOG_GLOB, or the
                                        # Docker socket -- ProtectSystem=strict is the
                                        # first thing to suspect if you see one
```

If something the agent legitimately needs to read is denied, add exactly
that one path via `ReadOnlyPaths=` in the unit (an example is commented
in the file) rather than loosening `ProtectSystem`/`ProtectHome`
wholesale or deleting the hardening block outright.

Confirm it:

```bash
bash deploy/verify.sh   # the "agent unit is active" line, run on this host
```

Then, on the dashboard host, open the tunnel from step 4 and confirm this
host's row appears on the fleet board -- a real row with real data is
also, in effect, the rest of the smoke test: it means the agent could
reach Docker, read this host's deploy logs and git checkouts, AND dial
out to the dashboard, all under the hardening block above.

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
| `AGENT_HOST_NAME` | What this host believes it is called. **Advisory only — it does not identify this agent; the token does.** Sent once at connect so the dashboard can log a mismatch with the token's host (see §9). |
| `AGENT_DASHBOARD_URL` | `wss://` URL of the dashboard's ingest listener, including the proxy path you configured. |
| `AGENT_TOKEN_FILE` | Path to the file-mounted bearer token from step 7. Never set the token itself as an env var. |
| `AGENT_DEPLOY_LOG_GLOB` | Glob the agent reads per-system deploy logs from. |
| `AGENT_REPO_ROOT` | Root directory this host's system checkouts live under. |
| `AGENT_INTERVAL_MS` | Optional. Poll interval in milliseconds (default `30000`). |
| `AGENT_SYSTEM_URLS` | Optional. `key=url` pairs, comma separated, enabling the HTTP health probe per system (see §9). Unset ⇒ nothing is probed and nothing is downgraded. |
| `AGENT_PROBE_TIMEOUT_MS` | Optional. Per-probe timeout in milliseconds (default `5000`). |

## Reference: dashboard-side environment variables

Both are optional and both have safe defaults; set them only if you have a
reason to.

| Variable | Meaning |
|---|---|
| `INGEST_SERVER_HOST` | Interface the ingest listener binds. Defaults to loopback; `docker-compose.yml` sets `0.0.0.0` explicitly, and that file's comment explains why that is required under Docker networking and why it is still not internet exposure. |
| `INGEST_SERVER_PORT` | Port for the same listener (default `4100`). |
| `INGEST_MAX_PAYLOAD_BYTES` | Largest accepted WebSocket message (default 1 MiB). `ws`'s own default is 100 MB, which on a 1 GB droplet is an out-of-memory condition anyone can request. |
| `INGEST_MAX_CONNECTIONS` | Simultaneous connection ceiling (default `64`). Connections over the cap are closed *before* authentication, so an unauthenticated peer cannot drive a database round trip per connection. |
| `BEVORA_PUBLIC_IP` | Read by `deploy/verify.sh` only. Set this if the dashboard host is behind NAT and has no globally-routable address on any of its own interfaces — otherwise the exposure checks fail rather than guess. |
