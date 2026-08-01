# Design — Bevora Ops

**Date:** 2026-08-01
**Status:** Approved in brainstorming — pending implementation plan

> **Repo hygiene (binding constraint).** This repository is **public** (or will be). It must contain **no IP addresses, no hostnames or domains, and no names of the systems it monitors** — those belong to several different businesses and are not ours to disclose. Every environment-specific value is configuration supplied at runtime, never a literal in code, tests, fixtures or docs. §10 makes this a CI gate rather than a good intention. Real inventory lives in the operator's private notes and in the deployed database.
>
> **The constraint holds from commit #1, not from the day the repo flips public.** Git history is permanent: an address committed while private is still readable after the repo opens, and the only remedy is rewriting history on a repo others may already have cloned. "Sanitise it later" is not available.

## 1 · Problem

The primary application host runs **19 compose stacks / 65 containers / 26 public vhosts**, belonging to **nine distinct businesses**. Verified survey, 2026-08-01:

| Fact | Value |
|---|---|
| Compose stacks | 19 (largest: 20 containers) |
| Containers | 65, all running at survey time |
| Public vhosts | 26, all TLS, expiries 42–89 days |
| Pull-deploy crons | **18, each firing every minute** |
| Backup jobs | **2** |
| Monitoring / alerting | **None** — no uptime, metrics, log or container tooling of any kind |

Three gaps follow. **17 of 19 stacks have no backup.** There is **no alerting whatsoever** under nine businesses' production. And 18 per-minute deployers can each fail silently — the failure that produced a **four-hour undetected outage on this estate on 2026-07-29**, because nothing was watching.

## 2 · Goals

One authenticated page answering, for every system on the host: **is it up, what version is live, when did it deploy, what changed, and is it protected** — plus an audited control plane to act on the answer.

**Non-goals (YAGNI):** log search/aggregation, APM/tracing, metric history beyond ~7 days, per-container sparklines, per-tenant logins for other developers.

## 2.1 · Design principles — robust and expandable

The system exists to watch a portfolio that **keeps growing**. These are binding constraints, not aspirations; where they conflict with a quicker build, they win.

**Expandable**

- **Discovery, not enumeration.** Systems are *discovered* — from container-runtime project labels, a deploy-log path glob, the proxy config, the ACME client's inventory. Adding the 20th stack requires **no code change and no config edit**; it simply appears. Any design that needs a hand-maintained list of systems is rejected.
- **Hosts are data, not code.** A host is a first-class row. Enrolling another one is a runtime operation — mint a token, start the agent — never a deploy. Nothing special-cases the first host.
- **Adapters at every external boundary.** Forge (GitHub today, GitLab later), notifier (email / chat), and deploy-log dialects each sit behind one interface with swappable implementations.
- **Scale target: the architecture must not change between 19 systems and ~200.** Bounded probe concurrency, indexed queries, paginated feeds, no per-row N+1.

**Robust**

- **Every external input is untrusted.** 18 deployers means up to 18 log dialects, written by different hands at different times. Each gets a parser config with a generic fallback, and an explicit `unknown format` state. **A confident wrong answer is worse than an admitted gap.**
- **Partial failure is contained.** One unreachable host, one unparseable log, one forge outage degrades *that row* — the page always renders.
- **`unknown` is a first-class state, never rendered as healthy** (see §9).
- **Disposable by design.** The droplet is rebuildable from repo + secrets alone; the only durable state is Postgres, which is backed up. Agents re-enrol. Nothing is hand-configured on a box in a way that does not exist in code — so any node can be destroyed and recreated rather than nursed.

## 3 · Decisions locked (2026-08-01)

