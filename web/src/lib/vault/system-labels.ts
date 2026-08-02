import { prisma } from '../db.js'

/** A resolved, human-readable name for one `hostId`/`systemKey` pair. */
export type SystemLabel = { hostName: string; systemName: string }

/**
 * Resolves every currently-enrolled `hostId`/`systemKey` pair to its
 * human-readable names, keyed `${hostId}::${systemKey}` -- the same
 * composite `VaultPanel` uses to group credentials.
 *
 * A credential's pair with NO entry in the returned map is not an error:
 * systems are discovered and can vanish (a container stops), while
 * `Credential.hostId`/`systemKey` are a loose, non-cascading link BY DESIGN
 * (see `credentials.ts`'s own note, and `credentials.test.ts`'s `'keeps a
 * credential when its linked system disappears'`) specifically so a
 * credential survives that. Callers should read a missing entry as "this
 * credential's system no longer exists", never as corrupt data -- see
 * `VaultPanel`'s `groupBySystem`, which folds such a credential into the
 * unattached bucket rather than rendering a heading built from raw ids.
 */
export async function resolveSystemLabels(): Promise<Record<string, SystemLabel>> {
  const [hosts, systems] = await Promise.all([prisma.host.findMany(), prisma.system.findMany()])
  const hostNames = new Map(hosts.map((h) => [h.id, h.name]))
  const labels: Record<string, SystemLabel> = {}
  for (const s of systems) {
    const hostName = hostNames.get(s.hostId)
    // System.hostId is a real foreign key that cascades on Host delete
    // (schema: `onDelete: Cascade`), so every System row read in the SAME
    // snapshot above is guaranteed to have a matching Host row -- this
    // branch is defensive, not a case this function expects to hit, and is
    // not exercised by any test for exactly that reason (there is no way to
    // construct the row it guards against through the real schema).
    if (hostName === undefined) continue
    labels[`${s.hostId}::${s.key}`] = { hostName, systemName: s.displayName }
  }
  return labels
}
