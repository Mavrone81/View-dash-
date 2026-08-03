# Design — Slice 2a: a green row tells the truth

**Date:** 2026-08-03
**Status:** Approved in brainstorming — pending implementation plan
**Depends on:** slice 1 (live), the credential vault (live). Independent of the authentication slice.

> **Repo hygiene binds.** This repository is public. No addresses, hostnames, domains or monitored-system names in code, tests, fixtures or docs — including this one. Every finding below is recorded as a shape and a count, never a name. A CI gate enforces it.

## 1 · Problem

A green row on the fleet board today means **"the containers are up"**. It does not mean the application answers, and nothing on the page says so. Slice 1 shipped the HTTP probe but nothing supplies system URLs, so the probe has never run. The board has been reporting a weaker fact than it appears to report, which is the failure this project keeps finding in other forms: a check that reports success without checking.

Certificate expiry and the ability to tell "the app is broken" from "the route to it is broken" are absent for the same reason — nothing knows where a system lives.

## 2 · Goals

A row is green only when the application answers. When it does not, the board says **where** the fault is. Certificate expiry is visible before it becomes an outage.

**Non-goals, deliberately:**
- Alerting, paging or notification. The board is read, not pushed. Adding a notifier before the signal is trusted would train the operator to ignore it.
- Uptime history or availability percentages. That is a different product; this slice answers "is it working now, and where is it broken".
- Probing anything not on the monitored host. Multi-host support is what the external probe makes possible later, not something built now.

## 3 · Two probes, because one cannot locate a fault

The operator's decision, and it is the core of this design: run **both** an on-box probe and an external one, and never merge them into a single boolean.

| On-box | External | Meaning |
|---|---|---|
| answers | answers | Healthy, end to end |
| answers | fails | **The application is fine; DNS, routing, firewall or certificate is broken** |
| fails | fails | The application is down |
| fails | answers | Contradiction — a cache or CDN is serving what the origin cannot. Flagged, never guessed |

The second row is the reason for the design. Neither probe alone can produce it, and it is the row that converts "something is wrong" into "here is where". The fourth row is rare and is reported as a contradiction rather than resolved by picking a winner.

The on-box probe also survives the case the external one cannot diagnose: when public DNS or the route is broken, it still reports that the application itself is healthy. The external probe earns its keep permanently the moment any system moves to another host.

### 3.1 What "on-box" has to mean, corrected during implementation

The on-box probe requests **`http://127.0.0.1:<published container port>/` with an explicit `Host` header** naming the vhost. It does not resolve the hostname, does not use TLS, and does not pass through the reverse proxy.

This corrects the original design, which said the probe would reach each hostname "through loopback" but was implemented as an ordinary `https://<hostname>/` request. That version resolved through public DNS and traversed exactly the path a real visitor takes. Two things followed, and the second is fatal to the design rather than merely wrong:

- One egress rule, resolver hiccup or CDN error would turn **every row on the board red at once** while every application was fine.
- **Both probes measured the same path, so they could never disagree** — and their disagreement is the only thing the two-probe design buys. The table above would have been decorative.

Addressing the container port directly also removes a second fault: the scheme no longer has to be guessed. The earlier version hardcoded `https://`, so a vhost serving plain HTTP — a stack deployed before its certificate exists, precisely the "probed the day it deploys" case §4 promises — collected a certificate mismatch from whichever server block owns 443 and rendered red while working perfectly.

The `Host` header is required, not cosmetic: an application behind a name-based vhost may redirect or refuse a request that arrives without the name it expects.

**And it cannot be sent with `fetch`.** `Host` is a forbidden header name in the WHATWG fetch specification, and Node's global `fetch` (undici) silently discards it — no error, no warning. Measured on Node 22:

```
global fetch      -> server saw  host: 127.0.0.1:<port>      (a non-forbidden header passed fine)
node:http.request -> server saw  host: alpha.example.invalid
```

So the on-box probe uses `node:http.request`. This is recorded in the spec rather than left as a code comment because the failure is invisible from the calling side: the request succeeds, the header is simply not there, and an application doing host-based routing answers as its default tenant. A green row would then say nothing about the hostname it claims to describe.

