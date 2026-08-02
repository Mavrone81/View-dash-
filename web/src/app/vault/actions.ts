'use server'

import { Prisma } from '@prisma/client'
import { createVault, unlockWithPassphrase, unlockWithRecoveryKey, isInitialised } from '../../lib/vault/vault.js'
import { lockSession } from '../../lib/vault/session.js'
import {
  addCredential,
  revealCredential,
  removeCredential,
  VaultLockedError,
  CredentialNotFoundError,
} from '../../lib/vault/credentials.js'
import { revalidatePath } from 'next/cache'

// Every action returns a plain result. Nothing throws to the client, and no
// failure message ever carries the value that failed — error strings are
// where secrets escape.
//
// NOTE (deliberately not fixed in this task — see task-7-report.md
// "Resolution 4"): every exported function below is a Next.js server action,
// which means each one is also a callable HTTP endpoint reachable by
// anything that can reach this app. There is no per-action authentication
// layer here. That is by design for this deployment (SSH-tunnel-only
// reachability, with the vault's own lock as the second control), not an
// oversight — but it means the vault lock is the ONLY thing standing between
// a network caller and `revealAction` returning a plaintext secret.
type Ok<T> = { ok: true } & T
type Err = { ok: false; message: string }

const failed = (message: string): Err => ({ ok: false, message })

const MIN_PASSPHRASE_LENGTH = 12

// Shared wording for "there is nothing usable to unlock". A VaultConfig row
// can be absent (no vault ever created) or present-but-corrupt (e.g. a
// hand-edited or truncated kdfParams column); either way, retyping a
// passphrase will never succeed, so this is reported as its own fact rather
// than folded into "wrong passphrase" — design spec section 9.
const NOT_INITIALISED_MESSAGE = 'This dashboard does not have a usable vault. Create one, or use the recovery key if one was created before.'
// Used only from the passphrase path: a corrupt VaultConfig means the
// passphrase route can never work, so the advice steers toward the
// recovery key specifically (unlike NOT_INITIALISED_MESSAGE, which covers
// "no vault at all" too and so can't promise a recovery key exists).
const CONFIG_UNREADABLE_MESSAGE = 'The stored vault configuration could not be read and may be corrupt. A passphrase cannot unlock it; try the recovery key.'
// Used from the recovery path's own corrupt-config catch: recommending the
// recovery key here would be circular, since that is what the caller is
// already using.
const CONFIG_UNREADABLE_RECOVERY_MESSAGE = 'The stored vault configuration could not be read and may be corrupt.'
// isInitialised() is a bare database read (`prisma.vaultConfig.findUnique`).
// If the database itself is unreachable or times out, that call rejects —
// and "we cannot currently tell whether a vault exists" is a DIFFERENT fact
// from "no vault has been created yet". Folding the two together would
// invite an operator to create a new vault over one that is merely
// temporarily unreachable, which is exactly how a dashboard ends up with
// two vaults fighting over the same singleton row. Kept as its own message
// in every action that calls isInitialised().
const DATABASE_UNAVAILABLE_MESSAGE = 'Could not reach the vault database right now. This is a connectivity problem, not evidence that no vault exists — do not create a new one; try again shortly.'

export async function createVaultAction(passphrase: string): Promise<{ ok: true; recoveryKey: string } | Err> {
  if (passphrase.length < MIN_PASSPHRASE_LENGTH) {
    return failed(`Passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters.`)
  }
  let alreadyExists: boolean
  try {
    alreadyExists = await isInitialised()
  } catch {
    return failed(DATABASE_UNAVAILABLE_MESSAGE)
  }
  if (alreadyExists) return failed('A vault already exists on this dashboard.')
  try {
    const { recoveryKey } = await createVault(passphrase)
    revalidatePath('/vault')
    return { ok: true, recoveryKey }
  } catch {
    // The isInitialised() check above and createVault()'s own write are two
    // separate round trips, so a second concurrent call can pass the check
    // before either finishes — the database's singleton constraint on
    // VaultConfig (see the migration CHECK, and vault.ts's own internal
    // isInitialised() re-check) is what actually stops the second write,
    // and it throws when that race is lost. The caught error's own message
    // is discarded on purpose rather than surfaced: a rejected insert can
    // echo back fragments of the row it tried to write.
    return failed('A vault already exists on this dashboard.')
  }
}

