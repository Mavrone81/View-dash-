import { PrismaClient, Prisma } from '@prisma/client'
import type { HostnameConfig } from '@bevora-ops/shared'
import { prisma } from './db.js'

/**
 * How long a system's hostnames stay in the external probe's target list
 * after its LAST reported observation, with no newer one behind it --
 * i.e. how long a possibly-decommissioned host is still probed before this
 * module gives up on it. Seven days.
 *
 * Final whole-branch review, fix round 2, Important 1 -- MY OWN INSTRUCTION
 * WAS WRONG. Round 1 wrote "C1's age gate bounds this for free" and reused
 * `ON_BOX_STALE_AFTER_MS` (90 seconds) here. That conflates two entirely
 * different questions: `ON_BOX_STALE_AFTER_MS` asks "is this READING still
 * fresh enough to trust as a live opinion" (three missed 30-second agent
 * ticks -- a FRESHNESS ceiling), where this asks "has this HOSTNAME been
 * retired" (a RETIREMENT/decommissioning question). A hostname is a stable
 * fact about a system's configuration; it does not go stale in ninety
 * seconds the way a probe RESULT does.
 *
 * Reproduced against the real database: an agent silent for just TWO
 * MINUTES (a systemd restart, a transient network blip -- this estate has
 * already lost a Node process to a hardening flag) previously zeroed
 * `targetCount` and stopped writing `ExternalProbeResult` rows entirely,
 * inverting C1's own premise IN THE SAME COMMIT: C1 reasons that a silent
 * agent means the host MAY be down, and the external probe is the one
 * INDEPENDENT instrument that can confirm or refute that from outside the
 * host. The 90-second bound removed that instrument exactly when it was
 * needed -- an agent that dies while its 20 stacks keep serving takes the
 * independent axis down with it: every row falls to `unprobed` within 15
 * minutes, certificate expiry stops being observed for every hostname on
 * the host, and a genuine external fault during the very outage this probe
 * exists to catch is never seen. SILENTLY, too -- a zero-target sweep still
 * sets `reachedAnything: true` (there was nothing to fail AT), so no
 * fleet-wide-failure banner fires either.
 *
 * Seven days is deliberately generous and deliberately a STOPGAP, not a
 * design: the properly-shaped mechanism for "this host is gone" is an
 * explicit operator action (revoking/removing its enrolment), not a
 * silence timer guessed from the outside. This constant only exists so
 * that a host removed from the fleet without that explicit step does not
 * have its stale hostnames probed FOREVER (the original M2 finding); it
 * should not be read as "seven days is the right amount of time to keep
 * trusting a hostname," only as "seven days is long enough that no
 * ordinary outage, restart, or maintenance window ever hits it."
 */
export const PROBE_TARGET_RETENTION_MS = 7 * 24 * 60 * 60 * 1000

/**
 * What the external prober is told to probe THIS sweep: every hostname
 * currently claimed by any system's latest observation, each carrying its
 * own `listensTls` (Task 5's wire fact) so `runExternalProbes` can choose
 * the right scheme per hostname -- see that function's own docstring, and
 * `external-probe.ts`'s `probeExternally`, for why the scheme must not be
 * assumed.
 *
 * Reuses `HostnameConfig` (shared/src/wire.ts) rather than inventing a
 * near-duplicate shape: this IS the same fact `SystemObservation.hostnames`
 * already carries, just collected across the whole fleet instead of one
 * system.
 */
export type ExternalProbeTarget = HostnameConfig

// Raw shape of the one column this module reads. Deliberately NOT the same
// query `fleet-query.ts`'s `latestPerSystem` runs (that file is off limits
// for this task -- see task-9-brief.md -- and its query selects a dozen
// other columns this module has no use for), but the SAME shape of query:
// one row per system, the most recently RECEIVED one, via `DISTINCT ON`.
type LatestHostnamesRow = {
  systemId: string
  hostnames: Prisma.JsonValue
}

/**
 * `SystemObservation.hostnames` arrives from Postgres as `Prisma.JsonValue`.
 * This cast is the same trust boundary `fleet-query.ts`'s own
 * `parseHostnames` crosses, and for the identical reason: every row here was
 * written by `ingestSnapshot`, which validated the whole payload against
 * `FleetSnapshotSchema` before writing anything, so nothing malformed can be
 * sitting in this column.
 *
 * `null` passes straight through, UNCHANGED, rather than being defaulted to
 * `[]` here -- see this module's own top-level docstring, and
 * `SystemObservation.hostnames`'s docstring in schema.prisma, for the
 * distinction this preserves: `null` means "this observation has no opinion
 * about this system's hostnames" (an older agent, or a vhost read that
 * failed this tick), `[]` means "a newer agent looked and confirmed there
 * are none". Both currently contribute ZERO probe targets -- there is
 * nothing here to add either way -- but they are not the same fact, and
 * collapsing them at THIS layer (e.g. by writing `?? []` before the caller
 * ever gets to see which one it was) would make that distinction
 * unrecoverable for any future caller of this module that needs to tell
 * "never heard from" apart from "confirmed empty".
 */
