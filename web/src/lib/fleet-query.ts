import { PrismaClient } from '@prisma/client'
import { prisma } from './db.js'
import { displayState } from './staleness.js'
import type { FleetRow } from '../components/FleetTable.js'

// Shape of one row returned by the DISTINCT ON query below. Typed
// explicitly against the SystemObservation columns it selects, so the raw
// query's result never has to be treated as `any` at the boundary.
type LatestObservationRow = {
  systemId: string
  health: string
  containersTotal: number
  containersRunning: number
  deployedSha: string | null
  deployedSubject: string | null
  deployedAt: Date | null
  driftCommits: number | null
  receivedAt: Date
}

/**
 * `client` defaults to the shared singleton and only exists as a parameter
 * so a test can pass in a separately-constructed, query-logging client to
 * inspect the SQL this function actually issues (see fleet-query.test.ts).
 * Production code never needs to pass it.
 */
export async function latestPerSystem(now: Date, client: PrismaClient = prisma): Promise<FleetRow[]> {
  const systems = await client.system.findMany({ orderBy: { key: 'asc' } })
  if (systems.length === 0) return []

  // Fetch exactly one observation row PER SYSTEM, in the database, via
  // Postgres's `DISTINCT ON` — not "every observation for every matched
  // system, sliced to one-per-system afterwards". The latter is what a
  // Prisma `include: { observations: { take: 1, orderBy } }` relation load
  // does: it sends Postgres `WHERE systemId IN (...) ORDER BY receivedAt
  // DESC` with NO LIMIT and no per-group window function, so Postgres
  // returns every historical row for every matched system, and only the
  // slicing down to one-per-system happens afterwards (in Prisma's query
  // engine, not even in this file's own JS). That is invisible with sparse
  // history, but at the project's ~200-system / 30s-poll scale target,
  // `SystemObservation` grows without bound, and every board load would
  // scan and transfer that entire, ever-growing table. `DISTINCT ON
  // ("systemId") ... ORDER BY "systemId", "receivedAt" DESC` asks Postgres
  // itself to stop at the first (most-recently-received) row per group,
  // which is exactly what the `[systemId, receivedAt]` index serves: for
  // each distinct systemId, walk the index in receivedAt-DESC order and
  // emit only its first row. The number of rows Postgres returns is bounded
  // by the number of systems, never by how much history exists.
  const systemIds = systems.map((s) => s.id)
  const observations = await client.$queryRaw<LatestObservationRow[]>`
    SELECT DISTINCT ON ("systemId")
      "systemId", "health", "containersTotal", "containersRunning",
      "deployedSha", "deployedSubject", "deployedAt", "driftCommits", "receivedAt"
    FROM "SystemObservation"
    WHERE "systemId" = ANY(${systemIds})
    ORDER BY "systemId", "receivedAt" DESC
  `
  const bySystemId = new Map(observations.map((o) => [o.systemId, o]))

  return systems.map((s): FleetRow => {
    const o = bySystemId.get(s.id) ?? null
    return {
      key: s.key,
      displayName: s.displayName,
      // Pass the server-trusted `receivedAt`, never the agent-claimed
      // `observedAt` — `displayState`'s first parameter is deliberately
      // named `receivedAt` to make this the only correct call.
      state: displayState(o?.receivedAt ?? null, o?.health ?? 'unknown', now),
      // Nullable, not defaulted to 0: a system that has never reported must
      // stay distinguishable from one that is reporting and genuinely runs
      // zero containers. `FleetTable` renders an em dash for the former and
      // `0/0` for the latter — defaulting either field to 0 here would
      // collapse that distinction before it ever reaches the component.
      containersRunning: o?.containersRunning ?? null,
      containersTotal: o?.containersTotal ?? null,
      deployedSha: o?.deployedSha ?? null,
      deployedSubject: o?.deployedSubject ?? null,
      deployedAt: o?.deployedAt ?? null,
      driftCommits: o?.driftCommits ?? null,
      receivedAt: o?.receivedAt ?? null,
    }
  })
}
