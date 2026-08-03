import { describe, it, expect, beforeEach } from 'vitest'
import { Prisma } from '@prisma/client'
import { prisma } from './db.js'
import { currentExternalProbeTargets, PROBE_TARGET_RETENTION_MS } from './external-probe-targets.js'

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
    const now = new Date('2026-08-01T10:05:30Z') // shortly after the latest observation below
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

    // Explicit `now`, kept within the retention bound of BOTH rows above
    // (fix round 2 widened it to seven days -- see
    // `PROBE_TARGET_RETENTION_MS`'s own docstring -- so an explicit `now`
    // close to the fixtures is no longer strictly required for THIS test,
    // but is kept anyway so it never depends on the real clock at all,
    // rather than depending on it for a few more years).
    const targets = await currentExternalProbeTargets(prisma, now)

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
    const now = new Date('2026-08-01T09:05:30Z') // shortly after the latest observation below
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

    // Explicit `now`, not the real clock, for the same reason as the test
    // above -- see its comment.
    const targets = await currentExternalProbeTargets(prisma, now)

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

  // THE DENIAL TEST for the final whole-branch review's M2 -- a
  // decommissioned or permanently offline host's LAST observation stays the
  // "latest" row on disk forever (SystemObservation rows are never
  // deleted), so with no age bound this function would keep handing its
  // hostnames to the external prober long after anyone stopped monitoring
  // it: real internet requests against applications nobody watches any
  // more, three of which belong to another business.
  describe('the retention bound (final whole-branch review, M2, revised in fix round 2)', () => {
    it('excludes a system whose latest observation is older than PROBE_TARGET_RETENTION_MS -- a decommissioned host stops being probed on its own', async () => {
      const system = await makeSystem('host-decommissioned', 'sys-decommissioned')
      const now = new Date('2026-08-01T12:00:00Z')
      const longAfter = new Date(now.getTime() - (PROBE_TARGET_RETENTION_MS + 60_000))
      await prisma.systemObservation.create({
        data: {
          systemId: system.id,
          receivedAt: longAfter,
          health: 'healthy',
          containersTotal: 1,
          containersRunning: 1,
          hostnames: [{ hostname: 'decommissioned.example.invalid', listensTls: true }],
        },
      })

      const targets = await currentExternalProbeTargets(prisma, now)

      expect(targets).toEqual([])
    })

    it('still includes a system whose latest observation is just inside the bound', async () => {
      const system = await makeSystem('host-still-alive', 'sys-still-alive')
      const now = new Date('2026-08-01T12:00:00Z')
      const justInside = new Date(now.getTime() - (PROBE_TARGET_RETENTION_MS - 60_000))
      await prisma.systemObservation.create({
        data: {
          systemId: system.id,
          receivedAt: justInside,
          health: 'healthy',
          containersTotal: 1,
          containersRunning: 1,
          hostnames: [{ hostname: 'still-alive.example.invalid', listensTls: true }],
        },
      })

      const targets = await currentExternalProbeTargets(prisma, now)

      expect(targets.map((t) => t.hostname)).toEqual(['still-alive.example.invalid'])
    })

    // THE DENIAL TEST for fix round 2, Important 1 -- the reviewer's own
    // reproduction: an agent silent for a merely ORDINARY outage window
    // (a systemd restart, a transient network blip -- minutes, not days)
    // must NOT stop its hostnames from being probed externally. Fix
    // round 1's version of this bound (90 seconds, borrowed from
    // `ON_BOX_STALE_AFTER_MS`) failed this exact scenario: it inverted C1's
    // own premise by removing the one independent instrument (the external
    // probe) that can confirm or refute whether the host is actually down,
    // precisely when an operator would most want it.
    it('still includes a system whose agent has been silent for two minutes -- an ordinary outage, not a decommissioning', async () => {
      const system = await makeSystem('host-briefly-silent', 'sys-briefly-silent')
      const now = new Date('2026-08-01T12:00:00Z')
      const twoMinutesAgo = new Date(now.getTime() - 2 * 60_000)
      await prisma.systemObservation.create({
        data: {
          systemId: system.id,
          receivedAt: twoMinutesAgo,
          health: 'healthy',
          containersTotal: 1,
          containersRunning: 1,
          hostnames: [{ hostname: 'briefly-silent.example.invalid', listensTls: true }],
        },
      })

      const targets = await currentExternalProbeTargets(prisma, now)

      expect(targets.map((t) => t.hostname)).toEqual(['briefly-silent.example.invalid'])
    })
  })
})
