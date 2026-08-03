import { PrismaClient, Prisma } from '@prisma/client'
import type { HostnameConfig, OnBoxProbeResult, ProbeOutcome } from '@bevora-ops/shared'
import { prisma } from './db.js'
import { displayState } from './staleness.js'
import { buildBeatTrace, BEAT_WINDOW_MS, type Beat } from './beats.js'
import { combine, primaryHostname, type Axis, type Verdict } from './answers.js'
import type { FleetRow, HostnameAnswer } from '../components/FleetTable.js'

/**
 * Five minutes -- the external probe's own cadence (spec §5.1). Recorded
 * here, not imported from Task 9's not-yet-written scheduler, so this file
 * carries no dependency on work that has not landed; Task 9 MUST import
 * THIS constant rather than choosing the number a second, independent time.
 *
 * TASK 9 OBLIGATION, recorded rather than enforced (fix round 2, Task 8
 * review): nothing in this codebase stops Task 9's scheduler from picking
 * its own interval instead of importing this one. If it does,
 * `EXTERNAL_RESULT_STALE_AFTER_MS` below silently stops meaning "three
 * missed cycles" -- it would just be a number that happens to be 15
 * minutes, decoupled from whatever the real cadence turned out to be. The
 * reviewer endorsed 15 minutes as the right ceiling for a 5-minute cadence;
 * that reasoning only holds if the two constants are ever actually the same
 * one.
 */
export const EXTERNAL_PROBE_INTERVAL_MS = 300_000

/**
 * Past this age, a stored external result is not merely old -- it is stale
 * enough that treating it as a CURRENT opinion would be exactly the lie
 * spec §5.1 exists to prevent: "an old result presented as current is the
 * same lie this slice exists to remove." `buildHostnameAnswers` below
 * refuses to feed a result older than this into `combine()`'s external
 * axis, exactly as `displayState` (staleness.ts) refuses to vouch for a
 * stale on-box observation rather than passing its raw health straight
 * through. THREE cadences (15 minutes): one or two missed cycles is
 * ordinary cadence jitter; crossing three means the axis's silence is
 * itself the signal, not a fluke tick.
 *
 * The RAW age is still always reported on `HostnameAnswer.externalAgeMs`
 * regardless of this ceiling -- an operator can and should see "checked 9
 * days ago" even though the board stops trusting that reading as a live
 * opinion. This mirrors `lastSeenAt`/`deployedSha` elsewhere on this board:
 * a historical fact stays visible even once it has stopped being current.
 */
export const EXTERNAL_RESULT_STALE_AFTER_MS = EXTERNAL_PROBE_INTERVAL_MS * 3

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
  // Raw JSONB, `Prisma.JsonValue` (effectively `unknown` at this boundary) --
  // parsed by `parseHostnames`/`parseOnBoxProbes` below, which are the only
  // places that trust the shape. NULL (a genuine SQL NULL, per
  // ingest.ts/Task 5's own discipline) means "no opinion this tick", never
  // "confirmed empty" -- see FleetRow.hostnames's docstring.
  hostnames: Prisma.JsonValue
  onBoxProbes: Prisma.JsonValue
}

/**
 * `SystemObservation.hostnames`/`onBoxProbes` arrive from Postgres as
 * `Prisma.JsonValue` (a union that includes `null`, objects, arrays...).
 * These two functions are the ONLY place that casts them to the typed
 * shapes `shared/src/wire.ts` defines -- the same trust boundary
 * `latestExternalResultsByHostname` below already crosses with its own
 * `r.outcome as ProbeOutcome` cast, extended here to a whole array: every
 * row that reaches this column was written by `ingestSnapshot`, which
 * validated the ENTIRE incoming payload against `FleetSnapshotSchema`
 * before writing anything (see ingest.ts), so nothing malformed can be
 * sitting in this column. `null` passes straight through -- it is not a
 * parse failure, it is Task 5's own "no opinion" sentinel.
 */
function parseHostnames(raw: Prisma.JsonValue): HostnameConfig[] | null {
  if (raw === null) return null
  return raw as unknown as HostnameConfig[]
}

