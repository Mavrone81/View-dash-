import { describe, it, expect, beforeEach } from 'vitest'
import { prisma } from '../lib/db.js'
import { enrolAgent } from './auth-agent.js'
import { ingestSnapshot } from './ingest.js'

let hostId: string

const snap = (systems: unknown[]) => ({ collectedAt: '2026-08-01T12:00:00.000Z', systems })
const sys = (key: string, over: Record<string, unknown> = {}) => ({
  key, displayName: key, health: 'healthy', containers: { total: 1, running: 1 },
  deployedSha: 'a'.repeat(40), deployedSubject: 'feat: x', deployedAt: '2026-08-01T10:00:00.000Z',
  driftCommits: 0, ...over,
})

beforeEach(async () => {
  await prisma.systemObservation.deleteMany()
  await prisma.system.deleteMany()
  await prisma.agentEnrolment.deleteMany()
  await prisma.host.deleteMany()
  hostId = (await enrolAgent('host-a')).hostId
})

describe('ingestSnapshot', () => {
  it('creates systems it has not seen before', async () => {
    const r = await ingestSnapshot(hostId, snap([sys('alpha'), sys('beta')]))
    expect(r.accepted).toBe(2)
    expect(await prisma.system.count()).toBe(2)
  })

  it('reuses the existing system on a second snapshot', async () => {
    await ingestSnapshot(hostId, snap([sys('alpha')]))
    await ingestSnapshot(hostId, snap([sys('alpha', { health: 'degraded' })]))
    expect(await prisma.system.count()).toBe(1)
    expect(await prisma.systemObservation.count()).toBe(2)
  })

  it('rejects a snapshot that does not match the wire schema', async () => {
    await expect(ingestSnapshot(hostId, snap([sys('alpha', { health: 'green' })]))).rejects.toThrow()
    expect(await prisma.system.count()).toBe(0)
  })

  it('updates the host lastSeenAt', async () => {
    await ingestSnapshot(hostId, snap([sys('alpha')]))
    const host = await prisma.host.findUniqueOrThrow({ where: { id: hostId } })
    expect(host.lastSeenAt).not.toBeNull()
  })

  it('writes nothing at all when one system in the batch is invalid', async () => {
    await expect(ingestSnapshot(hostId, snap([sys('good'), sys('bad', { containers: null })]))).rejects.toThrow()
    expect(await prisma.system.count()).toBe(0)
    expect(await prisma.systemObservation.count()).toBe(0)
  })

  // Two hosts may each run a system named the same key; System is unique on
  // (hostId, key), not on key alone, so seeing 'alpha' from a second host
  // must create a second System row, not collide with the first host's.
  it('creates a distinct system row per host for the same key', async () => {
    const otherHostId = (await enrolAgent('host-b')).hostId
    await ingestSnapshot(hostId, snap([sys('alpha')]))
    await ingestSnapshot(otherHostId, snap([sys('alpha')]))
    expect(await prisma.system.count()).toBe(2)
  })

  it('does not update host.lastSeenAt when the snapshot is rejected', async () => {
    const before = await prisma.host.findUniqueOrThrow({ where: { id: hostId } })
    expect(before.lastSeenAt).toBeNull()
    await expect(ingestSnapshot(hostId, snap([sys('alpha', { health: 'green' })]))).rejects.toThrow()
    const after = await prisma.host.findUniqueOrThrow({ where: { id: hostId } })
    expect(after.lastSeenAt).toBeNull()
  })
})
