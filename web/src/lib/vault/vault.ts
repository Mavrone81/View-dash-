import { Prisma } from '@prisma/client'
import { prisma } from '../db.js'
import { newKdfParams, deriveWrappingKey, makeVerifier, checkVerifier, type KdfParams } from './kdf.js'
import { newVaultKey, newRecoveryKey, wrapVaultKey, unwrapVaultKey, recoveryKeyFromDisplay } from './keyring.js'
import { unlockSession } from './session.js'

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
 * The transaction runs at SERIALIZABLE, which is what makes the count
 * meaningful rather than decorative: a plain `count()` under READ COMMITTED
 * does not lock the rows it did not find, so a concurrent INSERT could still
 * commit underneath it. `addCredential` runs at the same level for the same
 * reason — Postgres's serializable checks only apply between transactions
 * that are BOTH serializable, so one of the pair opting out would silently
 * remove the guarantee from both.
 */
export async function recreateVault(passphrase: string): Promise<{ recoveryKey: string }> {
  const params = newKdfParams()
  const wrappingKey = deriveWrappingKey(passphrase, params)
  const vaultKey = newVaultKey()
  const recovery = newRecoveryKey()

  await prisma.$transaction(
    async (tx) => {
      const held = await tx.credential.count()
      if (held > 0) throw new VaultNotEmptyError('vault holds credentials')
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
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
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
