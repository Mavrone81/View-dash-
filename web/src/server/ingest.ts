import { FleetSnapshotSchema } from '@bevora-ops/shared'
import { prisma } from '../lib/db.js'

/**
 * Persists one agent snapshot: creates a `System` row the first time a
 * (hostId, key) pair is seen, and always appends a `SystemObservation`.
 *
 * All-or-nothing by construction, in two layers:
 *  1. The ENTIRE raw payload is validated against `FleetSnapshotSchema`
 *     before any database call is made. A snapshot with one invalid system
 *     among several valid ones must not produce a half-written board state
 *     that never existed on the real host, so validation happens up front,
 *     not per-system inside the loop.
 *  2. All writes (system upserts, observation inserts, and the host's
 *     `lastSeenAt` bump) happen inside a single `$transaction`, so a
 *     failure partway through (e.g. a database error on system N) rolls
 *     back everything already written for this snapshot too.
 */
export async function ingestSnapshot(hostId: string, raw: unknown): Promise<{ accepted: number }> {
  // Validate before writing anything: `.parse` throws on the first schema
  // violation, and it does so before any Prisma call has been issued.
  const snapshot = FleetSnapshotSchema.parse(raw)

  await prisma.$transaction(async (tx) => {
    for (const s of snapshot.systems) {
      // Unique on (hostId, key): re-seeing a system reuses its row (and
      // refreshes displayName) instead of creating a duplicate. Two hosts
      // running a same-named system get two independent rows because the
      // uniqueness is scoped to hostId, not global.
      const system = await tx.system.upsert({
        where: { hostId_key: { hostId, key: s.key } },
        create: { hostId, key: s.key, displayName: s.displayName },
        update: { displayName: s.displayName },
      })
      await tx.systemObservation.create({
        data: {
          systemId: system.id,
          observedAt: new Date(snapshot.collectedAt),
          health: s.health,
          containersTotal: s.containers.total,
          containersRunning: s.containers.running,
          deployedSha: s.deployedSha,
          deployedSubject: s.deployedSubject,
          deployedAt: s.deployedAt ? new Date(s.deployedAt) : null,
          driftCommits: s.driftCommits,
        },
      })
    }
    await tx.host.update({ where: { id: hostId }, data: { lastSeenAt: new Date() } })
  })

  return { accepted: snapshot.systems.length }
}
