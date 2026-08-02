import { prisma } from '../db.js'
import { newKdfParams, deriveWrappingKey, makeVerifier, checkVerifier, type KdfParams } from './kdf.js'
import { newVaultKey, newRecoveryKey, wrapVaultKey, unwrapVaultKey, recoveryKeyFromDisplay } from './keyring.js'
import { unlockSession, isUnlocked } from './session.js'

const SINGLETON = 'singleton'

// Named so a caller (the server-action layer, specifically) can distinguish
// "a vault already exists" from any other failure with `instanceof`, rather
// than matching on message text. This matters because createVault()'s own
// internal isInitialised() re-check below is a REALISTIC way for the actual
// concurrent-create race to surface: two racing calls both reading "not
// initialised" from the action layer's check, and then the SLOWER one's own
// internal re-check here observing the vault the faster one just created --
// often before either ever reaches the database INSERT that would otherwise
// raise a Prisma unique-constraint error. Without this named type, that path
// throws a plain, unclassifiable Error and the action layer has no way to
// tell it apart from a genuine unknown failure.
export class VaultAlreadyExistsError extends Error {}

/**
 * Refuses to recreate a vault that still holds credentials. Named for the
 * same reason as `VaultAlreadyExistsError`: recreation destroys the wrapped
 * vault key, and with it every sealed secret in the table, so the caller
 * must be able to tell this refusal apart from an unrelated failure by
 * `instanceof` and never by message text.
 */
export class VaultNotEmptyError extends Error {}

/**
 * Refuses to recreate a vault whose recovery key is still good, when the
 * caller has not proved they know the passphrase.
 *
 * An empty vault has nothing to destroy except the one thing recreation
 * always destroys: the vault key, and with it any recovery key already
 * printed and filed. The ordinary sequence is enough to see why that matters
 * — create the vault, print the key, acknowledge it, get called away before
 * storing anything. The vault is now acknowledged, empty and correct, and
 * without this guard anything that can reach the app (these are
 * unauthenticated server actions — see the note at the top of actions.ts)
 * could replace the vault key and leave the printed copy silently dead. The
 * operator would find out the day they needed it, which is precisely the
 * discovery-at-the-worst-moment failure the acknowledgement exists to remove.
 *
 * An unlocked session is accepted as that proof: it can only exist because
 * someone supplied the passphrase or the recovery key.
 */
export class RecoveryKeyStillValidError extends Error {}

async function config() {
  return prisma.vaultConfig.findUnique({ where: { id: SINGLETON } })
}

export async function isInitialised(): Promise<boolean> {
  return (await config()) !== null
}

export type VaultStatus = {
  initialised: boolean
  /**
   * Whether the operator ever confirmed storing the recovery key. `false`
   * for a vault that has none of its own row (there is nothing to
   * acknowledge) AND for one whose `recoveryKeyAcknowledgedAt` is NULL --
   * the two are distinguished by `initialised`, and the caller needs both
   * facts from one read.
   */
  recoveryKeyAcknowledged: boolean
}

/**
 * One read of the singleton row answering both questions the vault page asks
 * of it. Deliberately not two calls: `isInitialised()` followed by a separate
 * acknowledgement read could observe the row in two different states on one
 * page render, and "initialised but we somehow could not read its
 * acknowledgement" is not a state this page should be able to render.
 */
export async function readVaultStatus(): Promise<VaultStatus> {
  const c = await config()
  return {
    initialised: c !== null,
    recoveryKeyAcknowledged: c !== null && c.recoveryKeyAcknowledgedAt !== null,
  }
}

/**
 * Records that the operator confirmed storing the recovery key. Returns
 * `false` when there is no vault to record it against, so the caller reports
 * that rather than a silent success.
 *
 * Idempotent by choice: acknowledging twice keeps the FIRST timestamp. The
 * value answers "when was this confirmed", and a second click (or a retry
 * after a failed write) must not move it forward and quietly rewrite that
 * history.
 */
export async function acknowledgeRecoveryKey(now: Date = new Date()): Promise<boolean> {
  const updated = await prisma.vaultConfig.updateMany({
    where: { id: SINGLETON, recoveryKeyAcknowledgedAt: null },
    data: { recoveryKeyAcknowledgedAt: now },
  })
  if (updated.count > 0) return true
  // Nothing was updated: either there is no vault, or it was already
  // acknowledged. Only the first is a failure.
  return (await config()) !== null
}

export async function createVault(passphrase: string): Promise<{ recoveryKey: string }> {
  if (await isInitialised()) throw new VaultAlreadyExistsError('vault already exists')

  const params = newKdfParams()
  const wrappingKey = deriveWrappingKey(passphrase, params)
  const vaultKey = newVaultKey()
  const recovery = newRecoveryKey()

  await prisma.vaultConfig.create({
    data: {
      id: SINGLETON,
      kdfParams: JSON.stringify(params),
      verifier: makeVerifier(wrappingKey),
      wrappedByPassphrase: wrapVaultKey(vaultKey, wrappingKey, 'passphrase'),
      wrappedByRecovery: wrapVaultKey(vaultKey, recovery.key, 'recovery'),
    },
  })

  unlockSession(vaultKey)
  // Returned once. Nothing stores the printable form; only the wrapping it
  // produced is persisted, and that cannot be reversed without the key.
  return { recoveryKey: recovery.display }
}

