import { request as httpRequest } from 'node:http'
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
 * global patching. Used only by `probeUrl` (the external axis) -- the
 * on-box axis has its own transport contract, `OnBoxRequestLike`, because
 * `fetch` cannot send the `Host` header that axis needs (see
 * `OnBoxRequestLike`'s docstring).
 */
export type FetchLike = (
  url: string,
  init: { signal: AbortSignal; redirect: 'manual' },
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
 * The on-box probe's transport contract: connect to `127.0.0.1:<port>`,
 * optionally claiming a `Host`, and report the status seen.
 *
 * This is deliberately NOT `FetchLike`. `Host` is a "forbidden header
 * name" under the WHATWG fetch spec, and undici (the `fetch` Node ships)
 * enforces that by silently DROPPING it rather than erroring -- fix round
 * 2's Critical, reproduced against a real `node:http` server on Node
 * v22.23.1: a fetch-based probe that asked for `Host: alpha.example.invalid`
 * arrived at the server as `Host: 127.0.0.1:<port>` instead, with no
 * exception anywhere to reveal the header never left the process. A test
 * that only records the `init` object handed to a fake `fetch` (as
 * `probeUrl`'s tests correctly do for the external axis) cannot catch this
 * -- it pins the argument, not the wire. This type exists so the on-box
 * probe's transport can never be `fetch` by accident; see `httpOnBoxRequest`
 * for the real implementation and `probe.test.ts`'s "the real on-box
 * transport" suite, which asserts against an actual server's
 * `req.headers.host`, not a recorded argument.
 */
export type OnBoxRequestLike = (
  port: number,
  hostname: string | null,
  signal: AbortSignal,
) => Promise<{ status: number }>

/**
 * The real on-box transport, built on `node:http` specifically because
 * `fetch` cannot send a `Host` header at all (see `OnBoxRequestLike`).
 * `node:http.request` has no such restriction -- it sends whatever headers
 * it is given, verbatim, which is the entire reason this probe exists on a
 * different transport than the external one.
 *
 * Connects to `127.0.0.1:<port>` by IP, not by any name -- there is no DNS
 * resolution step here at all, on-box or otherwise.
 *
 * Redirects are never followed: unlike `fetch`, `http.request` has no
 * concept of following one in the first place, so there is no
 * `redirect: 'manual'` equivalent to set -- not following is simply what
 * this transport does by construction.
 *
 * The response body is drained (`res.resume()`) and discarded: this probe
 * only ever needs the status code, and leaving a response unconsumed would
 * hold the underlying socket open -- measured, not assumed: a seam review
 * deleted this one line and ran 120 probes against a real listener, and
 * active sockets went from roughly flat to 240. On the monitored host that
 * is ~42 targets x 2 sockets x 120 ticks/hour -- file-descriptor
 * exhaustion in this agent, and accumulating half-read responses inside
 * nine businesses' applications. See `probe.test.ts`'s "does not leak a
 * socket per probe" test, which asserts this stays bounded across many
 * requests rather than trusting the comment.
 *
 * Identifies itself with a distinct `User-Agent` (spec §9): this traffic
 * lands in the access logs of applications belonging to OTHER businesses
 * on this host -- three of the twenty stacks measured live belong to one
 * that is not the operator running this agent -- and an unattributable
 * `GET /` every 30 seconds must not read as unexplained or suspicious
 * traffic. This got worse with fix round 2's unmapped-port probing: a
 * database, cache or line-protocol service on an unmapped port now logs a
 * protocol error from this agent roughly 2,900 times a day, and a
 * recognisable source is the least this agent owes the applications it
 * dials without their operator's direct involvement.
 *
 * Exported, and NOT defaulted as `probeHostnameOnBox`'s transport
 * parameter, on purpose: an omitted argument is invisible at the call
 * site, and this codebase already learned that lesson once (see
 * `parseVhost`'s required `upstreams` map in `agent/src/vhosts.ts`). The
 * one real call site (`agent/src/agent-deps.ts`) names this function
 * explicitly.
 */
export function httpOnBoxRequest(port: number, hostname: string | null, signal: AbortSignal): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path: '/',
        method: 'GET',
        headers: {
          'User-Agent': 'bevora-ops-probe/1',
          // Omitted entirely (not present-with-undefined) when there is
          // no hostname to claim -- node:http would otherwise send a
          // literal "Host: null" rather than falling back to its own
          // default.
          ...(hostname !== null ? { Host: hostname } : {}),
        },
        signal,
      },
      (res) => {
        resolve({ status: res.statusCode ?? 0 })
        res.resume()
      },
    )
    req.on('error', reject)
    req.end()
  })
}

