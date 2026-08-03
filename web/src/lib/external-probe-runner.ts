import type { PrismaClient } from '@prisma/client'
import type { HostnameConfig } from '@bevora-ops/shared'
import { prisma } from './db.js'
import { probeExternally, type ExternalDeps, type ExternalResult } from './external-probe.js'
import { isFleetWideExternalFailure } from './answers.js'

/**
 * What one run of the external prober produced, and whether it wrote
 * anything to the database.
 *
 * `stored: false` (see the fleet-wide guard below) is not a detail to
 * discard -- it IS part of this run's outcome, and a caller (Task 9's
 * scheduler) needs to be able to tell "this cycle ran and confirmed N
 * hostnames" apart from "this cycle could not reach anything and wrote
 * nothing", so it can log or surface the difference rather than the two
 * looking identical from the outside.
 */
export type ExternalProbeRunResult = {
  results: ExternalResult[]
  stored: boolean
}

/**
 * Probes every given hostname and stores one row per hostname -- see
 * `ExternalProbeResult` in schema.prisma for why per-hostname, never
 * per-system: a system can carry several hostnames and they can genuinely
 * disagree (spec §8), and storing one row per system would average a
 * failing hostname into a passing sibling's result, which spec §8
 * forbids explicitly.
 *
 * NEVER throws on a probe failure: `probeExternally` already turns every
 * failure -- timeout, TLS, refused connection -- into a datum
 * (`ExternalResult`), never a rejection, and this function adds no new
 * way for a single bad hostname to fail the batch. A caller walking every
 * hostname on the host must not have one unreachable target abort the
 * cycle for the rest. (A database error from the `createMany` write
 * below is a different kind of failure -- an operational fault in
 * storage itself, not evidence about any hostname -- and is deliberately
 * allowed to propagate, the same choice `ingestSnapshot` makes for its
 * own writes.)
 *
 * A FLEET-WIDE FAILURE WRITES NOTHING. If every hostname probed this
 * cycle failed, the far more likely explanation is that THIS SERVER'S
 * own network is broken -- an egress rule, a resolver outage, the box
 * losing its route -- not that every one of a dozen independent
 * applications died in the same instant. Spec §9 states this guard for
 * *display*; the same reasoning applies to *storage*: writing every
 * hostname's row as failed would overwrite genuinely-good previous
 * results with a local fault, turning the whole board red for a reason
 * that has nothing to do with any application being watched.
 *
 * Deliberately "write nothing" rather than "write anyway, tagged as
 * suspect": the latest-per-hostname reader
 * (`latestExternalResultsByHostname` in fleet-query.ts) has no notion of
 * a suspect row, and giving it one would mean every reader has to learn
 * to filter it out. Writing nothing simply leaves the PREVIOUS good
 * result as the latest one -- exactly what should keep showing while the
 * local fault is diagnosed. Its age will correctly grow stale in the
 * meantime; that is an honest signal (spec §5.1), not the lie this slice
 * exists to remove.
 *
 * This guard is NOT the same thing as "skip if anything failed". A
 * PARTIAL failure -- one hostname down while its neighbours answer --
 * is stored exactly as-is, including the failing hostname's row: a
 * route-broken finding for one hostname while the rest of the fleet is
 * fine is the entire signal this design exists to produce, and the
 * fleet-wide guard must never swallow it.
 *
 * Takes `targets: HostnameConfig[]`, not a bare `string[]`, so that each
 * hostname's own `listensTls` (Task 5's wire fact, nullable) travels
 * alongside it all the way to `probeExternally` -- see that function's
 * `listensTls` parameter for why: without it, every hostname is probed over
 * HTTPS regardless of how it is actually served, which is Task 8's deferred
 * false-green risk (a plain-HTTP vhost's probe silently lands on whichever
 * server block owns port 443 instead). `web/src/lib/external-probe-targets.ts`
 * (Task 9) is what PRODUCES this list from the fleet's latest observations;
 * this function only consumes it.
 */
export async function runExternalProbes(
  targets: HostnameConfig[],
  deps: ExternalDeps,
  client: PrismaClient = prisma,
): Promise<ExternalProbeRunResult> {
  const results = await Promise.all(targets.map((t) => probeExternally(t.hostname, deps, t.listensTls)))
  const fleetWide = isFleetWideExternalFailure(results)

  // Task 8 fix round 1 (C2b): a run-level record, written EVERY time this
  // runs -- including (especially) a fleet-wide failure, which is exactly
  // when `ExternalProbeResult` below writes NOTHING. Without this, the
  // board's fleet-wide banner had no honest signal to read:
  // `isFleetWideExternalFailure` over `latestExternalResultsByHostname`'s
  // per-hostname rows has no time bound, so it could fire (or fail to fire)
  // based on results from cycles unrelated to "this sweep". `ExternalProbeRun`
  // answers "when did the last sweep run, and did it reach anything"
  // directly, independent of whatever the per-hostname history happens to
  // contain.
  //
  // Fix round 1 (Task 9 review), M4: this used to be SKIPPED entirely for an
  // empty target list, reasoning that "nothing to attempt" is a different
  // fact from "attempted and reached nothing" -- true, but "never write a
  // row" was the wrong fix for that distinction. A fleet with zero
  // currently-configured hostnames (no system has an HTTP surface deployed
  // yet -- a legitimate, common state, not a failing scheduler) then NEVER
  // got a single `ExternalProbeRun` row, so `shouldRunExternalProbe`
  // (probe-scheduler.ts) kept seeing `lastRunAt: null` forever, rediscovery
  // re-ran on every scheduler tick with nothing to show for it, and
  // `deploy/verify-board.sh`'s "the scheduler has run at least once" check
  // would fail PERMANENTLY against a scheduler working exactly as designed
  // -- the opposite misreport from C1 (a check that could never turn green
  // on a healthy system, rather than one that could never turn red on a
  // dead one). `targetCount` is what makes it safe to always write the row
  // instead: a reader can tell "0 targets, swept nothing because there was
  // nothing to sweep" (`targetCount: 0`) apart from "swept N targets and
  // reached none of them" (`targetCount: N > 0`, `reachedAnything: false`) --
  // `reachedAnything` alone cannot distinguish those, since both currently
  // read `true`/`false` from the exact same `isFleetWideExternalFailure`
  // computation below.
  //
  // `reachedAnything` needs no special case for the empty-target run:
  // `isFleetWideExternalFailure([])` already returns `false` (an empty
  // `attempted` list proves nothing failed, per that function's own
  // "absence is not evidence" rule -- see answers.ts), so `!fleetWide` is
  // already `true` here, and the board's fleet-wide-failure fallback
  // correctly does not trigger for a zero-hostname fleet.
  await client.externalProbeRun.create({ data: { reachedAnything: !fleetWide, targetCount: targets.length } })

  if (fleetWide) {
    return { results, stored: false }
  }

  if (results.length > 0) {
    await client.externalProbeResult.createMany({
      data: results.map((r) => ({
        hostname: r.hostname,
        outcome: r.outcome,
        status: r.status,
        // Passed through exactly as `probeExternally` reported it --
        // `null` when no handshake completed, or when the handshake
        // itself is what failed. Never defaulted, never read from a
        // prior row for this hostname: see the column's own docstring
        // in schema.prisma.
        certExpiresAt: r.certExpiresAt,
      })),
    })
  }

  return { results, stored: true }
}
