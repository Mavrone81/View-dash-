import { describe, it, expect, beforeEach } from 'vitest'
import { Prisma } from '@prisma/client'
import { prisma } from './db.js'
import { currentExternalProbeTargets } from './external-probe-targets.js'

// This file touches Host/System/SystemObservation, the same shared tables
// fleet-query.test.ts wipes -- run serially (vitest.config.ts's
// `fileParallelism: false`) so one file's deleteMany never races another's
// create.
beforeEach(async () => {
  await prisma.systemObservation.deleteMany()
  await prisma.system.deleteMany()
  await prisma.host.deleteMany()
})

async function makeSystem(hostName: string, systemKey: string) {
  const host = await prisma.host.create({ data: { name: hostName } })
  return prisma.system.create({ data: { hostId: host.id, key: systemKey, displayName: systemKey } })
}

describe('currentExternalProbeTargets', () => {
  it('returns every hostname from a system\'s latest observation, carrying its own listensTls', async () => {
    const system = await makeSystem('host-1', 'sys-1')
    await prisma.systemObservation.create({
      data: {
        systemId: system.id,
        health: 'healthy',
        containersTotal: 1,
        containersRunning: 1,
        hostnames: [
          { hostname: 'alpha.example.invalid', listensTls: true },
          { hostname: 'beta.example.invalid', listensTls: false },
        ],
      },
    })

    const targets = await currentExternalProbeTargets()

    expect(targets).toHaveLength(2)
    const byHostname = new Map(targets.map((t) => [t.hostname, t.listensTls]))
    expect(byHostname.get('alpha.example.invalid')).toBe(true)
    expect(byHostname.get('beta.example.invalid')).toBe(false)
  })

  // The null-vs-[] distinction Task 5 spent two fix rounds preserving: an
  // observation with hostnames === null is "no opinion this tick", not
  // "confirmed no hostnames". This test is about something more specific
  // than that alone -- it proves this module reads only the LATEST
  // observation per system, so a `null` tick can never let an OLDER,
  // non-null observation for the same system resurface a stale target.
  it('does not resurrect a hostname from an OLDER observation when the latest one has hostnames: null', async () => {
    const system = await makeSystem('host-2', 'sys-2')
    await prisma.systemObservation.create({
      data: {
        systemId: system.id,
        receivedAt: new Date('2026-08-01T10:00:00Z'),
        health: 'healthy',
        containersTotal: 1,
        containersRunning: 1,
        hostnames: [{ hostname: 'stale.example.invalid', listensTls: true }],
      },
    })
    await prisma.systemObservation.create({
      data: {
        systemId: system.id,
        receivedAt: new Date('2026-08-01T10:05:00Z'), // genuinely latest
        health: 'healthy',
        containersTotal: 1,
        containersRunning: 1,
        // A real SQL NULL, matching exactly what `ingest.ts` writes for "no
        // opinion this tick" -- see that file's own comment on
        // `Prisma.DbNull` vs `Prisma.JsonNull` for why this is the one that
        // must be used here, not `undefined` (which Prisma would reject
        // under `exactOptionalPropertyTypes`) or `Prisma.JsonNull` (a JSON
        // scalar null, a different on-disk fact from a real absent column).
        hostnames: Prisma.DbNull,
      },
    })

    const targets = await currentExternalProbeTargets()

    expect(targets.find((t) => t.hostname === 'stale.example.invalid')).toBeUndefined()
  })

  // The other half of the same distinction: a POSITIVE empty array (this
  // tick looked and found nothing) must ALSO produce no targets -- the same
  // outward behaviour as null, even though the two are different facts
  // (see external-probe-targets.ts's own docstring). This test alone cannot
  // discriminate a null/[] mixup on its own, but paired with the test above
  // (which DOES discriminate the "read only the latest row" bug) it pins
  // that this shape is handled without throwing or fabricating an entry.
  it('produces no target for a system whose latest observation confirms an empty hostname list', async () => {
    const system = await makeSystem('host-3', 'sys-3')
    await prisma.systemObservation.create({
      data: {
        systemId: system.id,
        health: 'healthy',
        containersTotal: 1,
        containersRunning: 1,
        hostnames: [],
      },
    })

    const targets = await currentExternalProbeTargets()

    expect(targets).toHaveLength(0)
  })

  it('does not include a hostname a system used to report but no longer does -- bounded by the CURRENT latest observation only', async () => {
    const system = await makeSystem('host-4', 'sys-4')
    await prisma.systemObservation.create({
      data: {
        systemId: system.id,
        receivedAt: new Date('2026-08-01T09:00:00Z'),
        health: 'healthy',
        containersTotal: 1,
        containersRunning: 1,
        hostnames: [{ hostname: 'retired.example.invalid', listensTls: true }],
      },
    })
    await prisma.systemObservation.create({
      data: {
        systemId: system.id,
        receivedAt: new Date('2026-08-01T09:05:00Z'),
        health: 'healthy',
        containersTotal: 1,
        containersRunning: 1,
        hostnames: [{ hostname: 'current.example.invalid', listensTls: true }],
      },
    })

    const targets = await currentExternalProbeTargets()

    expect(targets.map((t) => t.hostname)).toEqual(['current.example.invalid'])
  })

  it('dedupes a hostname reported by two different systems into one target', async () => {
    const systemA = await makeSystem('host-5a', 'sys-5a')
    const systemB = await makeSystem('host-5b', 'sys-5b')
    await prisma.systemObservation.create({
      data: {
        systemId: systemA.id,
        health: 'healthy',
        containersTotal: 1,
        containersRunning: 1,
        hostnames: [{ hostname: 'shared.example.invalid', listensTls: true }],
      },
    })
    await prisma.systemObservation.create({
      data: {
        systemId: systemB.id,
        health: 'healthy',
        containersTotal: 1,
        containersRunning: 1,
        hostnames: [{ hostname: 'shared.example.invalid', listensTls: true }],
      },
    })

    const targets = await currentExternalProbeTargets()

    expect(targets.filter((t) => t.hostname === 'shared.example.invalid')).toHaveLength(1)
  })

  it('carries listensTls: null (undetermined) through unchanged, rather than defaulting it', async () => {
    const system = await makeSystem('host-6', 'sys-6')
    await prisma.systemObservation.create({
      data: {
        systemId: system.id,
        health: 'healthy',
        containersTotal: 1,
        containersRunning: 1,
        hostnames: [{ hostname: 'undetermined.example.invalid', listensTls: null }],
      },
    })

    const targets = await currentExternalProbeTargets()

    expect(targets.find((t) => t.hostname === 'undetermined.example.invalid')?.listensTls).toBeNull()
  })

  it('returns an empty list when there are no systems at all', async () => {
    const targets = await currentExternalProbeTargets()
    expect(targets).toEqual([])
  })
})
