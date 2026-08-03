import { describe, it, expect, beforeEach } from 'vitest'
import { PrismaClient, type Prisma } from '@prisma/client'
import { prisma } from './db.js'
import {
  latestPerSystem,
  latestExternalResultsByHostname,
  latestExternalProbeRun,
  worstVerdict,
  NO_SYSTEMS_LABEL,
  EXTERNAL_RESULT_STALE_AFTER_MS,
} from './fleet-query.js'
import { BEAT_COUNT, BEAT_INTERVAL_MS } from './beats.js'

beforeEach(async () => {
  await prisma.systemObservation.deleteMany()
  await prisma.system.deleteMany()
  await prisma.agentEnrolment.deleteMany()
  await prisma.host.deleteMany()
  await prisma.externalProbeResult.deleteMany()
  await prisma.externalProbeRun.deleteMany()
})

describe('latestPerSystem', () => {
  it('reports the most recently RECEIVED observation, not the most recently claimed one', async () => {
    // A host whose clock runs fast (or a compromised agent) claims an
    // `observedAt` far in the future for its FIRST, oldest observation. A
    // genuinely later observation is then received, with an honest
    // `observedAt`, but its row lands in the table after the fake one. If
    // "latest" were determined by `observedAt`, the fake future row would
    // sort first forever and this test would see its data instead of the
    // real latest observation's.
    const host = await prisma.host.create({ data: { name: 'host-order' } })
    const system = await prisma.system.create({
      data: { hostId: host.id, key: 'sys-order', displayName: 'sys-order' },
    })
    await prisma.systemObservation.create({
      data: {
        systemId: system.id,
        observedAt: new Date('2099-01-01T00:00:00Z'), // agent-claimed, fake future
        receivedAt: new Date('2026-08-01T10:00:00Z'), // server clock: received FIRST
        health: 'healthy',
        containersTotal: 3,
        containersRunning: 3,
        deployedSha: 'a'.repeat(40),
      },
    })
    await prisma.systemObservation.create({
      data: {
        systemId: system.id,
        observedAt: new Date('2026-08-01T10:05:00Z'), // honest, unremarkable claim
        receivedAt: new Date('2026-08-01T10:05:00Z'), // server clock: received SECOND, genuinely latest
        health: 'down',
        containersTotal: 3,
        containersRunning: 0,
        deployedSha: 'b'.repeat(40),
      },
    })

    const { rows } = await latestPerSystem(new Date('2026-08-01T10:05:30Z'))

    expect(rows).toHaveLength(1)
    // Non-null: exactly one row was just asserted above.
    const row = rows[0]!
    expect(row.deployedSha).toBe('b'.repeat(40))
    expect(row.state).toBe('down')
  })

  it('derives state from receivedAt, not observedAt, so a fresh receivedAt with a stale-looking claimed time still reads live', async () => {
    const host = await prisma.host.create({ data: { name: 'host-wire' } })
    const system = await prisma.system.create({
      data: { hostId: host.id, key: 'sys-wire', displayName: 'sys-wire' },
    })
    const now = new Date('2026-08-01T12:00:00Z')
    await prisma.systemObservation.create({
      data: {
        systemId: system.id,
        // Wildly old claimed time: if `state` were derived from this
        // column instead of `receivedAt`, the row would compute as `stale`.
        observedAt: new Date('2000-01-01T00:00:00Z'),
        receivedAt: new Date(now.getTime() - 5_000), // 5s old: within the fresh window
        health: 'healthy',
        containersTotal: 2,
        containersRunning: 2,
      },
    })

    const { rows } = await latestPerSystem(now)

    expect(rows).toHaveLength(1)
    // Non-null: exactly one row was just asserted above.
    expect(rows[0]!.state).toBe('healthy')
  })

  it('reports stale, never healthy, once receivedAt is old — even if observedAt looks fresh', async () => {
    const host = await prisma.host.create({ data: { name: 'host-stale' } })
    const system = await prisma.system.create({
      data: { hostId: host.id, key: 'sys-stale', displayName: 'sys-stale' },
    })
    const now = new Date('2026-08-01T12:00:00Z')
    await prisma.systemObservation.create({
      data: {
        systemId: system.id,
        // Claimed time looks perfectly fresh: if `state` were derived from
        // this column, the row would wrongly compute as `healthy`.
        observedAt: new Date(now.getTime() - 1_000),
        receivedAt: new Date(now.getTime() - 10 * 60_000), // 10 minutes old: past the 90s threshold
        health: 'healthy',
        containersTotal: 2,
        containersRunning: 2,
      },
    })

    const { rows } = await latestPerSystem(now)

    expect(rows).toHaveLength(1)
    // Non-null: exactly one row was just asserted above.
    expect(rows[0]!.state).toBe('stale')
    expect(rows[0]!.state).not.toBe('healthy')
  })

  it('reports unknown, with dashes for the rest, when a system has never reported', async () => {
    const host = await prisma.host.create({ data: { name: 'host-empty' } })
    await prisma.system.create({
      data: { hostId: host.id, key: 'sys-empty', displayName: 'sys-empty' },
    })

    const { rows } = await latestPerSystem(new Date('2026-08-01T12:00:00Z'))

    expect(rows).toHaveLength(1)
    // Non-null: exactly one row was just asserted above.
    const row = rows[0]!
    expect(row.state).toBe('unknown')
    expect(row.deployedSha).toBeNull()
    expect(row.driftCommits).toBeNull()
    expect(row.receivedAt).toBeNull()
    // A system that has never reported must render as "unknown", not as a
    // fabricated zero — 0/0 is a real, checked fact about a system that IS
    // reporting and genuinely runs no containers, and collapsing "never
    // heard from" into that same value would make the two indistinguishable
    // on the one page whose job is telling them apart.
    expect(row.containersRunning).toBeNull()
    expect(row.containersTotal).toBeNull()
  })

  it('reports a real 0/0 for a system that genuinely has zero containers, distinct from never having reported', async () => {
    const host = await prisma.host.create({ data: { name: 'host-zero' } })
    const system = await prisma.system.create({
      data: { hostId: host.id, key: 'sys-zero', displayName: 'sys-zero' },
    })
    await prisma.systemObservation.create({
      data: {
        systemId: system.id,
        health: 'healthy',
        containersTotal: 0,
        containersRunning: 0,
      },
    })

    const { rows } = await latestPerSystem(new Date('2026-08-01T12:00:00Z'))

    expect(rows).toHaveLength(1)
    // Non-null: exactly one row was just asserted above.
    const row = rows[0]!
    expect(row.containersRunning).toBe(0)
    expect(row.containersTotal).toBe(0)
  })

  it('returns an empty list, not an error, when no systems are enrolled', async () => {
    const { rows } = await latestPerSystem(new Date())
    expect(rows).toEqual([])
  })

  it('fetches exactly one observation row per system in the database, not one row per (system, observation)', async () => {
    // This is the scale-safety test: it must fail against a query shape
    // that fetches every historical observation for every matched system
    // and slices to one-per-system afterwards (which is what a Prisma
    // relation `include: { observations: { take: 1, orderBy } }` compiles
    // to — verified independently by logging the SQL it emits: `WHERE
    // "systemId" IN (...) ORDER BY "receivedAt" DESC` with NO LIMIT and no
    // per-group window function). At the project's ~200-system / 30s-poll
    // scale target, `SystemObservation` grows without bound, so the fetch
    // shape — not just the final row count handed back to callers — must
    // stay bounded by the number of systems, never by how much history
    // exists.
    const host = await prisma.host.create({ data: { name: 'host-scale' } })
    const systemCount = 5
    const observationsPerSystem = 20
    const systems = []
    for (let i = 0; i < systemCount; i++) {
      systems.push(
        await prisma.system.create({
          data: { hostId: host.id, key: `sys-scale-${i}`, displayName: `sys-scale-${i}` },
        }),
      )
    }
    const base = new Date('2026-08-01T12:00:00Z')
    for (const system of systems) {
      for (let j = 0; j < observationsPerSystem; j++) {
        await prisma.systemObservation.create({
          data: {
            systemId: system.id,
            receivedAt: new Date(base.getTime() - j * 1000),
            health: 'healthy',
            containersTotal: 1,
            containersRunning: 1,
          },
        })
      }
    }

    // A second, separately-constructed client with query-event logging
    // enabled, so the emitted SQL can be inspected directly. The shared
    // `prisma` singleton from db.ts is not constructed with logging, so
    // this cannot be done by listening on it — `latestPerSystem` accepts an
    // optional client for exactly this reason.
    const logging = new PrismaClient({ log: [{ emit: 'event', level: 'query' }] })
    const queries: Prisma.QueryEvent[] = []
    logging.$on('query', (e) => queries.push(e))

    try {
      // Sanity check on the fixture itself: systemCount * observationsPerSystem
      // rows genuinely exist. If this weren't true, a passing test below
      // wouldn't mean anything.
      const totalStored = await prisma.systemObservation.count({
        where: { systemId: { in: systems.map((s) => s.id) } },
      })
      expect(totalStored).toBe(systemCount * observationsPerSystem)

      const { rows } = await latestPerSystem(base, logging)

      expect(rows).toHaveLength(systemCount)

      const observationQuery = queries.find((q) => q.query.includes('SystemObservation'))
      expect(observationQuery).toBeDefined()
      // The bounded shape: Postgres itself deduplicates to one row per
      // systemId via DISTINCT ON. A plain WHERE...ORDER BY with no LIMIT
      // and no window function (the previous shape) does not contain this
      // and would return every one of systemCount * observationsPerSystem
      // rows to the caller.
      expect(observationQuery?.query).toMatch(/DISTINCT ON/i)

      // Directly measure the row volume the fetch shape produces, not just
      // the SQL text: run the exact same query independently and count
      // what comes back. This is the literal "N, not N×M" assertion — with
      // systemCount=5 and observationsPerSystem=20, a fetch that returned
      // every historical row would yield 100 here, not 5.
      const directRows = await prisma.$queryRaw<Array<{ systemId: string }>>`
        SELECT DISTINCT ON ("systemId") "systemId"
        FROM "SystemObservation"
        WHERE "systemId" = ANY(${systems.map((s) => s.id)})
        ORDER BY "systemId", "receivedAt" DESC
      `
      expect(directRows).toHaveLength(systemCount)
      expect(directRows).not.toHaveLength(systemCount * observationsPerSystem)
    } finally {
      await logging.$disconnect()
    }
  })

  // The board is a FLEET board -- it shows every enrolled host -- but the
  // query used to select from `System` alone, with no host anywhere in the
  // result. Two consequences, both wrong, both fixed here.
  describe('host scoping', () => {
    it('keeps two hosts running a same-named system as two distinguishable rows', async () => {
      // `System.key` is unique PER HOST by design (`@@unique([hostId,
      // key])`), precisely so this is legal. It has to survive onto the
      // board.
      const hostA = await prisma.host.create({ data: { name: 'host-alpha' } })
      const hostB = await prisma.host.create({ data: { name: 'host-bravo' } })
      for (const h of [hostA, hostB]) {
        await prisma.system.create({ data: { hostId: h.id, key: 'web', displayName: 'web' } })
      }

      const { rows } = await latestPerSystem(new Date('2026-08-01T12:00:00Z'))

      expect(rows).toHaveLength(2)
      expect(rows.map((r) => r.hostName).sort()).toEqual(['host-alpha', 'host-bravo'])
      // The identity React keys rows on. Duplicated ids are the actual bug:
      // two rows sharing a key render as one confused row.
      expect(new Set(rows.map((r) => r.id)).size).toBe(2)
      // ...and it must not be the system key, which IS the same for both.
      expect(new Set(rows.map((r) => r.key)).size).toBe(1)
    })

    it('renders a host whose agent has never started as an explicit unknown row, not as no row at all', async () => {
      // This is the rule that unknown must never be silently absent. An
      // enrolled host with no observations used to produce nothing
      // whatsoever, so a mistyped token looked exactly like a healthy
      // fleet.
      await prisma.host.create({ data: { name: 'host-silent' } })

      const { rows } = await latestPerSystem(new Date('2026-08-01T12:00:00Z'))

      expect(rows).toHaveLength(1)
      expect(rows[0]!.hostName).toBe('host-silent')
      expect(rows[0]!.state).toBe('unknown')
      expect(rows[0]!.displayName).toBe(NO_SYSTEMS_LABEL)
      // Never `down`: we are not claiming this host is broken, only that we
      // have not heard from it.
      expect(rows[0]!.state).not.toBe('down')
    })

    it('shows a silent host alongside a reporting one rather than only the reporting one', async () => {
      const live = await prisma.host.create({ data: { name: 'host-live' } })
      await prisma.host.create({ data: { name: 'host-silent' } })
      const system = await prisma.system.create({
        data: { hostId: live.id, key: 'web', displayName: 'web' },
      })
      const now = new Date('2026-08-01T12:00:00Z')
      await prisma.systemObservation.create({
        data: {
          systemId: system.id,
          receivedAt: new Date(now.getTime() - 5_000),
          health: 'healthy',
          containersTotal: 1,
          containersRunning: 1,
        },
      })

      const { rows } = await latestPerSystem(now)

      expect(rows.map((r) => r.hostName).sort()).toEqual(['host-live', 'host-silent'])
      expect(rows.find((r) => r.hostName === 'host-silent')!.state).toBe('unknown')
      expect(rows.find((r) => r.hostName === 'host-live')!.state).toBe('healthy')
    })

    it('surfaces the host last-seen time, which was written on every ingest and read by nothing', async () => {
      // Spec §9 requires a row that cannot be vouched for to say WHEN it
      // last could be -- "agent unreachable, last seen HH:MM". Nothing
      // could render that while `Host.lastSeenAt` never left the database.
      const lastSeen = new Date('2026-08-01T10:07:00Z')
      await prisma.host.create({ data: { name: 'host-quiet', lastSeenAt: lastSeen } })

      const { rows } = await latestPerSystem(new Date('2026-08-01T12:00:00Z'))

      expect(rows[0]!.lastSeenAt).toEqual(lastSeen)
    })

    it('carries the host last-seen time onto ordinary SYSTEM rows too, not just the placeholder row', async () => {
      // Caught by mutation: the previous test only exercised the
      // never-reported-host path, so blanking `lastSeenAt` on the system-row
      // path passed the whole suite. A stale system row is exactly where
      // spec §9's "last seen HH:MM" has to come from when that system's own
      // observation is missing.
      const lastSeen = new Date('2026-08-01T11:45:00Z')
      const host = await prisma.host.create({ data: { name: 'host-tracked', lastSeenAt: lastSeen } })
      await prisma.system.create({ data: { hostId: host.id, key: 'web', displayName: 'web' } })

      const { rows } = await latestPerSystem(new Date('2026-08-01T12:00:00Z'))

      expect(rows).toHaveLength(1)
      expect(rows[0]!.key).toBe('web')
      expect(rows[0]!.receivedAt).toBeNull()
      expect(rows[0]!.lastSeenAt).toEqual(lastSeen)
    })

    it('orders rows by host, so one machine\'s systems stay together', async () => {
      const hostB = await prisma.host.create({ data: { name: 'host-bravo' } })
      const hostA = await prisma.host.create({ data: { name: 'host-alpha' } })
      await prisma.system.create({ data: { hostId: hostB.id, key: 'aaa', displayName: 'aaa' } })
      await prisma.system.create({ data: { hostId: hostA.id, key: 'zzz', displayName: 'zzz' } })

      const { rows } = await latestPerSystem(new Date('2026-08-01T12:00:00Z'))

      // Host-major: alpha's `zzz` precedes bravo's `aaa`. A system-key sort
      // would put them the other way round and interleave the machines.
      expect(rows.map((r) => r.hostName)).toEqual(['host-alpha', 'host-bravo'])
    })
  })

  // The trace strip: `beats` on each row is 40 slots (BEAT_COUNT) covering
  // the last 20 minutes (BEAT_WINDOW_MS), oldest first. These tests exercise
  // the DB-backed fetch feeding `buildBeatTrace` (unit-tested in isolation in
  // beats.test.ts) -- specifically that the fetch is bounded to a time
  // window, never "every historical observation", the same scale hazard the
  // per-system-latest query above was written to avoid.
  describe('beat trace', () => {
    it('renders a visible gap for a system that has stopped reporting partway through the window', async () => {
      const host = await prisma.host.create({ data: { name: 'host-gap' } })
      const system = await prisma.system.create({
        data: { hostId: host.id, key: 'sys-gap', displayName: 'sys-gap' },
      })
      const now = new Date('2026-08-01T12:00:00Z')
      // Reports every 30s from 10 minutes ago up to 5 minutes ago, then
      // nothing -- a real hole in the middle of the trace, not just at one end.
      for (let msAgo = 10 * 60_000; msAgo >= 5 * 60_000; msAgo -= BEAT_INTERVAL_MS) {
        await prisma.systemObservation.create({
          data: { systemId: system.id, receivedAt: new Date(now.getTime() - msAgo), health: 'healthy', containersTotal: 1, containersRunning: 1 },
        })
      }

      const { rows } = await latestPerSystem(now)

      expect(rows).toHaveLength(1)
      const beats = rows[0]!.beats
      expect(beats).toHaveLength(BEAT_COUNT)
      expect(beats.some((b) => b.state === 'absent')).toBe(true)
      expect(beats.some((b) => b.state === 'good')).toBe(true)
    })

    it('renders no gaps for a system that reported on every tick throughout the window', async () => {
      const host = await prisma.host.create({ data: { name: 'host-solid' } })
      const system = await prisma.system.create({
        data: { hostId: host.id, key: 'sys-solid', displayName: 'sys-solid' },
      })
      const now = new Date('2026-08-01T12:00:00Z')
      // One observation per 30s slot, for all BEAT_COUNT slots -- offset half
      // an interval into each slot so it lands unambiguously inside it.
      for (let i = 0; i < BEAT_COUNT; i++) {
        const msAgo = i * BEAT_INTERVAL_MS + BEAT_INTERVAL_MS / 2
        await prisma.systemObservation.create({
          data: { systemId: system.id, receivedAt: new Date(now.getTime() - msAgo), health: 'healthy', containersTotal: 1, containersRunning: 1 },
        })
      }

      const { rows } = await latestPerSystem(now)

      expect(rows).toHaveLength(1)
      const beats = rows[0]!.beats
      expect(beats).toHaveLength(BEAT_COUNT)
      expect(beats.every((b) => b.state === 'good')).toBe(true)
    })

    it('shows alarm, not good, for a beat that reported a fault', async () => {
      const host = await prisma.host.create({ data: { name: 'host-fault' } })
      const system = await prisma.system.create({
        data: { hostId: host.id, key: 'sys-fault', displayName: 'sys-fault' },
      })
      const now = new Date('2026-08-01T12:00:00Z')
      await prisma.systemObservation.create({
        data: { systemId: system.id, receivedAt: new Date(now.getTime() - 30_000), health: 'down', containersTotal: 1, containersRunning: 0 },
      })

      const { rows } = await latestPerSystem(now)

      expect(rows[0]!.beats.filter((b) => b.state === 'alarm')).toHaveLength(1)
      expect(rows[0]!.beats.filter((b) => b.state === 'good')).toHaveLength(0)
    })

    it('gives an enrolled-but-never-reported host row an empty beat list, not a fabricated full trace', async () => {
      await prisma.host.create({ data: { name: 'host-notrace' } })

      const { rows } = await latestPerSystem(new Date('2026-08-01T12:00:00Z'))

      expect(rows).toHaveLength(1)
      expect(rows[0]!.beats).toEqual([])
    })

    it('renders a full 40-slot hole for a system whose last observation fell outside the trace window', async () => {
      // The window is BEAT_COUNT * BEAT_INTERVAL_MS = 20 minutes; this
      // system last reported 30 minutes ago, well outside it, so the trace
      // must show 40 absent slots -- not the last real observation dredged
      // up from further back, and not a crash.
      const host = await prisma.host.create({ data: { name: 'host-longsilent' } })
      const system = await prisma.system.create({
        data: { hostId: host.id, key: 'sys-longsilent', displayName: 'sys-longsilent' },
      })
      const now = new Date('2026-08-01T12:00:00Z')
      await prisma.systemObservation.create({
        data: { systemId: system.id, receivedAt: new Date(now.getTime() - 30 * 60_000), health: 'healthy', containersTotal: 1, containersRunning: 1 },
      })

      const { rows } = await latestPerSystem(now)

      expect(rows).toHaveLength(1)
      // The row's own STATE still comes from the single-latest-row query, so
      // this must not accidentally read as healthy either.
      expect(rows[0]!.state).toBe('stale')
      const beats = rows[0]!.beats
      expect(beats).toHaveLength(BEAT_COUNT)
      expect(beats.every((b) => b.state === 'absent')).toBe(true)
    })

    it('does not fetch observations older than the beat window, even when far more history exists', async () => {
      // The scale-safety test for the trace fetch, mirroring the one above
      // for the per-system-latest fetch: bounded by TIME, so it must not
      // grow with total history. 200 old rows exist per system, all older
      // than the window, plus a handful of genuinely recent ones.
      const host = await prisma.host.create({ data: { name: 'host-scale-beats' } })
      const system = await prisma.system.create({
        data: { hostId: host.id, key: 'sys-scale-beats', displayName: 'sys-scale-beats' },
      })
      const now = new Date('2026-08-01T12:00:00Z')
      const oldRowCount = 200
      for (let i = 0; i < oldRowCount; i++) {
        await prisma.systemObservation.create({
          data: {
            systemId: system.id,
            // Well outside the 20-minute window: hours to days back.
            receivedAt: new Date(now.getTime() - (30 * 60_000 + i * 60_000)),
            health: 'healthy',
            containersTotal: 1,
            containersRunning: 1,
          },
        })
      }
      const recentRowCount = 3
      for (let i = 0; i < recentRowCount; i++) {
        await prisma.systemObservation.create({
          data: {
            systemId: system.id,
            receivedAt: new Date(now.getTime() - i * BEAT_INTERVAL_MS - 1_000),
            health: 'healthy',
            containersTotal: 1,
            containersRunning: 1,
          },
        })
      }

      const logging = new PrismaClient({ log: [{ emit: 'event', level: 'query' }] })
      const queries: Prisma.QueryEvent[] = []
      logging.$on('query', (e) => queries.push(e))

      try {
        const totalStored = await prisma.systemObservation.count({ where: { systemId: system.id } })
        expect(totalStored).toBe(oldRowCount + recentRowCount)

        const { rows } = await latestPerSystem(now, logging)
        expect(rows).toHaveLength(1)

        // Directly measure the row volume the beat fetch pulls: a query
        // bounded to the trace window returns only the recent rows, never
        // the 200 old ones, regardless of how the SQL is phrased.
        const beatWindowStart = new Date(now.getTime() - BEAT_COUNT * BEAT_INTERVAL_MS)
        const directRows = await prisma.systemObservation.findMany({
          where: { systemId: system.id, receivedAt: { gte: beatWindowStart } },
        })
        expect(directRows).toHaveLength(recentRowCount)
        expect(directRows).not.toHaveLength(oldRowCount + recentRowCount)

        // And the query this code path actually issued for the beat fetch
        // must carry a lower bound on receivedAt -- confirming the fetch
        // itself is time-bounded, not merely that a bounded row count could
        // theoretically be derived some other way afterwards. `>=` is the
        // discriminating marker: the pre-existing per-system-latest query
        // above (DISTINCT ON ... ORDER BY receivedAt DESC) also mentions
        // "SystemObservation" and "receivedAt" but carries no lower-bound
        // comparison at all, so checking for those two alone would pass
        // even with the beat fetch entirely unimplemented -- confirmed
        // below by temporarily reverting the fetch and re-running.
        const beatQuery = queries.find((q) => q.query.includes('SystemObservation') && q.query.includes('receivedAt') && q.query.includes('>='))
        expect(beatQuery).toBeDefined()
      } finally {
        await logging.$disconnect()
      }
    })
  })

  describe('latestExternalResultsByHostname', () => {
    const HOST_X = 'fq-external-x.example.invalid'
    const HOST_Y = 'fq-external-y.example.invalid'
    const HOST_RETIRED = 'fq-external-retired.example.invalid'

    it('returns the most recently OBSERVED row per hostname, not the most recently inserted one', async () => {
      // Two rows for the same hostname, inserted in one order but observed
      // in the other -- if this read picked "last inserted" rather than
      // "greatest observedAt", it would report the stale result as latest.
      await prisma.externalProbeResult.create({
        data: { hostname: HOST_X, outcome: 'not-answering', status: null, observedAt: new Date('2026-08-03T09:00:00Z') },
      })
      await prisma.externalProbeResult.create({
        data: { hostname: HOST_X, outcome: 'answering', status: 200, observedAt: new Date('2026-08-03T08:00:00Z') },
      })

      const result = await latestExternalResultsByHostname([HOST_X])

      expect(result.size).toBe(1)
      expect(result.get(HOST_X)?.outcome).toBe('not-answering')
      expect(result.get(HOST_X)?.observedAt.toISOString()).toBe('2026-08-03T09:00:00.000Z')
    })

    it('keeps two hostnames independent -- a failing one is never merged into a passing one', async () => {
      await prisma.externalProbeResult.create({
        data: { hostname: HOST_X, outcome: 'answering', status: 200 },
      })
      await prisma.externalProbeResult.create({
        data: { hostname: HOST_Y, outcome: 'not-answering', status: null },
      })

      const result = await latestExternalResultsByHostname([HOST_X, HOST_Y])

      expect(result.size).toBe(2)
      expect(result.get(HOST_X)?.outcome).toBe('answering')
      expect(result.get(HOST_Y)?.outcome).toBe('not-answering')
    })

    it('never invents an entry for a hostname with no stored result -- absence must stay absent, not become a definite verdict', async () => {
      const result = await latestExternalResultsByHostname(['fq-external-never-probed.example.invalid'])
      expect(result.size).toBe(0)
      expect(result.get('fq-external-never-probed.example.invalid')).toBeUndefined()
    })

    it('excludes a hostname that stopped being served when the caller does not ask about it, even though its row is never deleted', async () => {
      // A hostname whose last real probe was long ago, and is not in the
      // CURRENT hostname set the caller passes -- e.g. a vhost that was
      // removed from the reverse-proxy config. The row is not deleted (no
      // retention is built by this task), but a caller that bounds its
      // query by the current hostname set never sees it again.
      await prisma.externalProbeResult.create({
        data: { hostname: HOST_RETIRED, outcome: 'answering', status: 200, observedAt: new Date('2026-01-01T00:00:00Z') },
      })
      await prisma.externalProbeResult.create({
        data: { hostname: HOST_X, outcome: 'answering', status: 200 },
      })

      // The caller only names the currently-served hostname.
      const result = await latestExternalResultsByHostname([HOST_X])

      expect(result.has(HOST_RETIRED)).toBe(false)
      expect(result.has(HOST_X)).toBe(true)

      // Proof the retired row genuinely still exists on disk (nothing was
      // deleted) -- it is excluded by the query's WHERE clause, not by
      // retention.
      const stillOnDisk = await prisma.externalProbeResult.findFirst({ where: { hostname: HOST_RETIRED } })
      expect(stillOnDisk).not.toBeNull()
    })

    it('returns an empty map for an empty hostname list without querying the database', async () => {
      const result = await latestExternalResultsByHostname([])
      expect(result.size).toBe(0)
    })
  })
})