The first implementation shipped tests that injected a fake `fetch` and asserted on the headers *argument*. They passed. They pinned what was handed to the transport, never what reached the wire — so **any test for this property must exercise the real transport against a real listener** and assert on the received request. That requirement is part of the design, not an implementation detail.

**Only probe a port that something vouches for.** A hostname-mapped port is safe by construction: it appears in the map only because a vhost proxies to it, so the reverse proxy is itself the evidence that the port is loopback-bound and speaks HTTP. A published port with no vhost carries no such evidence — it may be a database, a cache, a mail relay, a UDP service, or bound to a non-loopback address. Probing one is still worthwhile, because it catches a stack deployed before its vhost exists, but it is **evidence that can only be positive**: an answer counts, and a failure is `not-probed`, never `not-answering`. We never had grounds to expect an HTTP answer from it, so its silence proves nothing and must not redden a healthy row.

One consequence worth stating plainly, because it changes what the second row of the table means: the on-box axis no longer exercises the reverse proxy at all. That makes the diagnosis **sharper**, not weaker. "App port answers, external fails" now isolates the fault to everything between the application and the visitor — the proxy, its configuration, TLS, DNS, the firewall — which is what that row was always trying to say.

## 4 · Discovery, not a maintained list

The agent derives each system's hostnames by parsing the host's reverse-proxy configuration:

`server_name` → `proxy_pass` to a loopback port → published container port → compose project.

Measured against the live host: 28 vhost files, 42 distinct hostnames, 20 compose projects. 27 of 28 proxy targets resolve to a running container, and **19 of 20 systems** acquire at least one hostname this way. The twentieth has no vhost and legitimately has no HTTP surface.

This matters more than convenience. A hand-maintained URL list is why the slice-1 probe never ran, and it would break the property that makes this board worth keeping: a new stack appears, correctly, without anyone editing configuration. That property is the operator's stated requirement — "robust and expendable" — and a list defeats it.

**Implementation trap, recorded because it cost two wrong answers during the survey:** `grep -r` does not follow symlinks, and the enabled-vhost directory is entirely symlinks. Both early attempts returned zero hostnames and looked authoritative. Use `-R`, and assert in a test that the parser finds vhosts through a symlink.

## 5 · What a probe result means

Measured across every hostname on the host, one request each: 23 returned 200, 9 returned 301, 4 returned 307, 2 returned 302, 1 returned 404, and 3 returned nothing.

A naive "200 is healthy" rule would therefore mark **19 of 42 as unhealthy while they were working correctly**. A redirect to HTTPS or to a login page is an application doing its job. Shipping that rule would produce a column of false alarms, and a false alarm teaches the operator to stop reading the column — the same way a check that cannot fail teaches them to trust one that proves nothing.

The opposite error is equally available. **502, 503 and 504 come from the proxy, not the application** — they are precisely what is served when the proxy is healthy and the container behind it is not. That is the exact fault this slice exists to catch, so "any HTTP response counts as answering" would score the target failure as a success.

The rule:

| Result | State |
|---|---|
| 2xx, 3xx, 401, 403 | **Answering.** A login wall or redirect is a working application |
| other 4xx | **Answering oddly**, with the code shown. A 404 at the root is normal for an API and abnormal for a site; the board shows the fact rather than pretending to know which |
| 5xx | **Not answering.** 502/504 labelled distinctly as *proxy up, application not responding behind it* |
| no response | **Not answering** |
| TLS handshake fails | **TLS fails** — a separate state, not "app down" |

Redirects are not followed: one request per hostname, and no chasing a redirect off the host.

Row health is **worst-of** container state and both probes, as slice 1's spec already requires. Green needs all of them.

### 5.1 Cadence, because the two probes cost differently

The on-box probe runs on the agent's existing cycle. It is a loopback request that leaves no machine, so it is cheap.

The external probe runs **every 5 minutes**, not every cycle. It is real internet traffic against real applications, three of which belong to another business, and a certificate does not change between two 30-second ticks. The board shows the age of the last external result, so a stale one is never mistaken for a fresh one — an old result presented as current is the same lie this slice exists to remove.

