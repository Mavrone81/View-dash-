import { PrismaClient, Prisma } from '@prisma/client'
import type { HostnameConfig } from '@bevora-ops/shared'
import { prisma } from './db.js'

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
 */
export async function currentExternalProbeTargets(client: PrismaClient = prisma): Promise<ExternalProbeTarget[]> {
  const rows = await client.$queryRaw<LatestHostnamesRow[]>`
    SELECT DISTINCT ON ("systemId") "systemId", "hostnames"
    FROM "SystemObservation"
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
