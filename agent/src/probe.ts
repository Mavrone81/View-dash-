import { classifyHttpStatus, classifyProbeFailure, probeOutcomeToHealth, type HealthState, type ProbeOutcome } from '@bevora-ops/shared'

/**
 * Spec §4.1 defines a system's health as the **worst-of** every
 * container's state AND an HTTP probe of that system's public URL:
 * "A container can be `Up` while the app 502s -- both, or it is not
 * green." Container state alone was all this branch ever computed, so a
 * stack whose containers are all running but whose app returns 502 to
 * every real visitor rendered green. This module is the missing half.
 *
 * The probe deliberately produces one of the SAME `HealthState` values the
 * container side produces, so folding the two together is an ordinary
 * worst-of over one scale rather than a translation between two.
 */

/**
 * How alarming each state is, for worst-of purposes. Strictly ordered so
 * `worstOf` is total and has no ties to resolve arbitrarily.
 *
 * `unknown` sits ABOVE `degraded` and BELOW `down`: not knowing is worse
 * than knowing something is partly wrong (we cannot vouch for it at all),
 * but it is not the same as the definite, actionable fact that a system is
 * down. In practice neither input to `worstOf` produces `unknown` today --
 * `discoverSystems` never returns it and a probe never returns it (an
 * unprobeable system contributes `null`, i.e. no opinion, instead) -- so
 * its rank exists to keep this function total over `HealthState`, not
 * because a caller currently depends on where it sits.
 */
const RANK: Record<HealthState, number> = {
  healthy: 0,
  degraded: 1,
  unknown: 2,
  down: 3,
}

/**
 * Folds a probe result into a container-derived health.
 *
 * `probed === null` means "this system has no known URL, so no probe was
 * performed" -- NOT "the probe found nothing wrong". A system we cannot
 * probe must be reported exactly as its containers describe it and must
 * never be downgraded for the absence of a URL, because downgrading would
 * make "we were not told where this app lives" indistinguishable from "we
 * looked and the app is unhealthy". Only a probe that actually ran may
 * move a row.
 */
export function worstOf(containerHealth: HealthState, probed: HealthState | null): HealthState {
  if (probed === null) return containerHealth
  return RANK[probed] > RANK[containerHealth] ? probed : containerHealth
}

/**
 * The subset of `fetch` this module uses, so a test needs no network and no
 * global patching. `headers` is optional because only the on-box probe
 * needs one (an explicit `Host`, required now that it addresses a container
 * port directly rather than a hostname -- see `probeHostnameOnBox`); the
 * external probe in `probeUrl` never sets it.
 */
export type FetchLike = (
  url: string,
  init: { signal: AbortSignal; redirect: 'manual'; headers?: Record<string, string> },
) => Promise<{ status: number }>

export const DEFAULT_PROBE_TIMEOUT_MS = 5_000

/**
 * Probes one system's public URL and maps the outcome onto a health state.
 *
 * The status -> outcome mapping is `classifyHttpStatus` (from
 * `@bevora-ops/shared`) -- the SAME rule `probeHostnameOnBox` below uses for
 * the on-box probe, so a status is never judged two different ways
 * depending which probe saw it. In particular: 401 and 403 count as
 * `answering` (a login wall is an application working), NOT as `degraded`
 * the way every OTHER 4xx does. This function used to fold ALL 4xx --
 * including 401/403 -- into `degraded` itself, before `classifyHttpStatus`
 * existed to state the rule once; that inline copy is gone now, not kept
 * alongside it.
 *
 *   - 2xx / 3xx     -> `healthy`. The app answered.
 *   - 401 / 403     -> `healthy`. A login wall is the app working.
 *   - other 4xx     -> `degraded`. Something answered, but not with the app
 *                      working: a 404 on a system's own front door is a real
 *                      misconfiguration. Amber, not red -- an answer came
 *                      back, so the stack is not simply dead.
 *   - 502 / 504     -> `down`. This is the case the spec names explicitly:
 *                      nginx returning 502 while every container reads `Up`.
 *   - other 5xx     -> `down`.
 *   - no answer     -> `down`. A connection refused, a DNS failure, a TLS
 *                      error, or a timeout all mean a visitor gets nothing.
 *
 * NEVER throws. A probe is a diagnostic; a failure in it is a datum, not
 * an error to propagate into collection.
 *
 * Bounded in time, always: an unresponsive host that accepts a connection
 * and then simply never replies would otherwise hang this promise forever,
 * and (because collection awaits all of them) hold the whole snapshot open
 * with it. The abort is enforced by this function's own controller rather
 * than trusted to the caller's fetch implementation.
 *
 * `redirect: 'manual'` so a 301/302 is reported as the 3xx it is instead
 * of being silently followed to some other host -- a redirect to a login
 * page is still "the app answered", and following it could probe an
 * entirely different system.
 */