function parseOnBoxProbes(raw: Prisma.JsonValue): OnBoxProbeResult[] | null {
  if (raw === null) return null
  return raw as unknown as OnBoxProbeResult[]
}

/**
 * How "worse" each `Verdict` (Task 7) is, for folding several hostnames'
 * individual verdicts into ONE row-level answer (`FleetRow.verdict`).
 *
 * `healthy` is the only good outcome. `unprobed`/`unconfirmed` outrank it
 * DELIBERATELY, even though neither is a fault: a row with one healthy
 * hostname and one never-probed hostname must not read as a flat
 * "healthy" summary, because that would assert something about the second
 * hostname nobody has checked -- the same "claim only what the evidence
 * supports" rule every other absence on this board follows. `contradiction`
 * outranks the two definite-fault states because confused evidence (spec
 * §3's "flagged, never guessed") is at least as urgent as a named one.
 */
const VERDICT_SEVERITY: Record<Verdict, number> = {
  healthy: 0,
  unprobed: 1,
  unconfirmed: 2,
  'route-broken': 3,
  'app-down': 4,
  contradiction: 5,
}

/**
 * The WORST (highest-severity) of several verdicts -- see `VERDICT_SEVERITY`
 * above. This is the mechanism behind spec §8's "one failing hostname on a
 * multi-hostname system must not be averaged away into a green row":
 * `primaryHostname()` picks a hostname that ANSWERS to show as the
 * clickable URL, so using its verdict alone as the row's summary would let
 * exactly that averaging happen. `worstVerdict` looks at every NAMED
 * hostname this system has and reports the worst one, regardless of which
 * hostname `primaryHostname()` chose to display. An empty input is
 * `unprobed` -- there was nothing to check either axis against.
 *
 * Fix round 4 (Task 8 review), C1, stated here because it is this
 * function's own contract, not just its caller's: an UNNAMED on-box probe
 * (a published port with no vhost) NEVER contributes to this fold, in
 * either direction. `worstVerdict` is a MAX, and a max-fold has no way to
 * express "positive evidence that should not decide the outcome on its
 * own" except by lowering the floor -- and lowering it below every absence
 * state is exactly how one answering, unnamed port turned into an entire
 * system's `healthy` verdict, for a system with no named hostnames at all.
 * See `systemRow`'s own comment at the call site for the full history.
 */
export function worstVerdict(verdicts: Verdict[]): Verdict {
  if (verdicts.length === 0) return 'unprobed'
  return verdicts.reduce((worst, v) => (VERDICT_SEVERITY[v] > VERDICT_SEVERITY[worst] ? v : worst))
}

/** Builds the `Axis` `combine()` (Task 7) expects, or `null` when there is
 * nothing to build one from -- kept as one place so every caller below
 * expresses "no opinion" identically. */
