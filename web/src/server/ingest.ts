import { FleetSnapshotSchema } from '@bevora-ops/shared'
import { Prisma } from '@prisma/client'
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
      // `receivedAt` is deliberately NOT set here. `SystemStateSchema` does
      // not even have a `receivedAt` field, so nothing in `s` could supply
      // one, but the guarantee doesn't rest on that alone: this create()
      // call never references any such value, so there is no code path by
      // which a caller-controlled time could reach this column even if the
      // schema changed. Omitting it lets the column's own DB-level
      // `DEFAULT CURRENT_TIMESTAMP` (see schema.prisma) fill it with the
      // database's clock — the one clock this system does not let an agent
      // touch.
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
          // `s.hostnames`/`s.onBoxProbes` are `undefined` when the AGENT sent
          // no such field at all -- an older agent, or a newer one whose
          // vhost read failed this tick (see shared/src/wire.ts's
          // SystemStateSchema docstrings and agent/src/collect.ts). That
          // must reach the database as SQL NULL, never as `[]`: `Prisma.JsonNull`
          // is Prisma's explicit spelling for "store a JSON null", since a
          // bare `undefined` value on a `create()` field means "omit this
          // key, let the column default apply" -- and there IS no @default
          // here (see the migration), so omitting would ALSO end up NULL
          // today, but relying on that would silently break the instant
          // anyone ever adds one. Writing `Prisma.JsonNull` explicitly says
          // what is meant regardless of the column's default, now or later.
          // When the agent DID send an array (even an empty one, a real
          // "confirmed nothing" fact), it is passed through unchanged.
          hostnames: s.hostnames ?? Prisma.JsonNull,
          onBoxProbes: s.onBoxProbes ?? Prisma.JsonNull,
        },
      })
    }
    await tx.host.update({ where: { id: hostId }, data: { lastSeenAt: new Date() } })
  })

  return { accepted: snapshot.systems.length }
}
