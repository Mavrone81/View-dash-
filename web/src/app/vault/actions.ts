'use server'

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

export async function createVaultAction(passphrase: string): Promise<Ok<{ recoveryKey: string }> | Err> {
  if (passphrase.length < MIN_PASSPHRASE_LENGTH) {
    return failed(`Passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters.`)
  }
  if (await isInitialised()) return failed('A vault already exists on this dashboard.')
  const { recoveryKey } = await createVault(passphrase)
  revalidatePath('/vault')
  return { ok: true, recoveryKey }
}

export async function unlockAction(passphrase: string): Promise<Ok<object> | Err> {
  const ok = await unlockWithPassphrase(passphrase)
  if (!ok) return failed('That passphrase did not unlock the vault.')
  revalidatePath('/vault')
  return { ok: true }
}

export async function unlockWithRecoveryAction(display: string): Promise<Ok<object> | Err> {
  const ok = await unlockWithRecoveryKey(display)
  if (!ok) return failed('That recovery key did not unlock the vault.')
  revalidatePath('/vault')
  return { ok: true }
}

export async function lockAction(): Promise<Ok<object>> {
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

export async function removeCredentialAction(id: string): Promise<Ok<object> | Err> {
  try {
    await removeCredential(id)
    revalidatePath('/vault')
    return { ok: true }
  } catch {
    return failed('Could not delete this credential.')
  }
}