function toAxis(outcome: ProbeOutcome | undefined, status: number | null | undefined): Axis | null {
  if (outcome === undefined) return null
  return { outcome, status: status ?? null }
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
/**
 * The last recorded run of the external prober, whatever its outcome --
 * see `ExternalProbeRun` in schema.prisma. `null` means no sweep has ever
 * run (a fresh deploy, before Task 9's scheduler has fired once).
 */
export type LatestExternalProbeRun = { ranAt: Date; reachedAnything: boolean }

/**
 * Fix round 1 (Task 8 review), C2b: the fleet-wide banner used to be
 * INFERRED from `isFleetWideExternalFailure` over
 * `latestExternalResultsByHostname`'s per-hostname rows -- which have no
 * time bound (Task 7a's rule keeps the previous good result as "latest"
 * during an outage). Two applications failing three weeks apart could both
 * read as "failing now", and the banner would announce a fleet-wide fault
 * "this cycle" that never happened; meanwhile a REAL dashboard-network
 * outage, which writes NOTHING to `ExternalProbeResult` (by the same rule),
 * would produce no visible signal at all.
 *
 * `ExternalProbeRun` is written on every sweep, including one that reached
 * nothing, specifically so this function has a single row to read instead
 * of an inference over unrelated history.
 */
export async function latestExternalProbeRun(client: PrismaClient = prisma): Promise<LatestExternalProbeRun | null> {
  const row = await client.externalProbeRun.findFirst({ orderBy: { ranAt: 'desc' } })
  return row ? { ranAt: row.ranAt, reachedAnything: row.reachedAnything } : null
}

/**
 * `latestPerSystem`'s result: the board's rows, plus the last external
 * sweep's own status, computed ONCE for the whole fetch rather than per
 * row -- it describes the dashboard's OWN probing, not any one system's
 * state, so it does not belong on `FleetRow` itself.
 */
export type FleetBoard = {
  rows: FleetRow[]
  /**
   * `null` when no external sweep has ever run. Otherwise, whether that
   * sweep reached anything and how long ago (relative to `now`) it ran.
   * Every row's own `verdict` already reflects the fallback this triggers
   * when `reachedAnything` is false (the external axis is treated as
   * absent, see `latestPerSystem`'s body) -- this field exists to drive the
   * banner's text, not to change any row's colour a second time.
   */
  lastExternalSweep: { reachedAnything: boolean; ageMs: number } | null
}

export async function latestPerSystem(now: Date, client: PrismaClient = prisma): Promise<FleetBoard> {
  // Independent of whether any host/system exists at all -- the sweep is a
  // fact about the DASHBOARD's own probing, not about the fleet it probes.
  const lastRun = await latestExternalProbeRun(client)
  const lastExternalSweep = lastRun
    ? { reachedAnything: lastRun.reachedAnything, ageMs: now.getTime() - lastRun.ranAt.getTime() }
    : null
  // Spec §9's fallback: while the last sweep reached nothing, every
  // hostname's verdict is built as if the external axis were simply absent
  // (`combine(onBox, null)`), which can only ever resolve to `unprobed` or
  // `unconfirmed`, never a fault verdict -- so the guard's promise ("shows
  // the on-box results ... does not turn every row red") holds by
  // construction, not by a second, separate check.
  const fleetWideFailure = lastRun !== null && !lastRun.reachedAnything

  // Hosts first, and ordered here, so the board's ordering is host-major
  // and stable regardless of what systems exist under each.
  const hosts = await client.host.findMany({ orderBy: { name: 'asc' } })
  if (hosts.length === 0) return { rows: [], lastExternalSweep }

  const systems = await client.system.findMany({ orderBy: { key: 'asc' } })
  if (systems.length === 0) {
    // Every enrolled host, all of them awaiting a first report.
    return {
      rows: hosts.map((h) => neverReportedRow(h.id, h.name, h.lastSeenAt)),
      lastExternalSweep,
    }
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
      "deployedSha", "deployedSubject", "deployedAt", "driftCommits", "receivedAt",
      "hostnames", "onBoxProbes"
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

  // The union of every hostname CURRENTLY configured across the whole
  // fleet's latest observations -- fetched ONCE, batched, the same reason
  // `fetchRecentBeats` above is batched rather than queried per system.
  // Bounding `latestExternalResultsByHostname` (Task 7a) by exactly this
  // set is what lets a retired hostname stop appearing on its own, with no
  // retention pass -- see that function's own docstring.
  const allHostnames = new Set<string>()
  for (const o of observations) {
    for (const h of parseHostnames(o.hostnames) ?? []) allHostnames.add(h.hostname)
  }
  const externalByHostname = await latestExternalResultsByHostname([...allHostnames], client)

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
      rows.push(
        systemRow(
          s,
          host.name,
          host.lastSeenAt,
          bySystemId.get(s.id) ?? null,
          beatsBySystemId.get(s.id) ?? [],
          now,
          externalByHostname,
          fleetWideFailure,
        ),
      )
    }
  }
  return { rows, lastExternalSweep }
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
    // No system exists here at all, so there is nothing to have hostnames
    // (`null`, not `[]` -- there is no observation to have confirmed an
    // empty list from), no probes, no verdict beyond `unprobed`.
    hostnames: null,
    onBoxProbes: null,
    primaryHostname: null,
    verdict: 'unprobed',
    leadHostnameAnswer: null,
    tlsConfigured: null,
    certDaysRemaining: null,
    hostnameAnswers: [],
    unnamedOnBoxProbes: [],
  }
}