export async function probeUrl(
  url: string,
  fetchImpl: FetchLike,
  timeoutMs: number = DEFAULT_PROBE_TIMEOUT_MS,
): Promise<HealthState> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const { status } = await fetchImpl(url, { signal: controller.signal, redirect: 'manual' })
    const health = probeOutcomeToHealth(classifyHttpStatus(status))
    // `probeOutcomeToHealth` returns null only for the `not-probed` outcome,
    // which `classifyHttpStatus` -- fed a real completed-response status, as
    // it always is here -- can never produce. Unreachable in practice; a
    // fallback here documents probeOutcomeToHealth's full range honestly
    // rather than asserting past it with a cast.
    return health ?? 'down'
  } catch {
    // Includes the timeout above firing: either way, nothing usable came
    // back from the URL an operator told us this system serves.
    return 'down'
  } finally {
    // Without this, a fast successful probe still holds a pending timer,
    // which keeps the Node event loop alive for the full timeout.
    clearTimeout(timer)
  }
}

/**
 * A hostname paired with the loopback port that serves it -- or `null` for
 * the hostname when a published port has no vhost mapping at all (see
 * `hostnamesForSystem`'s docstring for why that is still worth probing).
 *
 * The on-box probe (see `probeHostnameOnBox` below) addresses the container
 * port directly rather than resolving the hostname -- see the spec's §3.1
 * correction -- so knowing WHICH port a given hostname belongs to is no
 * longer optional context, it is the dial target itself.
 */
export type HostnameTarget = { hostname: string | null; port: number }

/**
 * Pairs each of a system's published ports with the hostname(s) the host's
 * reverse-proxy config maps to that port.
 *
 * A published port with NO vhost mapping still yields ONE target, with
 * `hostname: null`, rather than nothing: fix round 1 asked explicitly
 * whether a port with no known hostname should still be probed with no
 * `Host` header, and the call here is yes. "The app is up" is real evidence
 * worth having for the one case §4 of the spec measured live -- a system
 * with legitimately no vhost -- and, more importantly, for the transient
 * gap this whole module exists to cover: a stack whose container just
 * started publishing a port but whose vhost has not been written yet.
 * Probing nothing there until a human edits nginx would be the exact
 * "robust and expendable" property this design is supposed to remove,
 * reappearing one layer down. `probeHostnameOnBox` sends no `Host` header
 * at all for a `null` target -- there is no name to claim.
 *
 * Deduplicated on the (port, hostname) pair, not just the hostname: the
 * same pair can appear twice if the same vhost file is reachable under two
 * different names in the enabled-vhost directory (a stray duplicate
 * symlink is the realistic cause), and probing it twice doubles real
 * requests against a production root for zero new information. A
 * `Map`/`Set` cannot be used directly to dedupe a compound key, so an
 * explicit composite string does the job. A `null`-hostname target needs no
 * such dedupe: there is exactly one per port by construction.
 */