/**
 * Probes one hostname from ON the monitored host: `127.0.0.1:<port>` with
 * an explicit `Host: <hostname>` header when a hostname is known, dialled
 * over `node:http` (see `OnBoxRequestLike`/`httpOnBoxRequest`), per the
 * spec's §3.1 correction (commit `8387ae6`) as amended by fix round 2's
 * Critical (this was originally `fetch('https://' + hostname + '/')`, then
 * `fetch('http://127.0.0.1:' + port + '/', { headers: { Host: hostname }
 * })` -- both wrong, the second silently so, for two entirely different
 * reasons; see git history and task-4-report.md for both).
 *
 * Addressing the port directly, on loopback, with no scheme to guess and
 * no TLS in the path, is what makes a 502/504 unable to legitimately arise
 * on THIS axis -- there is no proxy here to emit one. If a container's own
 * application happens to return a raw 502 for its own reasons,
 * `classifyHttpStatus` (shared with the external probe, deliberately -- see
 * `probeUrl`) will still label it `proxy-no-upstream`, which is a
 * permissible imprecision rather than something to special-case: one rule
 * in the tree matters more than perfect per-axis wording for an edge case
 * with no evidence it occurs.
 *
 * `hostname` is `null` for a published port with no vhost mapping at all
 * (see `hostnamesForSystem`) -- fix round 1's explicit call: still probe
 * it, just with no `Host` header, since there is no name to claim.
 *
 * WHAT AN UNMAPPED PORT'S RESULT MEANS, settled by the spec's §3.1 (commit
 * `875e78d`, fix round 3) after an earlier draft contradicted itself
 * ("evidence that can only be positive" in the same sentence as "a failure
 * is not-probed", which are different rules -- the first version of this
 * function reasonably implemented the looser one, and a 5xx from an
 * unmapped port could still redden a row, exactly the false red this rule
 * exists to remove): for an unmapped port, **only `answering` counts**.
 * Every other outcome -- a failure, a 5xx, a redirect, a 404, anything
 * that is not a clean answer -- is `not-probed`, never anything else.
 * `agent/src/docker.ts`'s `toPublishedPorts` filters what it can (TCP,
 * loopback-reachable), but cannot know whether the *protocol* on that port
 * is even HTTP, let alone that answering with some status IS this
 * system's user-facing surface behaving correctly. A published metrics
 * exporter or internal API returning 500 there is an ordinary state of
 * affairs, not an outage of the application the row describes -- we never
 * had grounds to expect an HTTP answer from that port at all, so a good
 * one is a happy surprise worth recording and anything else is a question
 * we had no right to ask. Because `worstOf` can only ever take the WORSE
 * of two states, a healthy (`answering`) outcome here can never wrongly
 * upgrade a row, so trying still costs nothing.
 *
 * For a KNOWN hostname, behaviour is unchanged and ordinary:
 * `classifyHttpStatus` on a real response, `classifyProbeFailure('network')`
 * on a failure -- a mapped port's vhost is the standing evidence an
 * unmapped one lacks, so its full range of outcomes (including
 * `proxy-no-upstream`, `answering-oddly`, `not-answering`) all apply
 * normally.
 *
 * No TLS is ever involved on this axis, so every failure here is
 * network-shaped: connection refused (nothing listening on that port), the
 * wrong protocol entirely (a database or line-protocol service, for an
 * unmapped port), a timeout, or the abort below firing.
 *
 * NEVER throws, for the same reason as `probeUrl`: a probe is a diagnostic
 * running inside the collection loop of an agent watching nine businesses'
 * production, and a failure to reach a hostname is a datum this function
 * reports, not an exception it raises.
 */
export async function probeHostnameOnBox(
  hostname: string | null,
  port: number,
  requestImpl: OnBoxRequestLike,
  timeoutMs: number = DEFAULT_PROBE_TIMEOUT_MS,
): Promise<{ hostname: string | null; outcome: ProbeOutcome; status: number | null }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const { status } = await requestImpl(port, hostname, controller.signal)
    const outcome = classifyHttpStatus(status)
    // An unmapped port's evidence can only be positive (spec §3.1,
    // 875e78d): anything other than a clean `answering` collapses to
    // `not-probed` here, not just a thrown/rejected failure below.
    if (hostname === null && outcome !== 'answering') {
      return { hostname, outcome: 'not-probed', status }
    }
    return { hostname, outcome, status }
  } catch {
    return {
      hostname,
      outcome: hostname === null ? 'not-probed' : classifyProbeFailure('network'),
      status: null,
    }
  } finally {
    clearTimeout(timer)
  }
}
