import { VaultPanel, type SystemLabel } from '../../components/VaultPanel.js'
import { isInitialised } from '../../lib/vault/vault.js'
import { sessionExpiresAt } from '../../lib/vault/session.js'
import { listCredentials } from '../../lib/vault/credentials.js'
import { prisma } from '../../lib/db.js'

// Load-bearing, not boilerplate (task-8-brief.md Resolution 4): the lock
// state lives in server PROCESS MEMORY (see session.ts's own top-of-file
// note), not the database. Without `force-dynamic`, Next's full-route cache
// could serve a response rendered while the vault was unlocked to a LATER
// request made after the operator locked it again, or after the 15-minute
// TTL silently expired -- showing a locked vault as unlocked purely because
// nothing forced a fresh render. This route must execute on every request.
export const dynamic = 'force-dynamic'

// Next 16: `searchParams` on a server component is a Promise and must be
// awaited before its properties can be read.
type VaultPageSearchParams = Promise<{
  host?: string | string[] | undefined
  system?: string | string[] | undefined
}>

/** A query param can arrive as a string, a string[] (repeated key), or absent. Only the first value is ever meaningful here. */
function firstOrNull(value: string | string[] | undefined): string | null {
  if (value === undefined) return null
  return Array.isArray(value) ? (value[0] ?? null) : value
}

/**
 * Resolves every currently-enrolled `hostId`/`systemKey` pair to its
 * human-readable names, keyed `${hostId}::${systemKey}` -- the same
 * composite `VaultPanel` uses to group credentials. A credential whose pair
 * has no entry here is not an error: systems are discovered and can vanish
 * (a container stops), while `Credential.hostId`/`systemKey` are a loose,
 * non-cascading link by design (see `credentials.ts`) specifically so a
 * credential survives that. `VaultPanel` reads a missing entry as "this
 * credential's system no longer exists" and groups it with the unattached
 * credentials rather than under a heading built from raw ids.
 */
async function resolveSystemLabels(): Promise<Record<string, SystemLabel>> {
  const [hosts, systems] = await Promise.all([prisma.host.findMany(), prisma.system.findMany()])
  const hostNames = new Map(hosts.map((h) => [h.id, h.name]))
  const labels: Record<string, SystemLabel> = {}
  for (const s of systems) {
    const hostName = hostNames.get(s.hostId)
    // Systems cascade-delete with their host (schema: `onDelete: Cascade`),
    // so every System row's hostId is guaranteed to match a Host row from
    // the SAME snapshot read above -- this is defensive, not a case this
    // function expects to hit.
    if (hostName === undefined) continue
    labels[`${s.hostId}::${s.key}`] = { hostName, systemName: s.displayName }
  }
  return labels
}

export default async function VaultPage({ searchParams }: { searchParams: VaultPageSearchParams }) {
  const params = await searchParams
  const focusHostId = firstOrNull(params.host)
  const focusSystemKey = firstOrNull(params.system)

  // `sessionExpiresAt()` is a synchronous read of in-process state (see
  // session.ts) that also tells us whether the vault is unlocked at all
  // (non-null iff unlocked) -- deriving `unlocked` from it rather than
  // calling `isUnlocked()` separately means there is exactly one read of
  // the session state per request, not two that could (in principle, were
  // the function ever changed) disagree. `isInitialised()`, `listCredentials()`
  // and `resolveSystemLabels()` all hit the database, so those three run
  // concurrently.
  const [initialised, credentials, systemLabels] = await Promise.all([
    isInitialised(),
    listCredentials(),
    resolveSystemLabels(),
  ])
  const expiresAt = sessionExpiresAt()
  const unlocked = expiresAt !== null

  return (
    <main>
      <h1>Vault</h1>
      <VaultPanel
        initialised={initialised}
        unlocked={unlocked}
        credentials={credentials}
        focusHostId={focusHostId}
        focusSystemKey={focusSystemKey}
        sessionExpiresAt={expiresAt}
        systemLabels={systemLabels}
      />
    </main>
  )
}