/**
 * Throws away the existing vault configuration and builds a new one, with a
 * new vault key and a new recovery key. This is the ONLY route back for a
 * vault whose one-time recovery key was displayed and never stored.
 *
 * It is destructive by construction: the old vault key is unrecoverable
 * afterwards, so every sealed secret in `Credential` would become permanently
 * unreadable. That is why it refuses unless the vault holds ZERO credentials
 * — and why the count is taken INSIDE the transaction that does the
 * replacing, not before it. A check-then-act would leave a window in which a
 * credential is stored between the two, and the destructive half would then
 * proceed against a vault that is no longer empty; this file has already been
 * bitten by that shape twice around `createVault`'s own existence check.
 *
 * Emptiness is necessary and not sufficient. The full rule, enforced here and
 * not by any control the interface does or does not draw:
 *
 *   zero credentials AND (the recovery key was never acknowledged
 *                         OR the session is unlocked)
 *
 *  - **Unacknowledged.** The recovery key is already worthless — nobody ever
 *    confirmed holding a copy — so there is nothing of value to destroy. This
 *    is the remedy path and demands no proof: the operator has a passphrase,
 *    what they lack is a recovery key, so asking for the passphrase would
 *    gate the remedy on the one thing that is not missing.
 *  - **Acknowledged but unlocked.** An unlocked session can only exist
 *    because someone supplied the passphrase or the recovery key, so this is
 *    proof enough. It is also the way out for an operator who acknowledged by
 *    mistake — without it, one wrong click traps them with no recovery key
 *    and no route to a new one.
 *  - **Acknowledged and locked.** Refused. A caller who cannot prove
 *    passphrase knowledge must not be able to invalidate a recovery key that
 *    is currently good.
 *
 * The acknowledgement is read inside the transaction for the same reason as
 * the count: read outside, a concurrent acknowledgement lands between the
 * check and the replacement. The lock state is process memory rather than a
 * row, so it is read at the same instant instead — and through `isUnlocked()`,
 * which applies the session's own expiry, so a session past its deadline
 * reads as locked here exactly as it does everywhere else.
 *
 * When no VaultConfig row exists at all there is nothing to protect and
 * nothing to acknowledge, so this reduces to creating one. That is the same
 * outcome `createVault` would produce, not a way around its guard.
 *
 * WHAT ACTUALLY MAKES THE COUNT MEANINGFUL — and what this comment used to
 * get wrong. It previously claimed that running this transaction and
 * `addCredential`'s both at SERIALIZABLE was the protection. That was
 * reasoning, and a real database disproved it: the interleaving committed
 * BOTH transactions, three times out of three, leaving a credential sealed
 * under the old vault key while this row held the new one — permanently
 * unreadable, with no error anywhere. Postgres SSI aborts on a dangerous
 * structure that needs a CYCLE, and there is none here: this transaction
 * reads `Credential` and writes `VaultConfig`; `addCredential` wrote
 * `Credential` and read nothing this one writes. One rw-edge, no cycle, no
 * abort.
 *
 * The protection is a LOCK on this same singleton row, taken by BOTH sides
 * before either looks at anything: here as the first statement of the
 * transaction, and in `addCredential` as the first statement of its own.
 * That gives the two a row to contend over, which they did not previously
 * have.
 *
 * TAKING IT BEFORE THE COUNT is the whole point, and the first attempt at
 * this fix got it wrong — the lock was added to `addCredential` only, while
 * this function still counted first and locked later (via the DELETE). The
 * interleaving still committed both, because a `SELECT … FOR UPDATE` marks a
 * tuple as locked WITHOUT creating a new version, so a later DELETE of it
 * does not raise "could not serialize access due to concurrent update" even
 * at SERIALIZABLE. Measured, not assumed: the test below still failed with
 * `expected true to be false`. Lock first, then read, or the read is stale
 * before it is taken.
 *
 * With the lock held first by both, the two orderings are:
 *
 *  - This transaction wins the lock: `addCredential` blocks, and when it
 *    resumes the row it was waiting for has been deleted, so its own lock
 *    query returns nothing and it refuses rather than sealing under a dead
 *    key.
 *  - `addCredential` wins: it commits and releases; this transaction then
 *    acquires the lock and its `count()` — a statement that begins AFTER the
 *    lock is held — sees the new credential and refuses with
 *    `VaultNotEmptyError`.
 *
 * Neither ordering depends on an isolation level, which is why this
 * transaction no longer asks for SERIALIZABLE and `addCredential` no longer
 * does either. That was the point of choosing a lock over an extra read: it
 * still holds for a future writer to `Credential` that opens a plain READ
 * COMMITTED transaction, where a serializability argument would silently
 * stop applying. It also removes the spurious-40001 exposure that came with
 * the isolation level.
 *
 * Be precise about what that protects, because the looser reading is how
 * this went wrong twice. The lock covers a future writer to `Credential`
 * THAT TAKES THIS SAME LOCK AS ITS FIRST STATEMENT, at any isolation level.
 * A writer that skips the lock is invisible to the count below exactly as it
 * was under the old mismatched-isolation scheme, and the credential it
 * inserts ends up sealed under a vault key this function has already
 * replaced — unreadable, with no error anywhere. So the coupling was not
 * retired here, it was replaced with a cheaper and more robust one: every
 * write path to `Credential` must take the singleton lock first. That is a
 * standing constraint on new code, and it is on the fast-follow list because
 * nothing enforces it.
 *
 * When there is no config row at all, neither side has anything to lock —
 * and neither needs it, because `addCredential` refuses outright when its
 * own lock query finds no row.
 */