/**
 * Builds every named hostname's `HostnameAnswer`, this system's unnamed
 * on-box probe results, its row-level `verdict` (spec §8, via
 * `worstVerdict`), and the primary hostname's own flattened cert/TLS facts.
 *
 * `fleetWideFailure` -- when true, the EXTERNAL axis is treated as absent
 * for every hostname, regardless of what `externalByHostname` actually
 * holds. That is spec §9's fallback in code: a fleet-wide external failure
 * must fall back to on-box evidence, not report the (almost certainly
 * locally-caused) external failures as this system's own fault.
 *
 * Fix round 1 (Task 8 review), C3: a stored external result older than
 * `EXTERNAL_RESULT_STALE_AFTER_MS` is likewise treated as NO CURRENT
 * OPINION for REACHABILITY -- `externalOutcome` reads `null`, and
 * `combine()` never sees its axis -- exactly the same "absent" treatment
 * `fleetWideFailure` already gets. Without this, a result from nine days
 * ago (a hostname the sweep has quietly stopped reaching) would still
 * count as a live "healthy" opinion forever, which is precisely the lie
 * spec §5.1 exists to remove. `externalAgeMs` is the one field that is
 * NEVER nulled by staleness -- an operator must still be able to see
 * "checked 9 days ago" even though the board itself stops trusting the
 * content of that reading.
 *
 * Fix round 4 (Task 8 review), C2: `certExpiresAt`/`certDaysRemaining` are
 * DELIBERATELY NOT part of that gate -- rounds 1-3 nulled them together
 * with `externalOutcome`, which meant every certificate figure on the
 * board vanished (fell to grey "not checked"/"no longer current") for the
 * entire duration of a fleet-wide failure or any three missed cycles, the
 * one window the column is least able to re-check anything. The asymmetry
 * is deliberate and load-bearing: REACHABILITY can flip in either
 * direction between two checks (an app that was down can come back, and
 * vice versa), so a stale reachability reading genuinely cannot be trusted
 * either way -- but a certificate's EXPIRY DATE can only ever move LATER
 * (renewal) or stay the same; it never moves earlier. A stale reading of
 * expiry can therefore only ever OVER-alarm (the cert may since have been
 * renewed to a later date), never under-alarm (an expiry the board saw was
 * 3 days out cannot have secretly become 30 days out on its own). Since
 * over-alarming is the safe direction and under-alarming is the one this
 * whole slice exists to prevent, suppressing the stale figure was the one
 * direction that was actually unsafe. `certLabel` (FleetTable.tsx) states
 * the reading's provenance explicitly whenever it is not current, so an
 * old figure is never presented as a fresh one -- it is presented as
 * exactly what it is: real, and possibly out of date.
 *
 * Fix round 5 (Task 8 review): round 4 named `certExpiresAt` specifically
 * instead of stating the general rule, and missed the OTHER field sharing
 * its property -- `externalOutcome === 'tls-failed'` (spec §7's three
 * hostnames configured for TLS whose handshake fails) is EQUALLY
 * monotone: a completed, failed handshake cannot silently become a
 * passing one without an operator installing a valid certificate, so a
 * stale `tls-failed` reading can only ever over-alarm, never under-alarm,
 * for the identical reason expiry can. `certHandshakeFailed` below carries
 * that one fact through ungated, the same way `certExpiresAt` is. Every
 * OTHER value `externalOutcome` can take (`answering`, `not-answering`,
 * `proxy-no-upstream`, `answering-oddly`) genuinely CAN flip in either
 * direction between two checks and stays correctly gated -- `tls-failed`
 * and `certExpiresAt`/`certDaysRemaining` are the ONLY two facts reached
 * through this function that have the "cannot silently improve" property;
 * this was a deliberate sweep for a third one, not an assumption.
 */
