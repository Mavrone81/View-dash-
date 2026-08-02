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

export function lockSession(): void {
  // Drop the reference outright rather than setting a flag, so nothing can
  // read the key back out of a "locked" object.
  state = null
}
