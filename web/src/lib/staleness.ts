export type DisplayState = 'healthy' | 'degraded' | 'down' | 'unknown' | 'stale'

const KNOWN = new Set(['healthy', 'degraded', 'down', 'unknown'])

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
 */
export function displayState(
  receivedAt: Date | null,
  health: string,
  now: Date,
  staleAfterMs = 90_000,
): DisplayState {
  if (!receivedAt) return 'unknown'
  if (now.getTime() - receivedAt.getTime() > staleAfterMs) return 'stale'
  return KNOWN.has(health) ? (health as DisplayState) : 'unknown'
}