function buildHostnameAnswers(
  hostnames: HostnameConfig[],
  onBoxProbes: OnBoxProbeResult[] | null,
  externalByHostname: Map<string, LatestExternalResult>,
  fleetWideFailure: boolean,
  now: Date,
): HostnameAnswer[] {
  return hostnames.map((h) => {
    const onBoxEntry = onBoxProbes?.find((p) => p.hostname === h.hostname) ?? null
    const onBoxAxis = onBoxEntry ? toAxis(onBoxEntry.outcome, onBoxEntry.status) : null

    // Fix round 2 (Task 8 review), I1: `externalAgeMs` is read from the RAW
    // map lookup, UNCONDITIONALLY -- age is an observed fact about when the
    // last probe ran, independent of whether this tick's fleet-wide guard
    // or staleness ceiling currently trusts its CONTENT. The previous
    // version computed age from `external` AFTER it had already been forced
    // to `undefined` by `fleetWideFailure`, so a result stored 4 minutes
    // ago -- carrying a certificate 3 days from expiry -- rendered as
    // "never checked externally" during a fleet-wide fallback, directly
    // contradicting C3's own rule that age is the one field never nulled.
    const rawExternal = externalByHostname.get(h.hostname)
    const externalAgeMs = rawExternal ? now.getTime() - rawExternal.observedAt.getTime() : null

    // The REACHABILITY content (axis) is what the fleet-wide guard and the
    // staleness ceiling actually gate -- never the age above, and (fix
    // round 4, C2) never the certificate figures below either.
    const external = fleetWideFailure ? undefined : rawExternal
    const externalIsCurrent = external !== undefined && externalAgeMs !== null && externalAgeMs <= EXTERNAL_RESULT_STALE_AFTER_MS

    const externalAxis = externalIsCurrent ? toAxis(external.outcome, external.status) : null

    // Fix round 4 (Task 8 review), C2: read from `rawExternal`, NOT
    // `external` -- ungated by `fleetWideFailure` or the staleness ceiling,
    // for the reasoning in this function's own docstring above (expiry only
    // ever moves later, so a stale reading can only over-alarm).
    const certExpiresAt = rawExternal?.certExpiresAt ?? null
    const certDaysRemaining = certExpiresAt ? Math.floor((certExpiresAt.getTime() - now.getTime()) / 86_400_000) : null

    // Fix round 5 (Task 8 review): the OTHER monotone fact this gate was
    // still hiding. `externalOutcome` (below) correctly nulls under
    // staleness/fleet-wide failure for every OTHER outcome -- reachability
    // can flip in either direction between checks, so a stale `answering`,
    // `not-answering`, or `proxy-no-upstream` reading genuinely cannot be
    // trusted either way. But `'tls-failed'` shares `certExpiresAt`'s own
    // property: a completed handshake that failed verification cannot
    // silently become a PASSING one without an operator installing a valid
    // certificate, so a stale `tls-failed` reading can only ever
    // OVER-alarm (the operator may since have fixed it), never
    // under-alarm. Read from `rawExternal`, same as `certExpiresAt`, so it
    // survives exactly the same suppression.
    const certHandshakeFailed = rawExternal?.outcome === 'tls-failed'

    return {
      hostname: h.hostname,
      verdict: combine(onBoxAxis, externalAxis),
      onBoxOutcome: onBoxAxis?.outcome ?? null,
      externalOutcome: externalAxis?.outcome ?? null,
      externalAgeMs,
      listensTls: h.listensTls,
      certExpiresAt,
      certDaysRemaining,
      certHandshakeFailed,
    }
  })
}