export function hostnamesForSystem(publishedPorts: number[], byPort: Map<number, string[]>): HostnameTarget[] {
  const seen = new Set<string>()
  const out: HostnameTarget[] = []
  for (const p of publishedPorts) {
    const hostnames = byPort.get(p) ?? []
    if (hostnames.length === 0) {
      out.push({ hostname: null, port: p })
      continue
    }
    for (const h of hostnames) {
      const key = `${p}:${h}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ hostname: h, port: p })
    }
  }
  return out
}

/**
 * Probes one hostname from ON the monitored host: `http://127.0.0.1:<port>/`
 * with an explicit `Host: <hostname>` header, per the spec's §3.1
 * correction (commit `8387ae6`).
 *
 * This is NOT `https://<hostname>/`, which is what this function originally
 * did and which a seam review caught as broken in two ways at once:
 *
 *  - It resolved through PUBLIC DNS and traversed the exact path a real
 *    visitor takes -- the reverse proxy, TLS, egress, DNS -- so one egress
 *    rule or resolver hiccup would redden every row on the board while
 *    every application was fine, AND it meant this probe and the external
 *    one always measured the same path and could never disagree, which
 *    defeats the entire two-probe design (see spec §3's table: the
 *    "application fine, external broken" row is the reason this design
 *    exists at all).
 *  - It hardcoded `https://`, so a vhost serving plain HTTP -- a stack
 *    deployed before its certificate exists, precisely the "probed the day
 *    it deploys" case this module advertises -- got a certificate mismatch
 *    from whichever server block happens to own 443, and rendered red
 *    while working perfectly.
 *
 * Addressing the port directly dissolves both: there is no DNS, no egress,
 * no TLS, and no reverse proxy anywhere in this request's path, so there is
 * nothing to guess a scheme for and nothing shared with the external
 * probe's path. That also means a 502/504 can never legitimately arise on
 * THIS axis -- there is no proxy here to emit one. If a container's own
 * application happens to return a raw 502 for its own reasons,
 * `classifyHttpStatus` (shared with the external probe, deliberately -- see
 * `probeUrl`) will still label it `proxy-no-upstream`, which is a
 * permissible imprecision rather than something to special-case: one rule
 * in the tree matters more than perfect per-axis wording for an edge case
 * with no evidence it occurs.
 *
 * The `Host` header is required, not cosmetic, WHEN a hostname is known: a
 * name-based vhost may redirect or refuse a request that arrives without
 * the name it expects. `hostname` is `null` for a published port with no
 * vhost mapping at all (see `hostnamesForSystem`) -- fix round 1's explicit
 * call: still probe it, just with no `Host` header, since there is no name
 * to claim. "The app answered on its port" is real, if weaker, evidence,
 * and it is the only evidence available in the gap between a stack's first
 * deploy and its vhost being written -- refusing to probe there would
 * reintroduce, for that one port, the exact "must wait on a human to edit
 * config" property this whole module exists to remove.
 *
 * No TLS is ever involved on this axis, so every failure here is
 * network-shaped: connection refused (nothing listening on that port),
 * a timeout, or the abort below firing. `classifyProbeFailure('network')`
 * reflects that; there is no TLS branch to route to any more.
 *
 * NEVER throws, for the same reason as `probeUrl`: a probe is a diagnostic
 * running inside the collection loop of an agent watching nine businesses'
 * production, and a failure to reach a hostname is a datum this function
 * reports, not an exception it raises.
 */
export async function probeHostnameOnBox(
  hostname: string | null,
  port: number,
  fetchImpl: FetchLike,
  timeoutMs: number = DEFAULT_PROBE_TIMEOUT_MS,
): Promise<{ hostname: string | null; outcome: ProbeOutcome; status: number | null }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const { status } = await fetchImpl(`http://127.0.0.1:${port}/`, {
      signal: controller.signal,
      redirect: 'manual',
      // Omitted entirely (not present-with-undefined) when there is no
      // hostname to claim -- exactOptionalPropertyTypes forbids the latter,
      // and fetch would otherwise send a literal "Host: null".
      ...(hostname !== null ? { headers: { Host: hostname } } : {}),
    })
    return { hostname, outcome: classifyHttpStatus(status), status }
  } catch {
    return { hostname, outcome: classifyProbeFailure('network'), status: null }
  } finally {
    clearTimeout(timer)
  }
}
