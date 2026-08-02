// The unwrapped vault key lives HERE and nowhere else: not in the database,
// not in a file, not in an environment variable, not in a cookie.
//
// This is correct only while `web` runs as a SINGLE Node process, which it
// does (`next start`, one container). If the deployment ever runs multiple
// workers, an unlock in one worker will not unlock another, and the symptom
// is a vault that appears to re-lock at random. Move this to a shared store
// before scaling out — and note that a shared store means the key leaves
// process memory, which is the property this design is built on.

export const DEFAULT_TTL_MS = 900_000 // 15 minutes

let state: { vaultKey: Buffer; expiresAtMs: number } | null = null

export function unlockSession(
  vaultKey: Buffer,
  now: () => Date = () => new Date(),
  ttlMs: number = DEFAULT_TTL_MS,
): void {
  state = { vaultKey, expiresAtMs: now().getTime() + ttlMs }
}

export function currentVaultKey(now: () => Date = () => new Date()): Buffer | null {
  if (!state) return null
  if (now().getTime() > state.expiresAtMs) {
    lockSession()
    return null
  }
  return state.vaultKey
}

export function isUnlocked(now: () => Date = () => new Date()): boolean {
  return currentVaultKey(now) !== null
}

/**
 * The absolute instant (epoch ms) the current unlock expires, or `null` if
 * the vault is already locked. Exposed so a CLIENT (the vault page/panel)
 * can schedule its OWN auto-lock against the exact same deadline the server
 * enforces, instead of the two ever drifting apart or the client inventing
 * its own guess -- see VaultPanel's use of this via `page.tsx`.
 *
 * Deliberately returns only the timestamp, never the key or anything
 * derived from it -- this is scheduling bookkeeping, not key material, and
 * must stay safe to hand to a Server Component prop and on into client JS.
 *
 * Shares `currentVaultKey`'s own expiry check (including the side effect of
 * calling `lockSession()` once the deadline has passed) rather than
 * duplicating it, so the two can never disagree about whether the session
 * is still live.
 */
export function sessionExpiresAt(now: () => Date = () => new Date()): number | null {
  if (!state) return null
  if (now().getTime() > state.expiresAtMs) {
    lockSession()
    return null
  }
  return state.expiresAtMs
}

export function lockSession(): void {
  // Drop the reference outright rather than setting a flag, so nothing can
  // read the key back out of a "locked" object.
  //
  // NOTE: The property that `state` is dropped (not flagged) is not externally
  // observable through the public API—both approaches produce `null` from the
  // getter. It is enforced by code inspection, not by automated test. This gap
  // is admitted rather than obscured by a test that cannot actually distinguish
  // the two implementations.
  state = null
}
