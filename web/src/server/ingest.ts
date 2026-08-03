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
          // must reach the database as a real SQL NULL, never as the JSON
          // value `null`, and never as `[]`.
          //
          // FIX ROUND 1's Important: this used to write `Prisma.JsonNull`,
          // which is Prisma's spelling for "store the JSON SCALAR `null`"
          // (`hostnames::text` becomes the three characters `null`, and
          // `hostnames IS NULL` is FALSE) -- verified live against the test
          // database, not assumed. `Prisma.DbNull` is the one that produces
          // an actual SQL NULL column value. The two are indistinguishable
          // from the Prisma CLIENT (both read back as JS `null`), which is
          // why the tests passed under the wrong one -- but they are NOT
          // indistinguishable in the database, and this task's OWN
          // no-opinion guarantee depends on which one is there: every
          // pre-migration row and every row written by code that predates
          // this column is a real SQL NULL, so a query like `WHERE
          // hostnames IS NOT NULL` (or Prisma's `{ not: Prisma.DbNull }`)
          // would have silently EXCLUDED every no-opinion row written by
          // THIS code (JSON `null`) while including the pre-migration ones
          // (SQL NULL) -- the identical wire-level conflation this task
          // exists to prevent, reintroduced one layer down, in the one
          // column meant to prevent it.
          //
          // When the agent DID send an array (even an empty one, a real
          // "confirmed nothing" fact), it is passed through unchanged.
          hostnames: s.hostnames ?? Prisma.DbNull,
          onBoxProbes: s.onBoxProbes ?? Prisma.DbNull,
        },
      })
    }
    await tx.host.update({ where: { id: hostId }, data: { lastSeenAt: new Date() } })
  })

  return { accepted: snapshot.systems.length }
}
