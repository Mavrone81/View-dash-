import { describe, it, expect, beforeEach } from 'vitest'
import { prisma } from '../lib/db.js'
import { enrolAgent } from './auth-agent.js'
import { ingestSnapshot } from './ingest.js'

let hostId: string

const snap = (systems: unknown[]) => ({ collectedAt: '2026-08-01T12:00:00.000Z', systems })
const snapAt = (collectedAt: string, systems: unknown[]) => ({ collectedAt, systems })
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

  // Fix round 1 (clock-skew safety): a compromised OR merely clock-skewed
  // agent must never be able to make its own data look fresh forever.
  // `receivedAt` is the server's own clock and is the only timestamp a
  // staleness calculation may trust; `observedAt` stays as the agent's
  // unclamped claim, useful only for diagnosing skew, never for freshness.
  describe('receivedAt (server time, immune to agent clock)', () => {
    it('is populated on every observation and is close to real server time', async () => {
      const before = Date.now()
      await ingestSnapshot(hostId, snap([sys('alpha')]))
      const after = Date.now()
      const observation = await prisma.systemObservation.findFirstOrThrow()
      const receivedAtMs = observation.receivedAt.getTime()
      // Generous 5s window: this asserts "real server time", not an exact
      // instant — flakiness from test-runner scheduling would be a false
      // failure, but a `receivedAt` genuinely computed from the agent's
      // claimed `collectedAt` (2026-08-01T12:00:00.000Z, far from "now")
      // would blow well past this window and fail correctly.
      expect(receivedAtMs).toBeGreaterThanOrEqual(before - 5000)
      expect(receivedAtMs).toBeLessThanOrEqual(after + 5000)
    })

    it('accepts a collectedAt one hour in the future, and observedAt/receivedAt genuinely diverge', async () => {
      const oneHourFuture = new Date(Date.now() + 60 * 60 * 1000).toISOString()
      const before = Date.now()
      await expect(ingestSnapshot(hostId, snapAt(oneHourFuture, [sys('alpha')]))).resolves.toEqual({ accepted: 1 })
      const observation = await prisma.systemObservation.findFirstOrThrow()
      // observedAt records exactly what the agent claimed, unclamped.
      expect(observation.observedAt.toISOString()).toBe(oneHourFuture)
      // receivedAt records real server time, not the claimed future time —
      // the two diverge by roughly an hour, proving neither one silently
      // overwrote or clamped the other.
      const receivedAtMs = observation.receivedAt.getTime()
      expect(receivedAtMs).toBeGreaterThanOrEqual(before - 5000)
      expect(receivedAtMs).toBeLessThan(new Date(oneHourFuture).getTime() - 5000)
    })

    it('accepts a collectedAt far in the past, and observedAt/receivedAt genuinely diverge', async () => {
      const farPast = '2020-01-01T00:00:00.000Z'
      const before = Date.now()
      await expect(ingestSnapshot(hostId, snapAt(farPast, [sys('alpha')]))).resolves.toEqual({ accepted: 1 })
      const observation = await prisma.systemObservation.findFirstOrThrow()
      expect(observation.observedAt.toISOString()).toBe(farPast)
      const receivedAtMs = observation.receivedAt.getTime()
      expect(receivedAtMs).toBeGreaterThanOrEqual(before - 5000)
      expect(receivedAtMs).toBeGreaterThan(new Date(farPast).getTime() + 5000)
    })

    it('cannot be set by the caller: a receivedAt in the incoming payload does not influence what is stored', async () => {
      const before = Date.now()
      // This extra key is not part of SystemStateSchema at all; it must be
      // stripped/ignored, not threaded through to the stored row.
      await ingestSnapshot(hostId, snap([sys('alpha', { receivedAt: '1999-01-01T00:00:00.000Z' })]))
      const after = Date.now()
      const observation = await prisma.systemObservation.findFirstOrThrow()
      const receivedAtMs = observation.receivedAt.getTime()
      expect(receivedAtMs).toBeGreaterThanOrEqual(before - 5000)
      expect(receivedAtMs).toBeLessThanOrEqual(after + 5000)
    })
  })
})
