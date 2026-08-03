import type { PrismaClient } from '@prisma/client'
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
 */
export async function runExternalProbes(
  hostnames: string[],
  deps: ExternalDeps,
  client: PrismaClient = prisma,
): Promise<ExternalProbeRunResult> {
  const results = await Promise.all(hostnames.map((hostname) => probeExternally(hostname, deps)))

  if (isFleetWideExternalFailure(results)) {
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
