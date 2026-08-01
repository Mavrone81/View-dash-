import { describe, it, expect, beforeEach } from 'vitest'
import { prisma } from './db.js'
import { latestPerSystem } from './fleet-query.js'

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
  })

  it('returns an empty list, not an error, when no systems are enrolled', async () => {
    const rows = await latestPerSystem(new Date())
    expect(rows).toEqual([])
  })
})