export async function recreateVault(passphrase: string): Promise<{ recoveryKey: string }> {
  const params = newKdfParams()
  const wrappingKey = deriveWrappingKey(passphrase, params)
  const vaultKey = newVaultKey()
  const recovery = newRecoveryKey()

  await prisma.$transaction(
    async (tx) => {
      // FIRST statement, before the count: it both takes the row lock that
      // orders this against `addCredential` and reads the acknowledgement,
      // in one round trip. Order is load-bearing — see the block comment.
      const existing = await tx.$queryRaw<Array<{ recoveryKeyAcknowledgedAt: Date | null }>>`
        SELECT "recoveryKeyAcknowledgedAt" FROM "VaultConfig" WHERE id = ${SINGLETON} FOR UPDATE
      `
      const config = existing[0]
      // Counted only once the lock is held, so no insert can be in flight
      // behind it: any that committed earlier is visible to this statement's
      // snapshot, and any that has not yet started is blocked on the lock.
      const held = await tx.credential.count()
      if (held > 0) throw new VaultNotEmptyError('vault holds credentials')
      if (config !== undefined && config.recoveryKeyAcknowledgedAt !== null && !isUnlocked()) {
        throw new RecoveryKeyStillValidError('recovery key is acknowledged and the vault is locked')
      }
      // deleteMany, not delete: a row with an unexpected id cannot be left
      // behind to collide with the create below. The CHECK constraint makes
      // 'singleton' the only possible id, so this removes exactly the one row.
      await tx.vaultConfig.deleteMany({})
      await tx.vaultConfig.create({
        data: {
          id: SINGLETON,
          kdfParams: JSON.stringify(params),
          verifier: makeVerifier(wrappingKey),
          wrappedByPassphrase: wrapVaultKey(vaultKey, wrappingKey, 'passphrase'),
          wrappedByRecovery: wrapVaultKey(vaultKey, recovery.key, 'recovery'),
          // Explicitly unacknowledged: this key has been shown and not yet
          // stored, which is the whole state this function exists to escape.
          recoveryKeyAcknowledgedAt: null,
        },
      })
    },
  )

  unlockSession(vaultKey)
  return { recoveryKey: recovery.display }
}

export async function unlockWithPassphrase(passphrase: string): Promise<boolean> {
  const c = await config()
  if (!c) return false
  const params = JSON.parse(c.kdfParams) as KdfParams
  const wrappingKey = deriveWrappingKey(passphrase, params)
  if (!checkVerifier(wrappingKey, c.verifier)) return false
  try {
    unlockSession(unwrapVaultKey(c.wrappedByPassphrase, wrappingKey, 'passphrase'))
    return true
  } catch {
    return false
  }
}

export async function unlockWithRecoveryKey(display: string): Promise<boolean> {
  const c = await config()
  if (!c) return false
  try {
    const key = recoveryKeyFromDisplay(display)
    unlockSession(unwrapVaultKey(c.wrappedByRecovery, key, 'recovery'))
    return true
  } catch {
    return false
  }
}

export async function changePassphrase(current: string, next: string): Promise<boolean> {
  const c = await config()
  if (!c) return false
  const oldParams = JSON.parse(c.kdfParams) as KdfParams
  const oldWrapping = deriveWrappingKey(current, oldParams)
  if (!checkVerifier(oldWrapping, c.verifier)) return false

  let vaultKey: Buffer
  try {
    vaultKey = unwrapVaultKey(c.wrappedByPassphrase, oldWrapping, 'passphrase')
  } catch {
    return false
  }

  // Re-wrap the SAME vault key under a new passphrase. Nothing else is
  // touched: every sealed secret stays exactly as it is, so this costs the
  // same whether the vault holds one credential or ten thousand — and the
  // recovery wrapping is untouched, so the printed key keeps working.
  const params = newKdfParams()
  const wrappingKey = deriveWrappingKey(next, params)
  await prisma.vaultConfig.update({
    where: { id: SINGLETON },
    data: {
      kdfParams: JSON.stringify(params),
      verifier: makeVerifier(wrappingKey),
      wrappedByPassphrase: wrapVaultKey(vaultKey, wrappingKey, 'passphrase'),
    },
  })
  return true
}