function parseHostnames(raw: Prisma.JsonValue): HostnameConfig[] | null {
  if (raw === null) return null
  return raw as unknown as HostnameConfig[]
}

/**
 * Every hostname the fleet's systems currently claim, deduplicated, each
 * carrying the `listensTls` its OWN system reported.
 *
 * "Currently" means: from each system's single most-recently-RECEIVED
 * observation, via `DISTINCT ON ("systemId") ... ORDER BY "systemId",
 * "receivedAt" DESC` -- never `receivedAt` unbounded across history, and
 * never `observedAt` (the agent-claimed clock; see
 * `SystemObservation.observedAt`'s own docstring for why only the
 * server-set `receivedAt` may be trusted to mean "latest"). This is what
 * keeps a hostname that stopped being served from being probed forever: the
 * moment a system's latest observation stops naming it, this function stops
 * returning it, with no separate retention pass required -- the same
 * property `fleet-query.ts`'s `latestExternalResultsByHostname` relies on
 * from its OWN caller (`latestPerSystem`) bounding it by the CURRENT
 * hostname set.
 *
 * A system whose latest observation has `hostnames: null` contributes
 * NOTHING -- not even a stale hostname from an OLDER observation of the same
 * system. Only the single latest row per system is ever read, so an older,
 * non-null `hostnames` sitting further back in that system's history can
 * never resurface here just because the newest tick happened to have no
 * opinion. (Verified in this module's own test: an older observation naming
 * a real hostname, followed by a newer one with `hostnames: null`, produces
 * no target for that hostname.)
 *
 * Deduplicated by hostname across the WHOLE fleet, keeping the first
 * `listensTls` observed for it: two systems legitimately reporting the same
 * hostname (e.g. a shared load balancer vhost) should still produce exactly
 * one probe target, not one real request per system that happens to name
 * it.
 *
 * Final whole-branch review, M2 (revised in fix round 2 -- see
 * `PROBE_TARGET_RETENTION_MS`'s own docstring above for why the FIRST
 * version of this bound was wrong): bounded to a system whose latest
 * observation is no older than `PROBE_TARGET_RETENTION_MS` (seven days),
 * its OWN constant, deliberately NOT `fleet-query.ts`'s
 * `ON_BOX_STALE_AFTER_MS` -- the two answer different questions (retirement
 * vs. reading freshness) and must not share a number just because a first
 * draft of this fix conflated them. Before ANY bound existed, a
 * decommissioned or permanently offline host's LAST reported hostnames
 * stayed the "latest" row forever (`SystemObservation` rows are never
 * deleted), so this function kept handing them to the external prober
 * indefinitely -- real internet requests against applications nobody
 * monitors any more, three of which belong to another business. A system
 * that stops reporting for a genuinely long time simply ages out of this
 * list on its own, with no separate retention pass, the same way a retired
 * HOSTNAME already ages out via the "latest observation per system" rule
 * above -- but a system silent for minutes or hours (an ordinary restart,
 * not a decommissioning) must NOT age out, because the external probe is
 * exactly the instrument an operator needs while that silence is
 * unexplained.
 */
export async function currentExternalProbeTargets(
  client: PrismaClient = prisma,
  now: Date = new Date(),
): Promise<ExternalProbeTarget[]> {
  const cutoff = new Date(now.getTime() - PROBE_TARGET_RETENTION_MS)
  const rows = await client.$queryRaw<LatestHostnamesRow[]>`
    SELECT DISTINCT ON ("systemId") "systemId", "hostnames"
    FROM "SystemObservation"
    WHERE "receivedAt" >= ${cutoff}
    ORDER BY "systemId", "receivedAt" DESC
  `

  const byHostname = new Map<string, boolean | null>()
  for (const row of rows) {
    const hostnames = parseHostnames(row.hostnames)
    if (hostnames === null) continue // no opinion this tick -- nothing to add, see docstring above
    for (const h of hostnames) {
      if (!byHostname.has(h.hostname)) byHostname.set(h.hostname, h.listensTls)
    }
  }

  return [...byHostname.entries()].map(([hostname, listensTls]) => ({ hostname, listensTls }))
}
