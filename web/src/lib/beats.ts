/**
 * The trace strip's slot geometry. The agent reports every 30 seconds, and
 * the board shows the last 40 of those reports, so the strip covers 20
 * minutes of history. This is deliberately narrow: see fleet-query.ts's
 * windowed beat query for why the fetch this feeds from must stay bounded to
 * roughly this same span rather than growing with total history.
 */
export const BEAT_COUNT = 40
export const BEAT_INTERVAL_MS = 30_000
export const BEAT_WINDOW_MS = BEAT_COUNT * BEAT_INTERVAL_MS

/**
 * `good` = we heard from the system and it reported a clean bill of health.
 * `absent` = no beat landed in this slot. Grey, deliberately: a missed
 * report is not itself a fault (see the module doc in FleetTable.tsx for why
 * colouring silence red would cry wolf on every network hiccup).
 * `alarm` = a beat landed and reported trouble.
 */
export type BeatState = 'good' | 'absent' | 'alarm'
export type Beat = { state: BeatState }

/**
 * One raw row this function buckets. Deliberately narrower than a full
 * `SystemObservation` row -- naming the field `receivedAt` (never
 * `observedAt`) is intentional: this is server-trusted receive time, the
 * only clock a beat's position in the trace may be computed from. See
 * staleness.ts's `displayState` doc for the full reasoning; the same
 * untrusted-agent-clock hazard applies here.
 */
export type BeatObservation = { receivedAt: Date; health: string }

/**
 * Bucket a set of observations into `beatCount` fixed-width slots ending at
 * `now`, oldest first. This function does no fetching of its own -- the
 * caller (fleet-query.ts) is responsible for bounding what it hands in to a
 * roughly `BEAT_WINDOW_MS`-wide time window; this function trusts nothing
 * about how many rows it receives and simply drops anything that lands
 * outside the `beatCount` slots it produces.
 *
 * A slot with no observation is `absent` -- the visible hole that is the
 * whole point of this design.
 *
 * A slot whose observation reported `healthy` is `good`. Anything else --
 * `degraded`, `down`, or a value this codebase doesn't recognise at all --
 * is `alarm`. A beat that arrived at all is proof the system was up and
 * talking; only an explicit clean bill of health earns `good`, so an
 * unrecognised health string is treated as something worth flagging, never
 * silently folded into "fine".
 *
 * A `receivedAt` in the future is discarded outright (mirrors
 * `displayState`'s handling of a future receive time): a beat's position in
 * this trace comes from the same trusted clock staleness is computed from,
 * so a value that clock could not honestly produce is not treated as a real
 * beat at all, rather than being clamped into some slot it doesn't belong
 * in.
 *
 * If more than one observation lands in the same slot (agent retry, clock
 * jitter -- normal 30s polling shouldn't produce this, but nothing enforces
 * it), the slot reports `alarm` if ANY of them did, never just whichever was
 * processed last. A fault beat must not be hideable by a second, later
 * reading landing in the same slot.
 */
export function buildBeatTrace(
  observations: readonly BeatObservation[],
  now: Date,
  beatCount = BEAT_COUNT,
  intervalMs = BEAT_INTERVAL_MS,
): Beat[] {
  const slots: BeatState[] = new Array(beatCount).fill('absent')
  const nowMs = now.getTime()
  for (const obs of observations) {
    const ageMs = nowMs - obs.receivedAt.getTime()
    if (ageMs < 0) continue // future receivedAt: not a real beat, see doc above
    const slotsFromNewest = Math.floor(ageMs / intervalMs)
    if (slotsFromNewest >= beatCount) continue // older than the window this trace covers
    const index = beatCount - 1 - slotsFromNewest // oldest-first ordering
    // `?? 'absent'` only satisfies `noUncheckedIndexedAccess` -- `index` is
    // always within `[0, beatCount)` here, so `slots[index]` is never
    // actually out of bounds; the array was fully initialised above.
    const current = slots[index] ?? 'absent'
    const reportsFault = obs.health !== 'healthy'
    if (reportsFault) slots[index] = 'alarm' // a fault beat is never overwritten by a later good one in the same slot
    else if (current !== 'alarm') slots[index] = 'good'
  }
  return slots.map((state) => ({ state }))
}
