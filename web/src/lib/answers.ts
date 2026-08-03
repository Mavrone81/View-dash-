import type { ProbeOutcome } from '@bevora-ops/shared'

/**
 * One probe's evidence about one system, on one of the two axes (on-box or
 * external). Deliberately structural and independent of any other module's
 * probe-result type (`agent/src/probe.ts`'s on-box result, `external-probe.ts`'s
 * `ExternalResult`) -- this file must never import from either, so that it
 * stays a pure function of the vocabulary `shared` defines, not of how any
 * one caller happens to shape its data.
 */
export type Axis = { outcome: ProbeOutcome; status: number | null }

/**
 * `unconfirmed` is this file's addition to the brief's five values, and it
 * exists to close a real gap rather than to round the enum out.
 *
 * The brief's `combine` collapsed "on-box answered, external never probed"
 * onto the SAME value as "neither axis ran at all": both were `unprobed`.
 * Those are different facts. "The application answers on its own machine
 * and we have never looked from outside" is partial, useful evidence -- it
 * rules out the app being flatly down. "Nothing was probed" is zero
 * evidence. Folding the first into the second throws away the one fact the
 * on-box axis was able to establish on its own, and it is exactly the kind
 * of collapsing-into-a-boolean this whole function exists to refuse.
 *
 * `unconfirmed` covers every case where EXACTLY ONE axis has an opinion --
 * whichever axis it is, and whether that opinion is an answer or a failure.
 * It is deliberately symmetric rather than trying to be clever about which
 * single axis is more trustworthy alone:
 *
 *   - on-box answers, external absent -> the route/DNS/TLS path is simply
 *     unknown; asserting `healthy` would claim a fact only the external
 *     probe can establish (spec §3's whole reason for a second probe).
 *   - on-box fails, external absent -> on-box failing is strong evidence,
 *     but the design's own contract for a positive claim like `app-down`
 *     is BOTH axes agreeing (see the table in spec §3). Reaching `app-down`
 *     off one axis would be exactly the "picking a winner" rule 1 forbids
 *     for `contradiction`, applied to a different pair of cells.
 *   - external answers/fails, on-box absent -> genuinely ambiguous: an
 *     external-only result cannot distinguish "the app is fine and so is
 *     the route" from "the app is down and only the route was ever
 *     checked", because nothing here bypassed the route to look at the
 *     app directly.
 *
 * A renderer that wants to say more than "unconfirmed" -- e.g. "answers
 * on-box, external not yet checked" -- has the raw `Axis` values available
 * from the same place it got `Verdict` from; this function's job is to
 * name the category, not to withhold the evidence that produced it.
 */
export type Verdict = 'healthy' | 'route-broken' | 'app-down' | 'contradiction' | 'unconfirmed' | 'unprobed'

/**
 * Whether an axis carries an actual OPINION -- something a probe observed --
 * as opposed to no evidence at all.
 *
 * `null` (no probe object at all) and an axis whose `outcome` is
 * `'not-probed'` are treated IDENTICALLY here, on purpose. `not-probed`
 * (see `shared/src/wire.ts`) means a probe ran against something that never
 * owed us an answer -- an unmapped port, per spec §3.1 -- or that a probe
 * could not run at all. Either way, it is the wire's own spelling of
 * "no opinion", not a failure to fold in as evidence. Treating it as a
 * failure would let a system with no HTTP surface at all -- the on-box axis
 * having nothing to say -- read as `app-down` or `route-broken` against an
 * external axis that DID answer, which is a false claim about a system
 * nobody ever expected to answer in the first place.
 */
function opinion(axis: Axis | null): Axis | null {
  if (axis === null) return null
  if (axis.outcome === 'not-probed') return null
  return axis
}

/**
 * Whether an axis that HAS an opinion is a good one. Only called after
 * `opinion` has already ruled out `null` and `not-probed`, so every other
 * member of `ProbeOutcome` is a real, if not necessarily happy, answer.
 *
 * `answering-oddly` counts as answering, matching spec §5's rule that an
 * odd 4xx is a working application making an odd choice, not a failure.
 * `proxy-no-upstream` does NOT count -- it is the proxy itself testifying
 * that the application behind it is not responding, which is a failure of
 * exactly the kind `app-down`/`route-broken` exist to name.
 */
function isGoodAnswer(axis: Axis): boolean {
  return axis.outcome === 'answering' || axis.outcome === 'answering-oddly'
}