### 5.2 Which hostname is "primary"

A system may carry several hostnames and the row must name one deterministically, or the board's most prominent column changes between refreshes for no reason.

Primary is chosen by, in order: the hostname that answers; then the shortest; then alphabetical. The rule is arbitrary but total — it always yields the same answer for the same input, which is the property that matters. Ties are impossible by construction because the final tiebreak is a total order.

## 6 · Certificates, from the handshake

Expiry comes from the external probe's own TLS handshake, not from reading certificate files on disk.

Files tell you what *should* be served. The handshake tells you what *is*. They differ exactly when it matters: a renewed certificate that the proxy never reloaded is an outage that a file-reading check reports as healthy. This estate has already had one — a correct configuration on disk with a proxy that had not been reloaded.

Thresholds: amber under 21 days, red under 7. Measured today, all 27 certificates on the host have 40 or more days remaining, so this ships as early warning rather than as a fire.

## 7 · Findings the survey already produced

Recorded because they are what the feature is for, and because they demonstrate the states above are not hypothetical:

- **Three hostnames are configured for TLS with no certificate.** The handshake fails, so nothing behind them is reachable. All three are `TLS fails`, not `app down` — a board that conflated the two would send the operator to the wrong place.
- **One vhost declares a misspelled hostname** that does not resolve in DNS, while its correctly-spelled sibling does and works. Dead today; a live outage the day anything relies on it.

Neither was visible before this survey. Both will be visible on the board permanently once this ships.

## 8 · Interface

Every capability in this slice is reachable from the interface. Nothing ships that can only be exercised by calling a function — the credential vault shipped three complete, tested backends with no way in, and the per-task reviews could not see it because each task satisfied its own brief. **Each capability here carries a test asserting it is reachable from the UI.**

The board gains:
- **URL** — the system's primary hostname, linked. A system with no vhost reads *no HTTP surface*, never a bare dash.
- **Answers** — the two-axis state from §3, and where they disagree, which side failed. The wording names the fault, not a colour.
- **Cert** — days remaining, amber under 21, red under 7. *No certificate* where TLS is configured without one.

A system may have several hostnames; the row shows the primary and reveals the rest on expansion, each with its own result. One failing hostname on a multi-hostname system must not be averaged away into a green row.

## 9 · Failure modes designed in

- **A fleet-wide external failure is a probe fault, not twenty outages.** If every external probe fails in one cycle, the board says the dashboard could not reach anything and shows the on-box results, which are still trustworthy. Turning the whole board red on a local network blip is how an operator learns to disbelieve it.
- **A probe that could not run is never a pass.** An unreachable target, a timeout, a parse failure — each is its own state. No negative assertion is evaluated over an empty response, which is the defect already found twice in this project's own verification script.
- **A slow probe cannot stall the cycle.** Per-probe timeout, and a system whose probe times out reports as timed out rather than delaying every other system's result.
- **Probe traffic is identifiable.** A distinct user-agent, so the requests are recognisable in the logs of the applications being probed. Three of the twenty stacks belong to another business; the operator has accepted probing them, and their operator should be able to see what the traffic is.

## 10 · Testing

Unit tests for the vhost parser (including through a symlink), the status-classification rule with every band in §5 represented, the two-axis combination table in §3 including the contradiction row, and the certificate thresholds.

Integration tests against a real database for observation storage and worst-of health.

Every rule gets a test asserting the **denial**, and each denial test must be verified to fail without its fix rather than reasoned about. Specifically: a 502 is never green; a 301 is never red; a fleet-wide external failure never turns rows red; a system with no vhost never renders a dash; a certificate under 7 days is never amber; a failing hostname on a multi-hostname system is never averaged into green; and every new capability is reachable from the UI.

Seventeen non-discriminating tests have been found across this project's two slices. Assume more will be written here.

## 11 · Out of scope, recorded so it is not rediscovered

Alerting. Uptime history. Probing hosts other than the monitored one. Automatic remediation of anything the board reports — the two findings in §7 are for the operator to fix, and a dashboard that edits a nine-business production host is a different risk decision entirely.