1. **Full control plane** — logs, container control, shell. Chosen over read-only or safe-actions-only, with the risk stated and accepted.
2. **Users** — the operator plus a few trusted admins. No per-tenant logins.
3. **Topology** — the dashboard runs **off-box, on its own droplet**, so it survives the monitored host going down.
4. **Encryption** — envelope-encrypt all stored secrets *and* audit-log bodies.
5. **Droplet** — **1 GB / 1 vCPU (~$6/mo)**, same region as the monitored host. Viable only because images are built in CI, not on the box.
6. **Approach** — bespoke app plus a privileged agent, rather than assembling off-the-shelf tools.
7. **Repo** — **public**, under the disclosure constraint above.

## 4 · What the dashboard shows

The organising unit is a **system**, not a container. 19 stacks, 19 rows. Containers appear only on drill-down.

### 4.1 Fleet board (landing view)

| Column | Answers | Rule |
|---|---|---|
| System + URL | which app | links to the live vhost |
| Health | is it up | **worst-of** every container's state **and** an HTTP probe of the public URL. A container can be `Up` while the app 502s — both, or it is not green |
| Version | what is live | short sha, links to the commit |
| Deployed | when | relative, absolute on hover |
| Latest change | **why** | commit subject of the deployed sha |
| CI | did it pass | real status where a pipeline exists; explicit `—` where none does. **Never a fake green** |
| Drift | is it stuck | commits between deployed sha and the remote default branch |
| Cert | expiry | days left; amber <21, red <7 |
| Backup | is it protected | age of last backup, or **`none`** in red |

The backup column shows red on **17 of 19 rows** on day one. That is the most valuable thing this page will ever say.

### 4.2 Host vitals strip

Load vs core count, RAM available, disk, swap, uptime, containers up/total. At survey time this already reads amber: load ~6.4 against 4 vCPU, 2.8 GB RAM free of 7.8, disk 38%.

### 4.3 CI/CD tracker

- **Live deploy feed** across all 18 deployers: timestamp, system, sha, outcome (deploy OK / build failed / health-check failed / self-healed), duration.
- **Stuck-deploy detection** — a failure sentinel present, or local HEAD ahead of the last-deployed sha beyond a threshold. This generalises the detector for the four-hour outage to all 18 deployers, most of which have no self-heal logic at all.
- **CI runs** from the forge API: status, conclusion, duration, run link. The first implementation is GitHub; GitLab is live elsewhere in the estate, so both sit behind one adapter interface (§2.1).

### 4.4 Supporting panels

Certificates (26, by expiry) · Backups (configured? last run? age?) · Append-only audit log.

### 4.5 Alerting

Not optional. A dashboard only helps while someone is looking at it. One notification channel for: system down, deploy failed, cert <14 days, disk >85%, backup missed.

### 4.6 Tenancy

All 19 stacks are shown — the operator owns the host — but every row carries an owner tag, so another tenant's incident is never mistaken for one of ours.

## 5 · Architecture

**Dashboard** (its own droplet, 1 GB, Ubuntu 24.04): Next.js 15 + Prisma + Postgres 16 in compose, behind host nginx + certbot.

**Agent** (on the monitored host): a small daemon that **dials out** to the dashboard over an authenticated WebSocket and holds it open. No new inbound port, no firewall hole, nothing further exposed on a host carrying nine businesses. Commands travel down that connection; events stream up it.

**Operations, not a pipe.** The control plane is a fixed set of named operations the agent implements — `restart_container`, `tail_logs`, `rerun_deploy`, `renew_cert`, `run_backup` — every argument validated against what the agent can actually see. Raw shell is one further operation, separately gated: step-up TOTP each time, session-recorded, hard-capped duration. This does not limit the operator; it means a compromise of the *web app* is not automatically a shell on the host, and every 3 a.m. action is reconstructable.

**Host-agnostic by construction** — no monitored host is special-cased, so further hosts enrol without code changes. This is also what makes the public-repo constraint enforceable: there is nothing environment-specific to leak.

## 6 · Auth

Email + Argon2id password. **TOTP mandatory for every account, no exemptions.** Access token in memory, refresh in an HttpOnly cookie — never localStorage. Step-up re-auth before any mutating operation. No self-registration: accounts come from an operator-run CLI, reusing a one-time bootstrap-admin pattern already proven on this estate. Lockout and rate limiting on both password and TOTP attempts.

