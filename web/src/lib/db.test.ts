import { describe, it, expect, beforeEach } from 'vitest'
import { prisma } from './db.js'

beforeEach(async () => {
  await prisma.systemObservation.deleteMany()
  await prisma.system.deleteMany()
  await prisma.agentEnrolment.deleteMany()
  await prisma.host.deleteMany()
})

describe('schema', () => {
  it('stores an observation against a system on a host', async () => {
    const host = await prisma.host.create({ data: { name: 'host-a' } })
    const system = await prisma.system.create({ data: { hostId: host.id, key: 'proj-a', displayName: 'proj-a' } })
    await prisma.systemObservation.create({
      data: { systemId: system.id, health: 'healthy', containersTotal: 3, containersRunning: 3,
              deployedSha: 'a'.repeat(40), deployedSubject: 'fix: x', deployedAt: new Date(), driftCommits: 0 },
    })
    const found = await prisma.system.findFirstOrThrow({
      where: { key: 'proj-a' }, include: { observations: true },
    })
    // Non-null: the observation was just created against this system above.
    expect(found.observations[0]!.health).toBe('healthy')
  })

  it('refuses two systems with the same key on one host', async () => {
    const host = await prisma.host.create({ data: { name: 'host-b' } })
    await prisma.system.create({ data: { hostId: host.id, key: 'dup', displayName: 'dup' } })
    await expect(
      prisma.system.create({ data: { hostId: host.id, key: 'dup', displayName: 'dup' } }),
    ).rejects.toThrow()
  })

  it('allows the same key on two different hosts', async () => {
    const h1 = await prisma.host.create({ data: { name: 'host-c' } })
    const h2 = await prisma.host.create({ data: { name: 'host-d' } })
    await prisma.system.create({ data: { hostId: h1.id, key: 'same', displayName: 'same' } })
    await expect(
      prisma.system.create({ data: { hostId: h2.id, key: 'same', displayName: 'same' } }),
    ).resolves.toBeTruthy()
  })
})
