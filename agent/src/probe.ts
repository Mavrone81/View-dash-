import type { HealthState } from '@bevora-ops/shared'

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

/** The subset of `fetch` this module uses, so a test needs no network and no global patching. */
export type FetchLike = (url: string, init: { signal: AbortSignal; redirect: 'manual' }) => Promise<{ status: number }>

export const DEFAULT_PROBE_TIMEOUT_MS = 5_000

/**
 * Probes one system's public URL and maps the outcome onto a health state.
 *
 *   - 2xx / 3xx  -> `healthy`. The app answered.
 *   - 4xx        -> `degraded`. Something answered, but not with the app
 *                   working: a 404 on a system's own front door is a real
 *                   misconfiguration, and a 401/403 means this URL is not
 *                   a usable liveness signal and the operator should point
 *                   the probe somewhere that is. Amber, not red -- an
 *                   answer came back, so the stack is not simply dead.
 *   - 5xx        -> `down`. This is the case the spec names explicitly:
 *                   nginx returning 502 while every container reads `Up`.
 *   - no answer  -> `down`. A connection refused, a DNS failure, a TLS
 *                   error, or a timeout all mean a visitor gets nothing.
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
    if (status >= 500) return 'down'
    if (status >= 400) return 'degraded'
    return 'healthy'
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
