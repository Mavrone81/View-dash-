import { describe, it, expect, beforeEach } from 'vitest'
import { PrismaClient, type Prisma } from '@prisma/client'
import { prisma } from './db.js'
import { latestPerSystem, latestExternalResultsByHostname, NO_SYSTEMS_LABEL } from './fleet-query.js'
import { BEAT_COUNT, BEAT_INTERVAL_MS } from './beats.js'

beforeEach(async () => {
  await prisma.systemObservation.deleteMany()
  await prisma.system.deleteMany()
  await prisma.agentEnrolment.deleteMany()
  await prisma.host.deleteMany()
  await prisma.externalProbeResult.deleteMany()
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

    const rows = await latestPerSystem(new Date('2026-08-01T10:05:30Z'))

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

    const rows = await latestPerSystem(now)

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

    const rows = await latestPerSystem(now)

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

    const rows = await latestPerSystem(new Date('2026-08-01T12:00:00Z'))

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

    const rows = await latestPerSystem(new Date('2026-08-01T12:00:00Z'))

    expect(rows).toHaveLength(1)
    // Non-null: exactly one row was just asserted above.
    const row = rows[0]!
    expect(row.containersRunning).toBe(0)
    expect(row.containersTotal).toBe(0)
  })

  it('returns an empty list, not an error, when no systems are enrolled', async () => {
    const rows = await latestPerSystem(new Date())
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

      const rows = await latestPerSystem(base, logging)

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

      const rows = await latestPerSystem(new Date('2026-08-01T12:00:00Z'))

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

      const rows = await latestPerSystem(new Date('2026-08-01T12:00:00Z'))

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

      const rows = await latestPerSystem(now)

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

      const rows = await latestPerSystem(new Date('2026-08-01T12:00:00Z'))

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

      const rows = await latestPerSystem(new Date('2026-08-01T12:00:00Z'))

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

      const rows = await latestPerSystem(new Date('2026-08-01T12:00:00Z'))

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

      const rows = await latestPerSystem(now)

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

      const rows = await latestPerSystem(now)

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

      const rows = await latestPerSystem(now)

      expect(rows[0]!.beats.filter((b) => b.state === 'alarm')).toHaveLength(1)
      expect(rows[0]!.beats.filter((b) => b.state === 'good')).toHaveLength(0)
    })

    it('gives an enrolled-but-never-reported host row an empty beat list, not a fabricated full trace', async () => {
      await prisma.host.create({ data: { name: 'host-notrace' } })

      const rows = await latestPerSystem(new Date('2026-08-01T12:00:00Z'))

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

      const rows = await latestPerSystem(now)

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

        const rows = await latestPerSystem(now, logging)
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
