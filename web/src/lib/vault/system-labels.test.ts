import { describe, it, expect, beforeEach } from 'vitest'
import { prisma } from '../db.js'
import { resolveSystemLabels } from './system-labels.js'

// Host.name is @unique and nothing in this suite truncates the Host table,
// so a fixture host created with a name another spec file also uses
// collides on a second run -- same trap documented in credentials.test.ts.
// These names are used nowhere else in the repo.
const FIXTURE_HOST_A = 'system-labels-fixture-host-a'
const FIXTURE_HOST_B = 'system-labels-fixture-host-b'

beforeEach(async () => {
  // Cascades to each fixture host's systems (schema: System.hostId
  // `onDelete: Cascade`), so a test that dies midway cannot leave a
  // (hostId, key) row behind to break the next run.
  await prisma.host.deleteMany({ where: { name: { in: [FIXTURE_HOST_A, FIXTURE_HOST_B] } } })
})

describe('resolveSystemLabels', () => {
  it('resolves a real host+system pair to its display names, keyed by hostId::systemKey', async () => {
    const host = await prisma.host.create({ data: { name: FIXTURE_HOST_A } })
    await prisma.system.create({ data: { hostId: host.id, key: 'alpha', displayName: 'Alpha System' } })

    const labels = await resolveSystemLabels()

    expect(labels[`${host.id}::alpha`]).toEqual({ hostName: FIXTURE_HOST_A, systemName: 'Alpha System' })
  })

  it('does not resolve a system key that was never enrolled on that host', async () => {
    const host = await prisma.host.create({ data: { name: FIXTURE_HOST_A } })
    await prisma.system.create({ data: { hostId: host.id, key: 'alpha', displayName: 'Alpha System' } })

    const labels = await resolveSystemLabels()

    // A credential attached to this same host but a DIFFERENT, never-enrolled
    // key must read as unresolvable (VaultPanel folds it into "unattached")
    // -- this is the fixture-level proof behind that design decision.
    expect(labels[`${host.id}::ghost-key`]).toBeUndefined()
  })

  it('keeps two hosts running a same-named system key distinguishable by hostId', async () => {
    const hostA = await prisma.host.create({ data: { name: FIXTURE_HOST_A } })
    const hostB = await prisma.host.create({ data: { name: FIXTURE_HOST_B } })
    // System.key is unique PER HOST, not globally -- two hosts may legally
    // run a system called `web` (see FleetRow.id's own doc comment on the
    // same rule).
    await prisma.system.create({ data: { hostId: hostA.id, key: 'web', displayName: 'Web (A)' } })
    await prisma.system.create({ data: { hostId: hostB.id, key: 'web', displayName: 'Web (B)' } })

    const labels = await resolveSystemLabels()

    expect(labels[`${hostA.id}::web`]).toEqual({ hostName: FIXTURE_HOST_A, systemName: 'Web (A)' })
    expect(labels[`${hostB.id}::web`]).toEqual({ hostName: FIXTURE_HOST_B, systemName: 'Web (B)' })
  })

  it('resolves the CURRENT display name, not a stale one, after a system is renamed', async () => {
    const host = await prisma.host.create({ data: { name: FIXTURE_HOST_A } })
    const system = await prisma.system.create({ data: { hostId: host.id, key: 'alpha', displayName: 'Old Name' } })
    await prisma.system.update({ where: { id: system.id }, data: { displayName: 'New Name' } })

    const labels = await resolveSystemLabels()

    expect(labels[`${host.id}::alpha`]?.systemName).toBe('New Name')
  })
})