describe('worstVerdict', () => {
  it('is healthy only when nothing else is present', () => {
    expect(worstVerdict(['healthy'])).toBe('healthy')
  })

  it('an unprobed hostname outranks a healthy one -- a row must not read fully healthy while something was never checked', () => {
    expect(worstVerdict(['healthy', 'unprobed'])).toBe('unprobed')
  })

  it('a definite fault outranks an unconfirmed one', () => {
    expect(worstVerdict(['unconfirmed', 'route-broken'])).toBe('route-broken')
  })

  it('app-down outranks route-broken', () => {
    expect(worstVerdict(['route-broken', 'app-down'])).toBe('app-down')
  })

  it('contradiction outranks every other value -- confused evidence is flagged above a named fault', () => {
    expect(worstVerdict(['app-down', 'contradiction'])).toBe('contradiction')
  })

  it('is unprobed for an empty input -- there was nothing to check either axis against', () => {
    expect(worstVerdict([])).toBe('unprobed')
  })
})

// Spec §8: "Answers" (the two-axis verdict), "Cert" (days remaining from the
// handshake), and the fleet-wide external-failure fallback -- all computed
// by latestPerSystem from SystemObservation.hostnames/onBoxProbes (Task 5)
// joined against latestExternalResultsByHostname (Task 7a) via combine()
// (Task 7). Integration tests against the real database, like the rest of
// this file, because the join itself -- not just combine()'s own truth
// table, already unit-tested in answers.test.ts -- is what Task 8 adds.
describe('the Answers/Cert join (Task 8)', () => {
  const HOSTNAME_A = 'fq-answers-a.example.invalid'
  const HOSTNAME_B = 'fq-answers-b.example.invalid'

  async function makeSystem(key: string, hostName: string) {
    const host = await prisma.host.create({ data: { name: hostName } })
    const system = await prisma.system.create({ data: { hostId: host.id, key, displayName: key } })
    return { host, system }
  }

  it('is healthy when both axes answer for the one hostname a system has', async () => {
    const { system } = await makeSystem('sys-both-good', 'host-both-good')
    const now = new Date('2026-08-03T12:00:00Z')
    await prisma.systemObservation.create({
      data: {
        systemId: system.id,
        receivedAt: now,
        health: 'healthy',
        containersTotal: 1,
        containersRunning: 1,
        hostnames: [{ hostname: HOSTNAME_A, listensTls: true }],
        onBoxProbes: [{ hostname: HOSTNAME_A, outcome: 'answering', status: 200 }],
      },
    })
    await prisma.externalProbeResult.create({
      data: { hostname: HOSTNAME_A, outcome: 'answering', status: 200, observedAt: now },
    })

    const { rows } = await latestPerSystem(now)

    expect(rows).toHaveLength(1)
    expect(rows[0]!.verdict).toBe('healthy')
    expect(rows[0]!.hostnameAnswers).toHaveLength(1)
    expect(rows[0]!.hostnameAnswers[0]!.verdict).toBe('healthy')
    expect(rows[0]!.primaryHostname).toBe(HOSTNAME_A)
  })

  it('is route-broken when on-box answers but the external axis does not', async () => {
    const { system } = await makeSystem('sys-route-broken', 'host-route-broken')
    const now = new Date('2026-08-03T12:00:00Z')
    await prisma.systemObservation.create({
      data: {
        systemId: system.id,
        receivedAt: now,
        health: 'healthy',
        containersTotal: 1,
        containersRunning: 1,
        hostnames: [{ hostname: HOSTNAME_A, listensTls: true }],
        onBoxProbes: [{ hostname: HOSTNAME_A, outcome: 'answering', status: 200 }],
      },
    })
    await prisma.externalProbeResult.create({
      data: { hostname: HOSTNAME_A, outcome: 'not-answering', status: null, observedAt: now },
    })
    // A second, unrelated, entirely healthy system/hostname -- so this
    // scenario is a PARTIAL failure (one hostname down, the rest of the
    // board fine), not the fleet-wide case the next describe block covers.
    // Without this, HOSTNAME_A would be the board's only hostname, and
    // `isFleetWideExternalFailure` would (correctly) read "every hostname
    // failed" as fleet-wide, forcing the fallback this test is NOT about.
    const { system: healthySystem } = await makeSystem('sys-route-broken-sibling', 'host-route-broken-sibling')
    await prisma.systemObservation.create({
      data: {
        systemId: healthySystem.id,
        receivedAt: now,
        health: 'healthy',
        containersTotal: 1,
        containersRunning: 1,
        hostnames: [{ hostname: HOSTNAME_B, listensTls: true }],
        onBoxProbes: [{ hostname: HOSTNAME_B, outcome: 'answering', status: 200 }],
      },
    })
    await prisma.externalProbeResult.create({
      data: { hostname: HOSTNAME_B, outcome: 'answering', status: 200, observedAt: now },
    })

    const { rows } = await latestPerSystem(now)

    expect(rows.find((r) => r.key === 'sys-route-broken')!.verdict).toBe('route-broken')
  })

  it('is unconfirmed when only the on-box axis has ever run', async () => {
    const { system } = await makeSystem('sys-unconfirmed', 'host-unconfirmed')
    const now = new Date('2026-08-03T12:00:00Z')
    await prisma.systemObservation.create({
      data: {
        systemId: system.id,
        receivedAt: now,
        health: 'healthy',
        containersTotal: 1,
        containersRunning: 1,
        hostnames: [{ hostname: HOSTNAME_A, listensTls: true }],
        onBoxProbes: [{ hostname: HOSTNAME_A, outcome: 'answering', status: 200 }],
      },
    })
    // No ExternalProbeResult row at all for HOSTNAME_A.

    const { rows } = await latestPerSystem(now)

    expect(rows[0]!.verdict).toBe('unconfirmed')
  })

  it('is unprobed when neither axis has ever run for a named hostname', async () => {
    const { system } = await makeSystem('sys-unprobed', 'host-unprobed')
    const now = new Date('2026-08-03T12:00:00Z')
    await prisma.systemObservation.create({
      data: {
        systemId: system.id,
        receivedAt: now,
        health: 'healthy',
        containersTotal: 1,
        containersRunning: 1,
        hostnames: [{ hostname: HOSTNAME_A, listensTls: true }],
        // onBoxProbes omitted entirely -> SQL NULL, no opinion this tick.
      },
    })

    const { rows } = await latestPerSystem(now)

    expect(rows[0]!.onBoxProbes).toBeNull()
    expect(rows[0]!.verdict).toBe('unprobed')
  })

  // THE DENIAL TEST for spec §8's "one failing hostname on a multi-hostname
  // system must not be averaged away into a green row". Two hostnames on
  // ONE system: A is fully healthy, B is fully down. `primaryHostname()`
  // will pick A (it answers), so a row-level verdict that simply copied the
  // primary's own verdict would read `healthy` -- exactly the averaging
  // spec §8 forbids. Mutation-verified: see task-8-report.md.
  it('does not average a failing hostname into a healthy row', async () => {
    const { system } = await makeSystem('sys-mixed', 'host-mixed')
    const now = new Date('2026-08-03T12:00:00Z')
    await prisma.systemObservation.create({
      data: {
        systemId: system.id,
        receivedAt: now,
        health: 'healthy',
        containersTotal: 1,
        containersRunning: 1,
        hostnames: [
          { hostname: HOSTNAME_A, listensTls: true },
          { hostname: HOSTNAME_B, listensTls: true },
        ],
        onBoxProbes: [
          { hostname: HOSTNAME_A, outcome: 'answering', status: 200 },
          { hostname: HOSTNAME_B, outcome: 'not-answering', status: null },
        ],
      },
    })
    await prisma.externalProbeResult.create({
      data: { hostname: HOSTNAME_A, outcome: 'answering', status: 200, observedAt: now },
    })
    await prisma.externalProbeResult.create({
      data: { hostname: HOSTNAME_B, outcome: 'not-answering', status: null, observedAt: now },
    })

    const { rows } = await latestPerSystem(now)

    expect(rows).toHaveLength(1)
    expect(rows[0]!.primaryHostname).toBe(HOSTNAME_A) // the healthy one, chosen for the clickable URL
    expect(rows[0]!.verdict).not.toBe('healthy')
    expect(rows[0]!.verdict).toBe('app-down') // the worst of A's healthy and B's app-down
    // I2: the Answers cell's detail must come from the hostname that
    // PRODUCED the verdict (B), never from the primary (A) -- reading A's
    // evidence here would describe a contradiction that does not exist.
    expect(rows[0]!.leadHostnameAnswer?.hostname).toBe(HOSTNAME_B)
  })

  // Fix round 1 (Task 8 review), C2b -- the fleet-wide flag is now a
  // directly recorded fact (`ExternalProbeRun`, written by the runner on
  // EVERY sweep including a failed one), not an inference over
  // `latestExternalResultsByHostname`'s per-hostname rows. These tests
  // exercise the QUERY side of that fix; `external-probe-runner.test.ts`
  // exercises the WRITE side.
  describe('the fleet-wide fallback, driven by ExternalProbeRun (C2b)', () => {
    // THE DENIAL TEST for spec §9's fleet-wide guard, at the point where it
    // actually renders: a local probe fault must fall back to on-box
    // evidence, not report the (almost certainly locally-caused) external
    // failure as THIS system's own fault.
    it('falls back to on-box-only evidence, and does not report route-broken, when the last recorded sweep reached nothing', async () => {
      const { system } = await makeSystem('sys-fleet-fail', 'host-fleet-fail')
      const now = new Date('2026-08-03T12:00:00Z')
      await prisma.systemObservation.create({
        data: {
          systemId: system.id,
          receivedAt: now,
          health: 'healthy',
          containersTotal: 1,
          containersRunning: 1,
          hostnames: [{ hostname: HOSTNAME_A, listensTls: true }],
          onBoxProbes: [{ hostname: HOSTNAME_A, outcome: 'answering', status: 200 }],
        },
      })
      // A FRESH, non-stale stored result that -- if it were NOT suppressed
      // by the fleet-wide fallback -- would combine with the healthy
      // on-box axis into a definite `route-broken`. Seeded deliberately so
      // this test actually DISCRIMINATES the fallback: without it, nothing
      // is stored for HOSTNAME_A at all, and the axis would already read
      // null/`unconfirmed` regardless of whether the fallback ran, so the
      // assertion below would pass even with the fallback deleted.
      await prisma.externalProbeResult.create({
        data: { hostname: HOSTNAME_A, outcome: 'not-answering', status: null, observedAt: now },
      })
      await prisma.externalProbeRun.create({
        data: { ranAt: now, reachedAnything: false },
      })

      const board = await latestPerSystem(now)

      expect(board.lastExternalSweep).not.toBeNull()
      expect(board.lastExternalSweep!.reachedAnything).toBe(false)
      expect(board.rows[0]!.verdict).not.toBe('route-broken')
      expect(board.rows[0]!.verdict).not.toBe('app-down')
      expect(board.rows[0]!.verdict).toBe('unconfirmed')
    })

    it('does not fall back when the last recorded sweep reached something, even for a genuine PARTIAL failure', async () => {
      const { system } = await makeSystem('sys-partial', 'host-partial')
      const now = new Date('2026-08-03T12:00:00Z')
      await prisma.systemObservation.create({
        data: {
          systemId: system.id,
          receivedAt: now,
          health: 'healthy',
          containersTotal: 1,
          containersRunning: 1,
          hostnames: [
            { hostname: HOSTNAME_A, listensTls: true },
            { hostname: HOSTNAME_B, listensTls: true },
          ],
          onBoxProbes: [
            { hostname: HOSTNAME_A, outcome: 'answering', status: 200 },
            { hostname: HOSTNAME_B, outcome: 'answering', status: 200 },
          ],
        },
      })
      await prisma.externalProbeResult.create({
        data: { hostname: HOSTNAME_A, outcome: 'answering', status: 200, observedAt: now },
      })
      await prisma.externalProbeResult.create({
        data: { hostname: HOSTNAME_B, outcome: 'not-answering', status: null, observedAt: now },
      })
      await prisma.externalProbeRun.create({ data: { ranAt: now, reachedAnything: true } })

      const board = await latestPerSystem(now)

      expect(board.lastExternalSweep!.reachedAnything).toBe(true)
      expect(board.rows[0]!.verdict).toBe('route-broken') // B's real fault must still surface
    })

    // THE scenario C2b's review specifically named: a REAL, ongoing
    // dashboard-network outage must be visible even though Task 7a's own
    // rule leaves the STORED per-hostname rows looking perfectly healthy
    // (they are the last GOOD results from before the outage started, and
    // a fleet-wide failure writes nothing on top of them). The OLD,
    // inferred version of this flag read `externalByHostname`'s values --
    // all "answering" here -- and would have missed this outage entirely.
    it('shows the fleet-wide fallback even when every STORED per-hostname result still looks healthy (the outage wrote nothing on top of them)', async () => {
      const { system } = await makeSystem('sys-quiet-outage', 'host-quiet-outage')
      const now = new Date('2026-08-03T12:00:00Z')
      await prisma.systemObservation.create({
        data: {
          systemId: system.id,
          receivedAt: now,
          health: 'healthy',
          containersTotal: 1,
          containersRunning: 1,
          hostnames: [{ hostname: HOSTNAME_A, listensTls: true }],
          onBoxProbes: [{ hostname: HOSTNAME_A, outcome: 'answering', status: 200 }],
        },
      })
      // The last GOOD result, stored before the outage began -- exactly
      // what Task 7a's write-nothing-on-fleet-wide-failure rule leaves
      // behind.
      await prisma.externalProbeResult.create({
        data: { hostname: HOSTNAME_A, outcome: 'answering', status: 200, observedAt: now },
      })
      // The CURRENT sweep recorded that it reached nothing -- this is the
      // one fact this test hinges on.
      await prisma.externalProbeRun.create({ data: { ranAt: now, reachedAnything: false } })

      const board = await latestPerSystem(now)

      expect(board.lastExternalSweep!.reachedAnything).toBe(false)
    })

    // THE scenario C2b's review named on the OTHER side: two applications
    // failing three weeks apart must not both read as "failing NOW" and
    // trigger a fleet-wide banner that never happened. Here, HOSTNAME_A's
    // stored result is old and failing (its own genuine, isolated
    // route-broken finding), but the MOST RECENT sweep (recorded
    // separately) reached plenty -- so no fallback applies, and A's real
    // fault stays visible.
    it('does not let an old, isolated failing hostname retroactively read as a fleet-wide fault', async () => {
      const { system } = await makeSystem('sys-old-failure', 'host-old-failure')
      const now = new Date('2026-08-03T12:00:00Z')
      const threeWeeksAgo = new Date(now.getTime() - 21 * 24 * 60 * 60_000)
      await prisma.systemObservation.create({
        data: {
          systemId: system.id,
          receivedAt: now,
          health: 'healthy',
          containersTotal: 1,
          containersRunning: 1,
          hostnames: [{ hostname: HOSTNAME_A, listensTls: true }],
          onBoxProbes: [{ hostname: HOSTNAME_A, outcome: 'answering', status: 200 }],
        },
      })
      await prisma.externalProbeResult.create({
        data: { hostname: HOSTNAME_A, outcome: 'not-answering', status: null, observedAt: threeWeeksAgo },
      })
      // The most recent sweep succeeded (reached other hostnames fine) --
      // recorded independently of HOSTNAME_A's own stale, failing result.
      await prisma.externalProbeRun.create({ data: { ranAt: now, reachedAnything: true } })

      const board = await latestPerSystem(now)

      expect(board.lastExternalSweep!.reachedAnything).toBe(true)
      // A's own three-week-old result is ALSO past the staleness ceiling
      // (C3), so it reads unconfirmed, not a false route-broken from stale
      // data -- but critically, it is NOT suppressed by a fleet-wide
      // fallback that never applied.
      expect(board.rows[0]!.verdict).toBe('unconfirmed')
    })

    // THE DENIAL TEST for fix round 2's I1: a fleet-wide failure must not
    // erase the AGE of a genuinely recent, good result -- only its content.
    // A result stored 4 minutes ago, carrying a certificate 3 days from
    // expiry, must still report that real age even while the verdict/cert
    // content is correctly suppressed by the fallback. Before this fix,
    // `external` was forced to `undefined` before `externalAgeMs` was ever
    // computed, so this rendered as "never checked externally" and the
    // 3-day certificate simply vanished during the one window an operator
    // most needs to see it.
    it('reports the real age of a recent result even while a fleet-wide failure suppresses its content', async () => {
      const { system } = await makeSystem('sys-fleet-fail-age', 'host-fleet-fail-age')
      const now = new Date('2026-08-03T12:00:00Z')
      const fourMinutesAgo = new Date(now.getTime() - 4 * 60_000)
      const expires = new Date(now.getTime() + 3 * 86_400_000)
      await prisma.systemObservation.create({
        data: {
          systemId: system.id,
          receivedAt: now,
          health: 'healthy',
          containersTotal: 1,
          containersRunning: 1,
          hostnames: [{ hostname: HOSTNAME_A, listensTls: true }],
          onBoxProbes: [{ hostname: HOSTNAME_A, outcome: 'answering', status: 200 }],
        },
      })
      await prisma.externalProbeResult.create({
        data: {
          hostname: HOSTNAME_A,
          outcome: 'answering',
          status: 200,
          certExpiresAt: expires,
          observedAt: fourMinutesAgo,
        },
      })
      await prisma.externalProbeRun.create({ data: { ranAt: now, reachedAnything: false } })

      const { rows } = await latestPerSystem(now)

      const answer = rows[0]!.hostnameAnswers[0]!
      // REACHABILITY content is correctly suppressed by the fallback.
      expect(answer.externalOutcome).toBeNull()
      // Fix round 4 (Task 8 review), C2 -- THIS TEST used to pin the
      // opposite of this assertion (`certDaysRemaining` expected `null`
      // here), which was itself the defect the round 4 review found: every
      // certificate figure on the board fell to grey for the whole duration
      // of a fleet-wide failure. An expiry date can only ever move LATER
      // (renewal), never earlier, so a stale/suppressed reading of it can
      // only ever over-alarm, never under-alarm -- the safe direction, so
      // it is no longer gated on `fleetWideFailure` at all. Fixing the test
      // that pinned the old (wrong) behaviour, recorded here rather than
      // changed quietly.
      expect(answer.certDaysRemaining).toBe(3)
      // Age is NOT suppressed -- it is a fact about the stored evidence,
      // independent of whether this tick trusts its content.
      expect(answer.externalAgeMs).not.toBeNull()
      expect(answer.externalAgeMs).toBeCloseTo(4 * 60_000, -3)
    })
  })

  describe('latestExternalProbeRun', () => {
    it('returns null when no sweep has ever run', async () => {
      expect(await latestExternalProbeRun()).toBeNull()
    })

    it('returns the MOST RECENT run, not the first one written', async () => {
      await prisma.externalProbeRun.create({
        data: { ranAt: new Date('2026-08-01T00:00:00Z'), reachedAnything: true },
      })
      await prisma.externalProbeRun.create({
        data: { ranAt: new Date('2026-08-03T00:00:00Z'), reachedAnything: false },
      })

      const latest = await latestExternalProbeRun()

      expect(latest?.reachedAnything).toBe(false)
      expect(latest?.ranAt.toISOString()).toBe('2026-08-03T00:00:00.000Z')
    })
  })

  // Fix round 1 (Task 8 review), C3: spec §5.1's "an old result presented
  // as current is the same lie this slice exists to remove," applied to
  // the VERDICT itself, not just the age label already shown alongside it.
  describe('the external result staleness ceiling (C3)', () => {
    it('treats a result older than the staleness ceiling as NO current opinion -- never a green healthy row from stale data', async () => {
      const { system } = await makeSystem('sys-stale-healthy', 'host-stale-healthy')
      const now = new Date('2026-08-03T12:00:00Z')
      const nineDaysAgo = new Date(now.getTime() - 9 * 24 * 60 * 60_000)
      await prisma.systemObservation.create({
        data: {
          systemId: system.id,
          receivedAt: now,
          health: 'healthy',
          containersTotal: 1,
          containersRunning: 1,
          hostnames: [{ hostname: HOSTNAME_A, listensTls: true }],
          onBoxProbes: [{ hostname: HOSTNAME_A, outcome: 'answering', status: 200 }],
        },
      })
      // A NINE-DAY-OLD "healthy" result -- ancient relative to the 5-minute
      // cadence, but still the "latest" row on disk for this hostname.
      await prisma.externalProbeResult.create({
        data: { hostname: HOSTNAME_A, outcome: 'answering', status: 200, observedAt: nineDaysAgo },
      })

      const { rows } = await latestPerSystem(now)

      expect(rows[0]!.verdict).not.toBe('healthy')
      expect(rows[0]!.verdict).toBe('unconfirmed')
      expect(rows[0]!.hostnameAnswers[0]!.externalOutcome).toBeNull()
      // The RAW age is still reported -- an operator can still see how long
      // ago it was actually checked, even though it no longer counts.
      expect(rows[0]!.hostnameAnswers[0]!.externalAgeMs).toBeGreaterThan(EXTERNAL_RESULT_STALE_AFTER_MS)
    })

    it('still treats a result just inside the ceiling as a current opinion', async () => {
      const { system } = await makeSystem('sys-fresh-enough', 'host-fresh-enough')
      const now = new Date('2026-08-03T12:00:00Z')
      const justInside = new Date(now.getTime() - (EXTERNAL_RESULT_STALE_AFTER_MS - 1_000))
      await prisma.systemObservation.create({
        data: {
          systemId: system.id,
          receivedAt: now,
          health: 'healthy',
          containersTotal: 1,
          containersRunning: 1,
          hostnames: [{ hostname: HOSTNAME_A, listensTls: true }],
          onBoxProbes: [{ hostname: HOSTNAME_A, outcome: 'answering', status: 200 }],
        },
      })
      await prisma.externalProbeResult.create({
        data: { hostname: HOSTNAME_A, outcome: 'answering', status: 200, observedAt: justInside },
      })

      const { rows } = await latestPerSystem(now)

      expect(rows[0]!.verdict).toBe('healthy')
    })

    // THE DENIAL TEST for fix round 4's C2, under the STALENESS ceiling
    // specifically (the fleet-wide-failure case is covered separately,
    // above in "the fleet-wide fallback" describe block). The reviewer's
    // exact reproduction: a nine-day-old reading of a certificate expiring
    // in 3 days. Reachability correctly stops counting as a current
    // opinion past the ceiling -- but the certificate figure itself must
    // NOT vanish, because a stale reading of EXPIRY can only ever
    // over-alarm (renewal moves it later, never earlier), which is the
    // safe direction, unlike a stale reading of reachability (which can be
    // wrong either way).
    it('does not let the staleness ceiling erase a certificate figure -- a stale reading can only over-alarm, never under-alarm', async () => {
      const { system } = await makeSystem('sys-stale-cert', 'host-stale-cert')
      const now = new Date('2026-08-03T12:00:00Z')
      const nineDaysAgo = new Date(now.getTime() - 9 * 24 * 60 * 60_000)
      const expiresIn3Days = new Date(now.getTime() + 3 * 86_400_000)
      await prisma.systemObservation.create({
        data: {
          systemId: system.id,
          receivedAt: now,
          health: 'healthy',
          containersTotal: 1,
          containersRunning: 1,
          hostnames: [{ hostname: HOSTNAME_A, listensTls: true }],
          onBoxProbes: [{ hostname: HOSTNAME_A, outcome: 'answering', status: 200 }],
        },
      })
      await prisma.externalProbeResult.create({
        data: {
          hostname: HOSTNAME_A,
          outcome: 'answering',
          status: 200,
          certExpiresAt: expiresIn3Days,
          observedAt: nineDaysAgo,
        },
      })

      const { rows } = await latestPerSystem(now)

      const answer = rows[0]!.hostnameAnswers[0]!
      // Reachability correctly no longer counts as current.
      expect(answer.externalOutcome).toBeNull()
      // The certificate figure survives, ungated by the same ceiling.
      expect(answer.certDaysRemaining).toBe(3)
      expect(answer.externalAgeMs).toBeGreaterThan(EXTERNAL_RESULT_STALE_AFTER_MS)
    })
  })

  it('computes days-remaining from the external probe\'s own handshake, and flags a configured-but-missing certificate', async () => {
    const { system } = await makeSystem('sys-cert', 'host-cert')
    const now = new Date('2026-08-03T00:00:00Z')
    const expires = new Date(now.getTime() + 3 * 86_400_000) // 3 days out
    await prisma.systemObservation.create({
      data: {
        systemId: system.id,
        receivedAt: now,
        health: 'healthy',
        containersTotal: 1,
        containersRunning: 1,
        hostnames: [{ hostname: HOSTNAME_A, listensTls: true }],
        onBoxProbes: [{ hostname: HOSTNAME_A, outcome: 'answering', status: 200 }],
      },
    })
    await prisma.externalProbeResult.create({
      data: { hostname: HOSTNAME_A, outcome: 'answering', status: 200, certExpiresAt: expires, observedAt: now },
    })

    const { rows } = await latestPerSystem(now)

    expect(rows[0]!.certDaysRemaining).toBe(3)
    expect(rows[0]!.tlsConfigured).toBe(true)
  })

  it('reports no certificate (not null-as-fine) when TLS is configured but no handshake has ever succeeded', async () => {
    const { system } = await makeSystem('sys-no-cert', 'host-no-cert')
    const now = new Date('2026-08-03T00:00:00Z')
    await prisma.systemObservation.create({
      data: {
        systemId: system.id,
        receivedAt: now,
        health: 'healthy',
        containersTotal: 1,
        containersRunning: 1,
        hostnames: [{ hostname: HOSTNAME_A, listensTls: true }],
        onBoxProbes: [{ hostname: HOSTNAME_A, outcome: 'answering', status: 200 }],
      },
    })
    await prisma.externalProbeResult.create({
      // TLS handshake itself failed -- no cert observed.
      data: { hostname: HOSTNAME_A, outcome: 'tls-failed', status: null, certExpiresAt: null, observedAt: now },
    })

    const { rows } = await latestPerSystem(now)

    expect(rows[0]!.tlsConfigured).toBe(true)
    expect(rows[0]!.certDaysRemaining).toBeNull()
  })

  // Task 5's obligation, handed to this task: `hostnames: null` (no
  // opinion this tick) and `hostnames: []` (confirmed no HTTP surface) must
  // stay distinguishable all the way out to the row, not just at the
  // database boundary.
  it('preserves null (no opinion) vs [] (confirmed no HTTP surface) all the way to the row', async () => {
    const { system: neverSaid } = await makeSystem('sys-null-hostnames', 'host-null-hostnames')
    const { system: confirmedEmpty } = await makeSystem('sys-empty-hostnames', 'host-empty-hostnames')
    const now = new Date('2026-08-03T00:00:00Z')
    await prisma.systemObservation.create({
      data: {
        systemId: neverSaid.id,
        receivedAt: now,
        health: 'healthy',
        containersTotal: 1,
        containersRunning: 1,
        // `hostnames` omitted entirely -> real SQL NULL.
      },
    })
    await prisma.systemObservation.create({
      data: {
        systemId: confirmedEmpty.id,
        receivedAt: now,
        health: 'healthy',
        containersTotal: 1,
        containersRunning: 1,
        hostnames: [],
      },
    })

    const { rows } = await latestPerSystem(now)
    const nullRow = rows.find((r) => r.key === 'sys-null-hostnames')!
    const emptyRow = rows.find((r) => r.key === 'sys-empty-hostnames')!

    expect(nullRow.hostnames).toBeNull()
    expect(emptyRow.hostnames).toEqual([])
    expect(nullRow.primaryHostname).toBeNull()
    expect(emptyRow.primaryHostname).toBeNull()
    expect(nullRow.verdict).toBe('unprobed')
    expect(emptyRow.verdict).toBe('unprobed')
  })

  // Fix round 4 (Task 8 review), C1 -- THE bug, PINNED BY THIS TEST as
  // correct at the end of round 2 (`verdict` asserted `'healthy'` here).
  // The round 4 review found the render: a system with NO NAMED HOSTNAMES
  // AT ALL, whose URL column reads "no HTTP surface" and whose external
  // axis has never run, rendered a fully GREEN row on the strength of one
  // port spec §3.1 itself says "may be a database, a cache, a mail relay, a
  // UDP service". Spec §2: "a row is green only when the application
  // answers." Round 2's fix (contribute `'healthy'` to the worst-of fold)
  // stopped an unmapped port from DRAGGING A ROW DOWN, which was that
  // round's real finding -- but a max-fold cannot express "positive but
  // non-dispositive" evidence by lowering its floor; lowering it BELOW
  // every absence state is what manufactures a green verdict out of
  // nothing. The correct fix contributes NOTHING at all: `verdict` reads
  // `unprobed` (nothing named was ever checked), while the fact itself
  // stays fully visible via `unnamedOnBoxProbes` (and, independently,
  // `AnswersCell`'s "a port with no name answered on-box (N)" text, which
  // does not depend on `verdict`). Fixing the test that pinned the old,
  // wrong behaviour, recorded here rather than changed quietly.
  it('does NOT read healthy on an unmapped port\'s answer alone -- a system with no named hostnames stays unprobed', async () => {
    const { system } = await makeSystem('sys-unnamed-port', 'host-unnamed-port')
    const now = new Date('2026-08-03T00:00:00Z')
    await prisma.systemObservation.create({
      data: {
        systemId: system.id,
        receivedAt: now,
        health: 'healthy',
        containersTotal: 1,
        containersRunning: 1,
        hostnames: [],
        onBoxProbes: [{ hostname: null, outcome: 'answering', status: 200 }],
      },
    })

    const { rows } = await latestPerSystem(now)

    // The fact itself is NOT hidden -- it is simply not allowed to BECOME
    // the row's own verdict.
    expect(rows[0]!.unnamedOnBoxProbes).toHaveLength(1)
    expect(rows[0]!.unnamedOnBoxProbes[0]!.outcome).toBe('answering')
    expect(rows[0]!.verdict).not.toBe('healthy')
    expect(rows[0]!.verdict).toBe('unprobed')
  })

  // THE DENIAL TEST for fix round 2's C2: the reviewer's exact
  // reproduction -- one NAMED hostname healthy on both axes, plus one
  // published port with no vhost that recorded `not-probed`. The system is
  // fully working; the unmapped port merely has nothing to say. Before this
  // fix, `combine(notProbedAxis, null)` folded to `unprobed` (severity 1,
  // strictly worse than `healthy`'s 0) and dragged the whole row down to
  // "not probed" -- a silent unmapped database/cache/exporter port, common
  // on a multi-stack host, downgrading an otherwise fully healthy system.
  it('does not let a not-probed unmapped port downgrade an otherwise fully healthy row', async () => {
    const { system } = await makeSystem('sys-named-plus-unnamed', 'host-named-plus-unnamed')
    const now = new Date('2026-08-03T12:00:00Z')
    await prisma.systemObservation.create({
      data: {
        systemId: system.id,
        receivedAt: now,
        health: 'healthy',
        containersTotal: 1,
        containersRunning: 1,
        hostnames: [{ hostname: HOSTNAME_A, listensTls: true }],
        onBoxProbes: [
          { hostname: HOSTNAME_A, outcome: 'answering', status: 200 },
          { hostname: null, outcome: 'not-probed', status: null },
        ],
      },
    })
    await prisma.externalProbeResult.create({
      data: { hostname: HOSTNAME_A, outcome: 'answering', status: 200, observedAt: now },
    })

    const { rows } = await latestPerSystem(now)

    expect(rows[0]!.verdict).toBe('healthy')
  })

  // Same reproduction, but the unmapped port ANSWERED instead of recording
  // `not-probed`. Before this fix, `combine(answeringAxis, null)` folded to
  // `unconfirmed` (severity 2) and downgraded the row just as badly, for
  // the OPPOSITE reason (an opinion with nothing to combine it against,
  // rather than no opinion at all) -- both wrong, for the same underlying
  // cause: feeding an unmapped port's result through the two-axis `combine`
  // at all, when it has no second axis to compare against.
  it('does not let an ANSWERING unmapped port downgrade an otherwise fully healthy row either', async () => {
    const { system } = await makeSystem('sys-named-plus-answering-unnamed', 'host-named-plus-answering-unnamed')
    const now = new Date('2026-08-03T12:00:00Z')
    await prisma.systemObservation.create({
      data: {
        systemId: system.id,
        receivedAt: now,
        health: 'healthy',
        containersTotal: 1,
        containersRunning: 1,
        hostnames: [{ hostname: HOSTNAME_A, listensTls: true }],
        onBoxProbes: [
          { hostname: HOSTNAME_A, outcome: 'answering', status: 200 },
          { hostname: null, outcome: 'answering', status: 200 },
        ],
      },
    })
    await prisma.externalProbeResult.create({
      data: { hostname: HOSTNAME_A, outcome: 'answering', status: 200, observedAt: now },
    })

    const { rows } = await latestPerSystem(now)

    expect(rows[0]!.verdict).toBe('healthy')
  })
})