## 7 · App-layer encryption

A KEK from a **file-mounted** secret (never env, never logged) unwraps a DEK. AES-256-GCM with **AAD bound to row id + column name**, so a ciphertext cannot be lifted from one row into another.

Encrypted at rest: agent enrolment keys, forge API tokens, TOTP seeds, audit-log bodies. Operational data (system names, deploy history, metrics) stays queryable in plaintext — encrypting it would kill `GROUP BY` and range queries for no real confidentiality gain against an attacker who already holds the database.

## 8 · Real-time

- The agent tails the deploy logs (path glob supplied by config), parses each deployer's success and failure lines, and pushes **the moment a deploy lands** — not on a poll.
- **Forge webhooks** hit the dashboard for CI status the instant a run finishes; API polling reconciles missed webhooks.
- Browser updates over SSE.

## 9 · Failure modes designed in

**A stale dashboard must never look healthy.** If the agent connection drops, every row renders *"agent unreachable, last seen HH:MM"* — greyed, not green. The worst outcome available to this product is a page confidently showing all-green while the host burns.

**Who watches the watcher.** Alerts are emitted from the droplet so they survive the monitored host dying — but the droplet can die too. It therefore emits a heartbeat to an external dead-man's switch. Without that, the blind spot has only moved.

## 10 · CI/CD for this project

**Pipeline:** on PR and push — typecheck, lint, tests against a Postgres service container, build. On the default branch — build the image and push to the registry tagged with the sha.

**Disclosure gate (repo-specific, blocking).** A CI job greps the whole tree for IPv4 literals, the operator's domains, and the monitored systems' names, and **fails the build** on a hit. Allowlist: RFC-5737 documentation addresses and `127.0.0.1`. Paired with a full-history secret scan. The constraint at the top of this document is only real if a machine enforces it.

**Deploy:** the droplet **pulls a tested image**; it never builds. That is what makes a 1 GB box viable, and it is strictly better than the build-on-prod pattern the other 18 stacks use. Registry auth is a **read-only** token in a file-mounted secret.

The deploy script carries this estate's outage lessons: it asks *"is there new code?"* and *"is the app actually running?"* as **independent** questions, so a downed stack self-heals with no new commit; any pre-deploy dump is best-effort, because a backup needing the database the deploy just stopped fails every retry forever; and success is claimed **only** by an explicit `Deploy OK: <sha>` line.

## 11 · Delivery slices

1. **Read-only fleet board** — droplet provisioned, agent enrolled, health + version + deployed-at + latest change + drift.
2. **CI/CD tracker** — deploy feed, stuck-deploy detection, webhooks + reconciliation.
3. **Auth hardening + alerting** — MFA policy, step-up, audit log, notifications, dead-man's switch.
4. **Control plane** — named operations, then gated shell. Deliberately last and slowest.

Auth and encryption sit in slice 1's foundations; slice 3 lands the policy around them.

**Each slice gets its own implementation plan, review and merge.** This document is the product design; it is deliberately larger than one plan. The first plan targets slice 1 only.

## 12 · Testing

Unit tests on the parsers (deploy-log, certificate listing, container inspection) and the crypto envelope. Integration tests against a real Postgres. Agent contract tests against a fake container runtime. Playwright for login-with-MFA and a step-up action.

Two rules held throughout, both learned here: **every authz rule gets a test asserting the denial**, and **no fake may be more permissive than the real endpoint** — a permissive fake certified a real bug in a prior review chain on this estate.

## 13 · Needed from the operator

1. **DigitalOcean API token** — `doctl` is installed but unauthenticated; no droplet can be created without it. **This is the hard blocker.**
2. ~~The repo URL~~ — supplied 2026-08-01.
3. **DNS:** the dashboard hostname must point at the **new droplet**, not the monitored host.
4. **Notification channel** for alerts.

## 14 · Cost

~$6/mo droplet. No other new spend.
