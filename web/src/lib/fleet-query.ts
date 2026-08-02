import { PrismaClient } from '@prisma/client'
import { prisma } from './db.js'
import { displayState } from './staleness.js'
import { buildBeatTrace, BEAT_WINDOW_MS, type Beat } from './beats.js'
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

/** One row of the bounded beat-window fetch below. */
type BeatObservationRow = {
  systemId: string
  receivedAt: Date
  health: string
}

/**
 * Fetch the beat-trace source data for every given system: all observations
 * with `receivedAt` inside roughly the last `BEAT_WINDOW_MS` (20 minutes),
 * bucketed per system.
 *
 * This is a TIME-bounded fetch, deliberately not "the last N observations
 * per system" -- that shape (a Prisma `include` relation load with `take`,
 * or a per-system `ORDER BY ... LIMIT`) is exactly the anti-pattern the
 * per-system-latest query above already avoids for the same reason: at this
 * project's ~20-system / 30s-poll scale, `SystemObservation` keeps growing
 * with no retention, so any fetch shape bounded only by "N most recent" per
 * group still requires Postgres to walk however much history exists to find
 * them unless the WHERE clause itself caps it by time. Filtering on
 * `receivedAt >= now - BEAT_WINDOW_MS` bounds the fetch to roughly (20
 * systems x 40 ticks) = ~800 rows regardless of total history, and is served
 * directly by the existing `[systemId, receivedAt]` index.
 *
 * `receivedAt`, never `observedAt` -- same rule as everywhere else in this
 * file: a beat's position in the trace must come from the server-trusted
 * receive clock, not the agent-claimed one.
 */
async function fetchRecentBeats(systemIds: string[], now: Date, client: PrismaClient): Promise<Map<string, Beat[]>> {
  const traces = new Map<string, Beat[]>()
  if (systemIds.length === 0) return traces

  const windowStart = new Date(now.getTime() - BEAT_WINDOW_MS)
  const rows = await client.$queryRaw<BeatObservationRow[]>`
    SELECT "systemId", "receivedAt", "health"
    FROM "SystemObservation"
    WHERE "systemId" = ANY(${systemIds}) AND "receivedAt" >= ${windowStart}
    ORDER BY "receivedAt" ASC
  `

  const bySystemId = new Map<string, BeatObservationRow[]>()
  for (const row of rows) {
    const arr = bySystemId.get(row.systemId) ?? []
    arr.push(row)
    bySystemId.set(row.systemId, arr)
  }

  for (const systemId of systemIds) {
    traces.set(systemId, buildBeatTrace(bySystemId.get(systemId) ?? [], now))
  }
  return traces
}

/**
 * What a host that has never reported anything shows in the System column.
 * Exported so a test names the same string this renders rather than
 * asserting on a copy of it.
 */
export const NO_SYSTEMS_LABEL = '(no systems reported yet)'

/**
 * `client` defaults to the shared singleton and only exists as a parameter
 * so a test can pass in a separately-constructed, query-logging client to
 * inspect the SQL this function actually issues (see fleet-query.test.ts).
 * Production code never needs to pass it.
 *
 * Rows are scoped BY HOST, and the host drives the iteration rather than
 * the system list. Two things follow from that, both of which were wrong
 * before:
 *
 *  1. Row identity is (host, system key), not the key alone. The schema
 *     makes `System.key` unique only per host, on purpose -- so two hosts
 *     each running a stack called `web` used to produce two rows carrying
 *     the same React key and no way to tell which machine either belonged
 *     to.
 *
 *  2. A `Host` whose agent has never started produces a row saying so,
 *     instead of no row at all. Selecting from `System` meant such a host
 *     was simply ABSENT from the board -- invisible rather than `unknown`,
 *     in direct contradiction of the rule that unknown must never be
 *     silently missing. An operator who enrols a host and mistypes its
 *     token would previously have seen a board that looked completely
 *     normal.
 */
