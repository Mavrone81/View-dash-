import { describe, it, expect, beforeEach } from 'vitest'
import { PrismaClient, type Prisma } from '@prisma/client'
import { prisma } from './db.js'
import { latestPerSystem, NO_SYSTEMS_LABEL } from './fleet-query.js'

beforeEach(async () => {
  await prisma.systemObservation.deleteMany()
  await prisma.system.deleteMany()
  await prisma.agentEnrolment.deleteMany()
  await prisma.host.deleteMany()
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
})
