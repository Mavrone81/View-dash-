import { HealthStateSchema, type HealthState } from '@bevora-ops/shared'

// Derived, not duplicated: the set of health values this file recognises is
// the SAME set `shared` defines as the wire contract. If `shared` ever gains
// or renames a health value, this type and set follow automatically instead
// of silently drifting out of sync with no compiler signal.
export type DisplayState = HealthState | 'stale'

const KNOWN = new Set<string>(HealthStateSchema.options)

/**
 * Derive what the dashboard should display for one system, given its most
 * recent observation.
 *
 * `receivedAt` MUST be the server-set timestamp — the database's own
 * `now()` at the moment the observation row was stored (e.g. a
 * `receivedAt`/`createdAt` column written by the server, never a value the
 * agent sent). It must NEVER be the agent-claimed `observedAt` field, which
 * is read from the monitored host's own clock and is untrusted: a host with
 * a fast clock (or a compromised agent) can set it to any value, including
 * one in the future. If staleness were computed from that value, `now -
 * claimed` could be permanently negative, and every row would read as fresh
 * forever — the dashboard would show all-green straight through an outage,
 * which is the exact failure this function exists to prevent.
 *
 * That said, this function does not simply trust `receivedAt` to always be
 * sane either: if it somehow arrives from the future (a clock fault on the
 * database host, a bad migration, a bug upstream — the specific cause
 * doesn't matter), a naive "not yet older than the threshold" check would
 * read that as maximally fresh and report the raw health, when in fact a
 * future server timestamp means something about the pipeline is broken and
 * we cannot vouch for the data at all. So a `receivedAt` in the future is
 * `unknown`, the same honest "we don't know" answer as no observation at
 * all — never a fallback to `healthy` or `down`, and never a silent
 * "forever fresh" the way an agent-supplied clock could produce.
 *
 * Staleness outranks the reported health in BOTH directions: once the data
 * is old we no longer know the system is healthy, nor that it is down.
 * Asserting either would claim something we cannot support, so `stale` is
 * its own state rather than a fallback to `healthy` or `down`.
 *
 * No observation at all (`receivedAt === null`) is `unknown`, which is
 * distinct from `stale` — we have never heard from this system, versus we
 * used to but the trail went cold.
 *
 * An unrecognised health value is also `unknown`, never passed through
 * as-is: only known health values are allowed to reach the display.
 *
 * `staleAfterMs` defaults to 90 seconds: three missed 30-second collection
 * cycles. One missed collection is noise (a slow tick, a brief blip);
 * three in a row is a real signal that the agent has stopped reporting.
 * The comparison is strict `>`, so an observation exactly at the threshold
 * age is still considered fresh, not stale.
 */
export function displayState(
  receivedAt: Date | null,
  health: string,
  now: Date,
  staleAfterMs = 90_000,
): DisplayState {
  if (!receivedAt) return 'unknown'
  const ageMs = now.getTime() - receivedAt.getTime()
  if (ageMs < 0) return 'unknown'
  if (ageMs > staleAfterMs) return 'stale'
  return KNOWN.has(health) ? (health as DisplayState) : 'unknown'
}