export async function latestPerSystem(now: Date, client: PrismaClient = prisma): Promise<FleetRow[]> {
  // Hosts first, and ordered here, so the board's ordering is host-major
  // and stable regardless of what systems exist under each.
  const hosts = await client.host.findMany({ orderBy: { name: 'asc' } })
  if (hosts.length === 0) return []

  const systems = await client.system.findMany({ orderBy: { key: 'asc' } })
  if (systems.length === 0) {
    // Every enrolled host, all of them awaiting a first report.
    return hosts.map((h) => neverReportedRow(h.id, h.name, h.lastSeenAt))
  }

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
  // Separate, time-bounded fetch for the trace strip -- see fetchRecentBeats's
  // doc for why this must not be folded into (or replace) the DISTINCT ON
  // query above: that query is bounded by system count, this one by a time
  // window, and neither can serve the other's purpose.
  const beatsBySystemId = await fetchRecentBeats(systemIds, now, client)

  const byHostId = new Map<string, typeof systems>()
  for (const s of systems) {
    const arr = byHostId.get(s.hostId) ?? []
    arr.push(s)
    byHostId.set(s.hostId, arr)
  }

  const rows: FleetRow[] = []
  for (const host of hosts) {
    const hostSystems = byHostId.get(host.id) ?? []
    if (hostSystems.length === 0) {
      // Enrolled, but nothing has ever been heard from it. This row is the
      // whole point of iterating hosts: omitting it would make a host whose
      // agent never started indistinguishable from a host that was never
      // enrolled.
      rows.push(neverReportedRow(host.id, host.name, host.lastSeenAt))
      continue
    }
    for (const s of hostSystems) {
      rows.push(systemRow(s, host.name, host.lastSeenAt, bySystemId.get(s.id) ?? null, beatsBySystemId.get(s.id) ?? [], now))
    }
  }
  return rows
}

/** A host that is enrolled but has never reported a single system. */
function neverReportedRow(hostId: string, hostName: string, lastSeenAt: Date | null): FleetRow {
  return {
    // The empty key is what distinguishes this from any real system row on
    // the same host; `System.key` is `.min(1)` on the wire, so no genuine
    // system can ever collide with it.
    id: `${hostId}:`,
    hostName,
    key: '',
    displayName: NO_SYSTEMS_LABEL,
    // Never `down`: we are not claiming this host is broken, only that we
    // have not heard from it. That distinction is the whole reason
    // `unknown` exists as a state.
    state: 'unknown',
    containersRunning: null,
    containersTotal: null,
    deployedSha: null,
    deployedSubject: null,
    deployedAt: null,
    driftCommits: null,
    receivedAt: null,
    lastSeenAt,
    // No system exists here at all, so there is nothing to trace -- distinct
    // from a real system with zero beats in the window (which gets a full
    // 40-slot array of `absent`, not an empty one). `FleetTable` renders an
    // em dash for the empty case, same as any other "nothing to show" field.
    beats: [],
  }
}

function systemRow(
  s: { id: string; hostId: string; key: string; displayName: string },
  hostName: string,
  hostLastSeenAt: Date | null,
  o: LatestObservationRow | null,
  beats: Beat[],
  now: Date,
): FleetRow {
  return {
    // Host-scoped, because `key` alone is not unique across hosts.
    id: `${s.hostId}:${s.key}`,
    hostName,
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
    // The host-level fallback, for a row whose own observation is
    // missing: `Host.lastSeenAt` was written on every ingest and read by
    // nothing until now, which is why spec §9's "last seen HH:MM" was
    // never actually rendered anywhere.
    lastSeenAt: hostLastSeenAt,
    // Always BEAT_COUNT slots for a real system, even one with zero beats in
    // the window -- see fetchRecentBeats/buildBeatTrace: "no beats fetched"
    // becomes a full trace of `absent`, not an empty array. An empty array
    // here is reserved for the "no system exists" placeholder row.
    beats,
  }
}