function systemRow(
  s: { id: string; hostId: string; key: string; displayName: string },
  hostName: string,
  hostLastSeenAt: Date | null,
  o: LatestObservationRow | null,
  beats: Beat[],
  now: Date,
  externalByHostname: Map<string, LatestExternalResult>,
  fleetWideFailure: boolean,
): FleetRow {
  const hostnames = o ? parseHostnames(o.hostnames) : null
  const onBoxProbes = o ? parseOnBoxProbes(o.onBoxProbes) : null

  const hostnameAnswers = buildHostnameAnswers(hostnames ?? [], onBoxProbes, externalByHostname, fleetWideFailure, now)

  // `hostname: null` entries are a published port with no vhost mapping --
  // Task 5's positive "a port with no name answered" fact, not tied to any
  // named hostname so it cannot enter `hostnameAnswers` above.
  //
  // Fix round 2 (Task 8 review), C2 -- corrected claim: an earlier version
  // of this comment asserted that feeding EVERY unnamed entry through
  // `combine(axis, null)` "cannot distort the result either way". That was
  // false, and the render disproved it: `combine(answeringAxis, null)` is
  // `unconfirmed` (an opinion on one axis, none on the other) and
  // `combine(notProbedAxis, null)` -- since `not-probed` has NO opinion --
  // is `unprobed`. Both outrank `healthy` in `VERDICT_SEVERITY`, so folding
  // either into `worstVerdict` alongside a genuinely healthy NAMED hostname
  // DOWNGRADED the row -- a silent unmapped database/cache/exporter port
  // (common on a multi-stack host) could drag a fully healthy system down
  // to `unprobed` or `unconfirmed`.
  //
  // Fix round 2's OWN chosen fix was ALSO wrong, and round 4's review found
  // it: it made an `answering` unmapped entry contribute the string
  // `'healthy'` to the array `worstVerdict` folds over. That comment argued
  // correctly that `'healthy'` (severity 0, the floor) "can never make
  // `worstVerdict` read worse" -- true, and it is exactly the wrong half of
  // the argument, because `worstVerdict` is a MAX over its input, and a
  // system with NO NAMED HOSTNAMES AT ALL has nothing else in that array.
  // `worstVerdict(['healthy'])` is `'healthy'` -- the synthesized entry
  // becomes the ENTIRE row's verdict, on the strength of one port spec
  // §3.1 says "may be a database, a cache, a mail relay, a UDP service",
  // for a system the row's own URL column calls "no HTTP surface" and whose
  // external axis has never run. Spec §2: "a row is green only when the
  // application answers." A max-fold cannot express "positive but
  // non-dispositive evidence" by lowering its floor -- lowering it BELOW
  // every absence state (`unprobed`/`unconfirmed`, severity 1/2) is exactly
  // what manufactures a false green out of nothing.
  //
  // The fix: an unmapped port's result contributes NOTHING to `verdict`,
  // ever, regardless of outcome. It is not thrown away -- `unnamedOnBoxProbes`
  // below still carries it, and `AnswersCell` (FleetTable.tsx) prints "a
  // port with no name answered on-box (N)" independently of `verdict` --
  // but a fact that can only be positive must never be allowed to BECOME
  // the verdict on its own; it may only ever fail to move one.
  const unnamed = (onBoxProbes ?? []).filter((p) => p.hostname === null)

  const verdict = worstVerdict(hostnameAnswers.map((h) => h.verdict))

  // Fix round 1 (Task 8 review), I2: the Answers cell's parenthetical
  // detail (spec §5's "proxy up, app not responding" / "TLS handshake
  // failed") must come from the hostname that actually PRODUCED the row's
  // worst verdict, never from `primaryAnswer` below -- `primaryHostname()`
  // prefers a hostname that ANSWERS, so the two can disagree, and reading
  // the detail off the wrong one produces a sentence that contradicts
  // itself ("contradiction -- unreachable on-box, answering from outside
  // (proxy up, app not responding)" when the PRIMARY hostname, not the one
  // in contradiction, happened to see a 502). `null` when no NAMED hostname
  // reaches the row's worst severity -- i.e. the worst verdict came from an
  // unnamed on-box probe instead, which has no hostname to attribute a
  // detail to.
  const leadHostnameAnswer = hostnameAnswers.find((h) => h.verdict === verdict) ?? null

  // The clickable URL prefers a hostname that ANSWERS (see
  // `primaryHostname`'s own docstring) -- built from whichever axis has an
  // opinion, external preferred, since that is the path a real visitor
  // takes. A hostname with neither axis's opinion is simply absent from
  // this map, which `primaryHostname` treats identically to an explicit
  // non-answering entry.
  const outcomeForPrimary = new Map<string, ProbeOutcome>()
  for (const h of hostnameAnswers) {
    const outcome = h.externalOutcome ?? h.onBoxOutcome
    if (outcome) outcomeForPrimary.set(h.hostname, outcome)
  }
  const primary = primaryHostname(
    hostnameAnswers.map((h) => h.hostname),
    outcomeForPrimary,
  )
  const primaryAnswer = hostnameAnswers.find((h) => h.hostname === primary) ?? null

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
    hostnames,
    onBoxProbes,
    primaryHostname: primary,
    verdict,
    leadHostnameAnswer,
    tlsConfigured: primaryAnswer?.listensTls ?? null,
    certDaysRemaining: primaryAnswer?.certDaysRemaining ?? null,
    hostnameAnswers,
    unnamedOnBoxProbes: unnamed.filter((p) => p.outcome === 'answering'),
  }
}

