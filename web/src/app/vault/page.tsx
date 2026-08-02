import { VaultPanel } from '../../components/VaultPanel.js'
import { isInitialised } from '../../lib/vault/vault.js'
import { remainingSessionMs } from '../../lib/vault/session.js'
import { listCredentials } from '../../lib/vault/credentials.js'
import { resolveSystemLabels } from '../../lib/vault/system-labels.js'

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

export default async function VaultPage({ searchParams }: { searchParams: VaultPageSearchParams }) {
  const params = await searchParams
  const focusHostId = firstOrNull(params.host)
  const focusSystemKey = firstOrNull(params.system)

  // `remainingSessionMs()` is a synchronous read of in-process state (see
  // session.ts) that also tells us whether the vault is unlocked at all
  // (non-null iff unlocked) -- deriving `unlocked` from it rather than
  // calling `isUnlocked()` separately means there is exactly one read of
  // the session state per request, not two that could (in principle, were
  // the function ever changed) disagree. It returns a DURATION, not the
  // absolute epoch instant an earlier version of this page passed down (fix
  // round 2) -- see session.ts's own doc comment on why a duration is safer
  // to hand to a client. `isInitialised()`, `listCredentials()` and
  // `resolveSystemLabels()` all hit the database, so those three run
  // concurrently.
  const [initialised, credentials, systemLabels] = await Promise.all([
    isInitialised(),
    listCredentials(),
    resolveSystemLabels(),
  ])
  const sessionRemainingMs = remainingSessionMs()
  const unlocked = sessionRemainingMs !== null

  return (
    <main>
      <h1>Vault</h1>
      <VaultPanel
        initialised={initialised}
        unlocked={unlocked}
        credentials={credentials}
        focusHostId={focusHostId}
        focusSystemKey={focusSystemKey}
        sessionRemainingMs={sessionRemainingMs}
        systemLabels={systemLabels}
      />
    </main>
  )
}