export async function unlockAction(passphrase: string): Promise<{ ok: true } | Err> {
  let initialised: boolean
  try {
    initialised = await isInitialised()
  } catch {
    return failed(DATABASE_UNAVAILABLE_MESSAGE)
  }
  if (!initialised) return failed(NOT_INITIALISED_MESSAGE)
  let ok: boolean
  try {
    ok = await unlockWithPassphrase(passphrase)
  } catch {
    // unlockWithPassphrase JSON.parses the stored kdfParams; a corrupt value
    // throws a raw SyntaxError rather than returning false. That is not a
    // wrong-passphrase outcome — no passphrase will ever parse corrupt JSON
    // — so it gets its own message, and the parse error's own text (which
    // can contain a fragment of the corrupt value) is never surfaced.
    return failed(CONFIG_UNREADABLE_MESSAGE)
  }
  if (!ok) return failed('That passphrase did not unlock the vault.')
  revalidatePath('/vault')
  return { ok: true }
}

export async function unlockWithRecoveryAction(display: string): Promise<{ ok: true } | Err> {
  let initialised: boolean
  try {
    initialised = await isInitialised()
  } catch {
    return failed(DATABASE_UNAVAILABLE_MESSAGE)
  }
  if (!initialised) return failed(NOT_INITIALISED_MESSAGE)
  let ok: boolean
  try {
    ok = await unlockWithRecoveryKey(display)
  } catch {
    // unlockWithRecoveryKey does not currently read kdfParams, so this branch
    // is not reachable through the same corruption that breaks unlockAction
    // above — it guards this action against a throw from ANY future change
    // to that function, consistent with the invariant every other action in
    // this file follows: nothing here throws to the client.
    return failed(CONFIG_UNREADABLE_RECOVERY_MESSAGE)
  }
  if (!ok) return failed('That recovery key did not unlock the vault.')
  revalidatePath('/vault')
  return { ok: true }
}

export async function lockAction(): Promise<{ ok: true }> {
  lockSession()
  revalidatePath('/vault')
  return { ok: true }
}

export async function addCredentialAction(input: {
  label: string; username: string; secret: string
  notes?: string; hostId?: string; systemKey?: string
}): Promise<Ok<{ id: string }> | Err> {
  try {
    const id = await addCredential(input)
    revalidatePath('/vault')
    return { ok: true, id }
  } catch (err) {
    if (err instanceof VaultLockedError) {
      return failed('The vault is locked. Unlock it and try again.')
    }
    return failed('Could not save the credential.')
  }
}

// Three distinct failure facts, each with its own advice — collapsing them
// into one message either hides that unlocking won't help (a missing
// credential) or actively misdirects away from a security event (a failed
// GCM tag check on a tampered or moved ciphertext). See task-7-brief.md
// Resolution 1.
export async function revealAction(id: string): Promise<Ok<{ secret: string }> | Err> {
  try {
    return { ok: true, secret: await revealCredential(id) }
  } catch (err) {
    if (err instanceof VaultLockedError) {
      return failed('The vault is locked. Unlock it to reveal this credential.')
    }
    if (err instanceof CredentialNotFoundError) {
      return failed('This credential no longer exists.')
    }
    // Anything else — including a GCM authentication failure from open(), the
    // tamper/moved-ciphertext case the AAD binding defends against — falls
    // through here. This is a decrypt failure, not a missing value: show it
    // as unreadable, never as an empty field, and never suggest unlocking
    // again since the vault is already unlocked at this point.
    return failed('This credential could not be decrypted and is unreadable. This may indicate the stored data was altered or corrupted.')
  }
}

export async function removeCredentialAction(id: string): Promise<{ ok: true } | Err> {
  try {
    await removeCredential(id)
    revalidatePath('/vault')
    return { ok: true }
  } catch (err) {
    // Prisma's delete throws P2025 ("Record to delete does not exist") when
    // the id is already gone — a distinguishable, non-alarming fact (the
    // caller's goal, "this credential should not exist", is already true)
    // from any other delete failure (e.g. the database rejecting the
    // statement itself), which is worth flagging as failed rather than as
    // a no-op success.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
      return failed('This credential no longer exists.')
    }
    return failed('Could not delete this credential.')
  }
}