/**
 * One hostname's most recent external probe result -- the second axis
 * Task 7's `combine` consumes, and the row Task 8's board join reads.
 * `outcome` is typed as the shared `ProbeOutcome` (not left as the raw
 * `string` the column stores) because every value ever written here comes
 * from `probeExternally` (Task 6), whose result is already constrained to
 * that type -- see `external-probe-runner.ts`.
 */
export type LatestExternalResult = {
  hostname: string
  outcome: ProbeOutcome
  status: number | null
  certExpiresAt: Date | null
  observedAt: Date
}

/** Raw shape `$queryRaw` returns, before the `outcome` cast above. */
type LatestExternalResultRow = {
  hostname: string
  outcome: string
  status: number | null
  certExpiresAt: Date | null
  observedAt: Date
}

/**
 * The latest `ExternalProbeResult` row for each of the given hostnames,
 * via the same `DISTINCT ON` shape `latestPerSystem` above uses for
 * `SystemObservation` -- and for the identical reason: `ExternalProbeResult`
 * is a history (a fresh row is INSERTED every probe run, never updated in
 * place, so a result can persist and age across restarts -- see its own
 * docstring in schema.prisma), so "the latest result" must be a query, not
 * a row identity, and it must be one Postgres can serve via the
 * `[hostname, observedAt]` index rather than by scanning every historical
 * row for every hostname and slicing afterwards.
 *
 * DELIBERATELY bounded by the caller's own `hostnames` list, the same way
 * `latestPerSystem` bounds its beat fetch by the CURRENT `systemIds`
 * rather than every system id that ever existed. This is what answers the
 * question of what happens when a hostname stops being served: its rows
 * are never deleted (no retention is built by this task -- see
 * `external-probe-runner.ts`'s report), so left unbounded, its last result
 * WOULD read as newest forever, on a hostname nothing serves any more. By
 * requiring the caller to pass the CURRENTLY discovered hostname set
 * (e.g. from the latest `SystemObservation.hostnames`), a retired
 * hostname simply stops appearing in the argument and therefore stops
 * appearing in the result -- the stale row is still on disk, but nothing
 * ever asks for it again. That is a caller-side filter, not a database
 * one: this function does not know which hostnames are current, it only
 * knows how to fetch the latest result for whichever ones it is asked
 * about.
 */
export async function latestExternalResultsByHostname(
  hostnames: string[],
  client: PrismaClient = prisma,
): Promise<Map<string, LatestExternalResult>> {
  if (hostnames.length === 0) return new Map()

  const rows = await client.$queryRaw<LatestExternalResultRow[]>`
    SELECT DISTINCT ON ("hostname")
      "hostname", "outcome", "status", "certExpiresAt", "observedAt"
    FROM "ExternalProbeResult"
    WHERE "hostname" = ANY(${hostnames})
    ORDER BY "hostname", "observedAt" DESC
  `
  return new Map(rows.map((r) => [r.hostname, { ...r, outcome: r.outcome as ProbeOutcome }]))
}