/**
 * Combines the two probes WITHOUT collapsing them into a boolean. This is
 * the function the whole slice exists for: everything upstream of it
 * gathers evidence, and this is the one place that turns two independent
 * observations into a statement about WHERE a fault is.
 *
 * ```
 * on-box    external   verdict
 * ----------------------------------
 * answers   answers    healthy
 * answers   fails      route-broken     <- the row this design exists for
 * fails     fails      app-down
 * fails     answers    contradiction    <- never resolved by picking a winner
 * (any pairing with exactly one axis having no opinion) -> unconfirmed
 * (neither axis has an opinion)                         -> unprobed
 * ```
 *
 * `route-broken` is why this design runs two probes at all: the application
 * is provably fine on the machine (a loopback request that never touches
 * DNS, TLS, or the reverse proxy -- spec §3.1), and something between it
 * and the world is not. Neither probe alone can produce that statement.
 *
 * `contradiction` is not resolved by preferring an axis. It is rare, it
 * usually means a cache or CDN is serving what the origin cannot, and
 * guessing which probe to believe would be inventing a fact rule 1
 * forbids.
 *
 * `unprobed` and `unconfirmed` both refuse to invent a fact from missing
 * evidence -- see `Verdict`'s docstring for why they are two different
 * values rather than one. Neither is ever `healthy`: half the evidence
 * missing means the whole point of running two probes (their ability to
 * disagree) never had a chance to operate.
 */
export function combine(onBox: Axis | null, external: Axis | null): Verdict {
  const onBoxOpinion = opinion(onBox)
  const externalOpinion = opinion(external)

  if (onBoxOpinion === null && externalOpinion === null) return 'unprobed'
  if (onBoxOpinion === null || externalOpinion === null) return 'unconfirmed'

  const onBoxGood = isGoodAnswer(onBoxOpinion)
  const externalGood = isGoodAnswer(externalOpinion)

  if (onBoxGood && externalGood) return 'healthy'
  if (onBoxGood && !externalGood) return 'route-broken'
  if (!onBoxGood && !externalGood) return 'app-down'
  return 'contradiction'
}

/**
 * True only when every external probe that actually ran (i.e. has an
 * opinion, see `opinion` above) failed. This is the fleet-wide guard: if
 * every hostname on the whole board suddenly fails externally at once, the
 * far more likely explanation is that the DASHBOARD's own network is
 * broken -- an egress rule, a resolver outage, the box itself losing its
 * route -- not that every one of a dozen independent applications died in
 * the same instant. Spec §9's failure mode this guards against.
 *
 * Two absences are both FALSE, deliberately, per rule 2 ("absence is not
 * evidence"):
 *
 *   - an empty `results` array proves nothing happened, not that everything
 *     failed;
 *   - an array where every entry is `not-probed` (nothing actually ran, it
 *     was just represented by an object rather than by omission) is the
 *     same absence wearing a different shape, and must reach the same
 *     answer. Without filtering these out first, a fleet where most systems
 *     have no HTTP surface -- a normal, common state, not an outage -- could
 *     read as a fleet-wide external failure the moment even the FEW real
 *     probes it does have happened to fail, which is exactly the false
 *     alarm this guard exists to prevent, not produce.
 */
export function isFleetWideExternalFailure(results: Array<{ outcome: ProbeOutcome }>): boolean {
  const attempted = results.filter((r) => r.outcome !== 'not-probed')
  if (attempted.length === 0) return false
  return attempted.every((r) => r.outcome !== 'answering' && r.outcome !== 'answering-oddly')
}

const respondsWell = (outcome: ProbeOutcome | undefined): boolean =>
  outcome === 'answering' || outcome === 'answering-oddly'

/**
 * Picks the ONE hostname a system's row names, out of possibly several.
 * Arbitrary but TOTAL: the same `hostnames`/`results` pair always yields the
 * same answer, which is spec §5.2's requirement that the board's most
 * prominent column not change between refreshes for no reason.
 *
 * Order of preference:
 *   1. a hostname that answers (`answering` or `answering-oddly`) over one
 *      that does not, or was never probed;
 *   2. the shortest hostname;
 *   3. alphabetical.
 *
 * (2) and (3) together are a TOTAL ORDER over strings, so ties are
 * impossible by construction once (1) does not decide it -- no two
 * distinct hostnames can be equal in both length and lexicographic order.
 */
export function primaryHostname(hostnames: string[], results: Map<string, ProbeOutcome>): string | null {
  if (hostnames.length === 0) return null
  const sorted = [...hostnames].sort((a, b) => {
    const aResponds = respondsWell(results.get(a)) ? 0 : 1
    const bResponds = respondsWell(results.get(b)) ? 0 : 1
    if (aResponds !== bResponds) return aResponds - bResponds
    if (a.length !== b.length) return a.length - b.length
    return a < b ? -1 : 1
  })
  return sorted[0] ?? null
}
