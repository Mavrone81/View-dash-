'use server'

import { Prisma } from '@prisma/client'
import {
  createVault,
  unlockWithPassphrase,
  unlockWithRecoveryKey,
  changePassphrase,
  acknowledgeRecoveryKey,
  recreateVault,
  isInitialised,
  VaultAlreadyExistsError,
  VaultNotEmptyError,
  RecoveryKeyStillValidError,
} from '../../lib/vault/vault.js'
import { KdfParamsError } from '../../lib/vault/kdf.js'
import { lockSession, remainingSessionMs, DEFAULT_TTL_MS } from '../../lib/vault/session.js'
import {
  addCredential,
  revealCredential,
  removeCredential,
  VaultLockedError,
  CredentialNotFoundError,
  CredentialDecryptError,
  RecoveryKeyUnacknowledgedError,
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

// fix round 2: every action that leaves the vault unlocked (createVaultAction,
// unlockAction, unlockWithRecoveryAction) hands the client a DURATION --
// "N ms remain" -- rather than the absolute epoch instant a prior version of
// this file's caller (VaultPanel, via page.tsx) used. The reason is the same
// one documented on session.ts's `remainingSessionMs`: a client whose clock
// disagrees with the server's would misjudge an absolute deadline for the
// whole session, in either direction. Returning it directly from the action
// that JUST unlocked the vault also closes a real window: without this, a
// secret revealed immediately after a client-driven unlock (before Next's
// next server render delivers a fresh `page.tsx`-computed value) would have
// no deadline to schedule against at all.
//
// `remainingSessionMs()` is called on the SAME call stack as the
// `unlockSession()` call that just set the state it reads (inside
// createVault/unlockWithPassphrase/unlockWithRecoveryKey in vault.ts), so
// null here should be unreachable.
//
// It nevertheless falls back to 0, not to DEFAULT_TTL_MS. The tempting
// argument for DEFAULT_TTL_MS is that every call site unlocks without
// overriding `ttlMs`, so it is the value that was just used — true today,
// and still the wrong default. null means "no session is open", so the one
// state in which this branch can be reached is the state in which the
// server considers the vault LOCKED. Handing the client a fresh fifteen
// minutes there would put the panel into exactly the failure this whole
// round exists to remove: a screen presenting itself as unlocked, holding a
// secret, while the server refuses every reveal behind it. 0 makes the
// panel clear and re-lock immediately, which is self-correcting and honest.
//
// Deliberately untested: the branch is unreachable, so any test asserting
// it would have to fake the unreachable state and would prove only that the
// fake was wired up. Recorded as a reasoned choice rather than covered by a
// test that cannot fail for the reason it names.
function sessionDurationForClient(): number {
  return remainingSessionMs() ?? 0
}

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
// For a failure this file cannot positively identify at all: neither a
// parse failure nor a recognised connectivity error. Naming a cause without
// evidence is the defect this branch exists to avoid — an unattributed
// failure is honest, a misattributed one is not.
const UNLOCK_FAILED_MESSAGE = 'The vault could not be unlocked right now. Try again in a moment.'

// Identifies a database connectivity failure by Prisma's own error TYPES,
// not by matching error message text (text is version-fragile and can
// legitimately vary). PrismaClientInitializationError is what Prisma throws
// when it cannot establish a connection at all; P1001 ("can't reach
// database server") and P1017 ("server has closed the connection") are the
// two PrismaClientKnownRequestError codes for a connection that was reachable
// at some point but isn't now. Anything else — including other
// PrismaClientKnownRequestError codes — is NOT classified as connectivity;
// guessing here is exactly what this function exists to refuse to do.
function isDatabaseConnectivityError(err: unknown): boolean {
  if (err instanceof Prisma.PrismaClientInitializationError) return true
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    return err.code === 'P1001' || err.code === 'P1017'
  }
  return false
}

// Only claims a corrupt VaultConfig when the evidence actually says so. Two
// error types positively identify that, and they cover the two ways the
// stored config is unusable:
//
//  - `SyntaxError` — the kdfParams column is not valid JSON at all.
//  - `KdfParamsError` — the column parses, but what it parsed to is not
//    usable KDF parameters: a non-object, a `null`, a missing field, or a
//    work factor below the floor. That last one is the tampering/downgrade
//    case the floors in kdf.ts exist to catch, and it used to reach the
//    operator as UNLOCK_FAILED_MESSAGE ("try again in a moment") — advice
//    that can never come true for a permanent condition, and which steers
//    away from the recovery key that is the actual way back in.
//
// A recognised connectivity failure gets its own message instead of being
// folded into "corrupt", since the correct next step (wait and retry) is the
// opposite of the corrupt-config advice. Anything else gets the caller's
// neutral message rather than a guess.
//
// Shared by the unlock, recovery-unlock and change-passphrase paths — all
// three read the same VaultConfig row and can fail the same three ways —
// with each caller supplying the wording appropriate to what it was doing.
function classifyVaultConfigFailure(
  err: unknown,
  corruptConfigMessage: string,
  neutralMessage: string = UNLOCK_FAILED_MESSAGE,
): Err {
  if (err instanceof SyntaxError || err instanceof KdfParamsError) return failed(corruptConfigMessage)
  if (isDatabaseConnectivityError(err)) return failed(DATABASE_UNAVAILABLE_MESSAGE)
  return failed(neutralMessage)
}

const VAULT_ALREADY_EXISTS_MESSAGE = 'A vault already exists on this dashboard.'
// Parallel to UNLOCK_FAILED_MESSAGE, worded for the create path rather than
// the unlock path: a failure this file cannot positively identify at all.
const CREATE_FAILED_MESSAGE = 'The vault could not be created right now. Try again in a moment.'

// Same discipline as classifyUnlockFailure above, applied to createVault()'s
// catch. A failure here used to be reported unconditionally as "a vault
// already exists" — correct for the actual TOCTOU race between the
// isInitialised() check above and this write, but wrong, and worse than it
// looks, for a plain transient database hiccup on someone's very FIRST setup
// attempt: unlockAction would then correctly say the opposite (no vault has
// been created yet), leaving the operator with two authoritative,
// contradicting claims and no prior knowledge to judge between them.
//
// Verified empirically against this installed Prisma client (see
// task-7-report.md "Fix round 4") rather than assumed: the actual race
// collides on VaultConfig's DEFAULT id ('singleton'), which Postgres reports
// as a P2002 unique-constraint violation on the primary key — not the
// separate `CHECK (id = 'singleton')` constraint, which surfaces completely
// differently (a PrismaClientUnknownRequestError with no `code` at all) and
// is never reachable through createVault() anyway, since it never supplies
// an explicit id.
//
// P2002 is not the ONLY way this race is positively identifiable, though —
// createVault() in vault.ts does its OWN internal isInitialised() re-check
// before ever reaching the database insert, and throws a named
// VaultAlreadyExistsError if THAT sees the vault as already created. In
// practice this is the more likely of the two outcomes for the real race
// (the redundant internal check adds just enough delay to often observe the
// winner's write before either call reaches the insert), so it needed the
// same treatment as P2002 — fixed here rather than left to fall through to
// the neutral message and discard a cause the code could have known for
// certain. See task-7-report.md "Fix round 5".
function classifyCreateVaultFailure(err: unknown): Err {
  if (err instanceof VaultAlreadyExistsError) return failed(VAULT_ALREADY_EXISTS_MESSAGE)
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
    return failed(VAULT_ALREADY_EXISTS_MESSAGE)
  }
  if (isDatabaseConnectivityError(err)) return failed(DATABASE_UNAVAILABLE_MESSAGE)
  return failed(CREATE_FAILED_MESSAGE)
}

export async function createVaultAction(
  passphrase: string,
): Promise<{ ok: true; recoveryKey: string; sessionRemainingMs: number } | Err> {
  if (passphrase.length < MIN_PASSPHRASE_LENGTH) {
    return failed(`Passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters.`)
  }
  let alreadyExists: boolean
  try {
    alreadyExists = await isInitialised()
  } catch {
    return failed(DATABASE_UNAVAILABLE_MESSAGE)
  }
  if (alreadyExists) return failed(VAULT_ALREADY_EXISTS_MESSAGE)
  try {
    const { recoveryKey } = await createVault(passphrase)
    revalidatePath('/vault')
    return { ok: true, recoveryKey, sessionRemainingMs: sessionDurationForClient() }
  } catch (err) {
    // The caught error's own text is discarded on purpose rather than
    // surfaced in any branch: a rejected insert can echo back fragments of
    // the row it tried to write.
    return classifyCreateVaultFailure(err)
  }
}

export async function unlockAction(passphrase: string): Promise<{ ok: true; sessionRemainingMs: number } | Err> {
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
  } catch (err) {
    // unlockWithPassphrase can fail for at least two UNRELATED reasons that
    // call for opposite advice: a corrupt kdfParams column (JSON.parse
    // throws a SyntaxError — retype-your-passphrase will never help, use
    // the recovery key) or a database connectivity blip mid-call (retrying
    // shortly is exactly right, and "corrupt configuration" would be a
    // guess the evidence does not support). classifyVaultConfigFailure only
    // claims corruption when the error type actually says so. The caught
    // error's own text (which can carry a fragment of the corrupt value) is
    // never surfaced either way.
    return classifyVaultConfigFailure(err, CONFIG_UNREADABLE_MESSAGE)
  }
  if (!ok) return failed('That passphrase did not unlock the vault.')
  revalidatePath('/vault')
  return { ok: true, sessionRemainingMs: sessionDurationForClient() }
}

export async function unlockWithRecoveryAction(
  display: string,
): Promise<{ ok: true; sessionRemainingMs: number } | Err> {
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
  } catch (err) {
    // unlockWithRecoveryKey does not currently read kdfParams, so the
    // SyntaxError branch of classifyUnlockFailure is not reachable through
    // this path today — but it still calls config() internally, so a
    // database connectivity blip during THAT read reaches here and must not
    // be misreported as "corrupt configuration" (see the same reasoning in
    // unlockAction above). Shared classification, kept even where one
    // branch is currently dead, for the same defense-in-depth reason this
    // catch was added in fix round 1.
    return classifyVaultConfigFailure(err, CONFIG_UNREADABLE_RECOVERY_MESSAGE)
  }
  if (!ok) return failed('That recovery key did not unlock the vault.')
  revalidatePath('/vault')
  return { ok: true, sessionRemainingMs: sessionDurationForClient() }
}

// The change-passphrase path reads the SAME VaultConfig row the two unlock
// paths do, so it can fail the same three ways and gets the same treatment —
// but with its own wording, because the advice differs. "Try the recovery
// key" here has to also say what did NOT happen: the passphrase is
// unchanged, and an operator who believes it changed would lock themselves
// out by using the new one.
const CONFIG_UNREADABLE_CHANGE_MESSAGE = 'The stored vault configuration could not be read and may be corrupt. The passphrase was NOT changed; unlock with the recovery key.'
const PASSPHRASE_CHANGE_FAILED_MESSAGE = 'The passphrase could not be changed right now. It is unchanged — try again in a moment.'
// changePassphrase() returns false for exactly one reason it can positively
// identify: the current passphrase failed the verifier (or the wrapped copy
// it guards would not unwrap). Worded so it cannot be mistaken for "the new
// passphrase was rejected".
const PASSPHRASE_CHANGE_REJECTED_MESSAGE = 'That current passphrase is not the one this vault was locked with. The passphrase is unchanged.'

/**
 * Changing the passphrase deliberately does NOT require the vault to be
 * unlocked. It authenticates itself: `changePassphrase` verifies the current
 * passphrase against the stored verifier before touching anything, which is
 * the same proof `unlockAction` demands, so requiring a live session on top
 * would add no control — it would only strand an operator whose 15-minute
 * deadline expired while they were typing.
 *
 * It re-wraps ONLY the passphrase copy of the vault key. Every sealed secret
 * is untouched (so this costs the same for one credential or ten thousand),
 * and so is `wrappedByRecovery` — the printed recovery key keeps working.
 * That last point is not a footnote: an operator who believes a passphrase
 * change invalidated their recovery key may destroy it, and it is the only
 * way back into this vault if the new passphrase is forgotten. The UI says
 * so on success.
 */
export async function changePassphraseAction(
  current: string,
  next: string,
): Promise<{ ok: true } | Err> {
  if (next.length < MIN_PASSPHRASE_LENGTH) {
    return failed(`Passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters.`)
  }
  let initialised: boolean
  try {
    initialised = await isInitialised()
  } catch {
    return failed(DATABASE_UNAVAILABLE_MESSAGE)
  }
  if (!initialised) return failed(NOT_INITIALISED_MESSAGE)
  let ok: boolean
  try {
    ok = await changePassphrase(current, next)
  } catch (err) {
    // Same discipline as the unlock paths: positively identify the cause or
    // name none, and never surface the caught error's own text — a rejected
    // update can echo back a fragment of the row it tried to write, and the
    // corrupt-config errors carry the rejected parameters.
    return classifyVaultConfigFailure(
      err,
      CONFIG_UNREADABLE_CHANGE_MESSAGE,
      PASSPHRASE_CHANGE_FAILED_MESSAGE,
    )
  }
  if (!ok) return failed(PASSPHRASE_CHANGE_REJECTED_MESSAGE)
  revalidatePath('/vault')
  return { ok: true }
}

const ACKNOWLEDGE_FAILED_MESSAGE = 'Could not record that the recovery key was stored. It is still shown above — do not dismiss it; try again in a moment.'
const VAULT_NOT_EMPTY_MESSAGE = 'This vault already holds stored credentials. Recreating it would destroy them, so it is refused. The passphrase is now the only way in.'
// Deliberately names the remedy. This refusal is the ONLY one of the three
// the operator can clear themselves, and the thing being protected — a
// recovery key someone confirmed holding — is exactly what they would lose
// without being told why.
const RECOVERY_KEY_STILL_VALID_MESSAGE = 'This vault’s recovery key was confirmed as stored, so recreating it would silently invalidate a copy that may be sitting in a drawer. Unlock the vault first if you really mean to replace it.'
const RECREATE_FAILED_MESSAGE = 'The vault could not be recreated right now. Nothing was changed — try again in a moment.'

/**
 * Records that the operator confirmed storing the recovery key, at the moment
 * they dismiss it.
 *
 * The failure branch matters more than it looks. `VaultPanel` only clears the
 * key from the screen when this returns ok, so a failed write leaves the key
 * displayed and retryable rather than dismissing it and quietly leaving the
 * vault marked unacknowledged forever — which is the exact silent-absence
 * this whole mechanism exists to prevent.
 */
export async function acknowledgeRecoveryKeyAction(): Promise<{ ok: true } | Err> {
  let recorded: boolean
  try {
    recorded = await acknowledgeRecoveryKey()
  } catch (err) {
    if (isDatabaseConnectivityError(err)) return failed(DATABASE_UNAVAILABLE_MESSAGE)
    return failed(ACKNOWLEDGE_FAILED_MESSAGE)
  }
  if (!recorded) return failed(NOT_INITIALISED_MESSAGE)
  revalidatePath('/vault')
  return { ok: true }
}

/**
 * Replaces a vault whose one-time recovery key was displayed and never
 * stored. Destructive: the old vault key is gone afterwards.
 *
 * The whole rule — zero credentials AND (unacknowledged OR unlocked) — is
 * enforced in `recreateVault`, inside the same transaction that does the
 * replacing, and not by the UI hiding the control. This is a server action,
 * which means a callable HTTP endpoint; a control that is merely hidden is
 * not a control. There is deliberately no `count()` and no acknowledgement
 * read in this function either: taking either here and passing the result
 * down would rebuild the check-then-act window the transaction exists to
 * close.
 */
export async function recreateVaultAction(
  passphrase: string,
): Promise<{ ok: true; recoveryKey: string; sessionRemainingMs: number } | Err> {
  if (passphrase.length < MIN_PASSPHRASE_LENGTH) {
    return failed(`Passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters.`)
  }
  try {
    const { recoveryKey } = await recreateVault(passphrase)
    revalidatePath('/vault')
    return { ok: true, recoveryKey, sessionRemainingMs: sessionDurationForClient() }
  } catch (err) {
    // The one refusal this action must never blur into a generic failure: it
    // is not a problem to retry, it is a statement that the operator's data
    // was protected from the thing they just asked for.
    if (err instanceof VaultNotEmptyError) return failed(VAULT_NOT_EMPTY_MESSAGE)
    // Distinct from the not-empty refusal, and from each other's advice: one
    // says "your data was protected and there is nothing you can do", this
    // says "prove you know the passphrase and you may proceed".
    if (err instanceof RecoveryKeyStillValidError) return failed(RECOVERY_KEY_STILL_VALID_MESSAGE)
    if (isDatabaseConnectivityError(err)) return failed(DATABASE_UNAVAILABLE_MESSAGE)
    // Same discipline as everywhere else here: the caught error's own text is
    // discarded rather than surfaced. A rejected write can echo back a
    // fragment of the wrapped key material it tried to store.
    return failed(RECREATE_FAILED_MESSAGE)
  }
}

export async function lockAction(): Promise<{ ok: true }> {
  lockSession()
  revalidatePath('/vault')
  return { ok: true }
}

const RECOVERY_KEY_UNACKNOWLEDGED_MESSAGE = 'Nothing can be stored in this vault until its recovery key is confirmed as stored. It has not been, and it cannot be shown again — recreate the vault to get a usable one, then confirm it.'

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
    // Its own fact, with its own remedy, and distinct from a locked vault:
    // unlocking will not help, and the operator needs to be told what will.
    if (err instanceof RecoveryKeyUnacknowledgedError) {
      return failed(RECOVERY_KEY_UNACKNOWLEDGED_MESSAGE)
    }
    return failed('Could not save the credential.')
  }
}

// For a reveal failure this file cannot positively identify at all: not
// locked, not missing, not a confirmed decrypt failure, not a recognised
// database connectivity error. Naming a cause without evidence is exactly
// the defect fixed in "Fix round 5" — see below.
const REVEAL_FAILED_MESSAGE = 'This credential could not be revealed right now. Try again in a moment.'

// Four distinct failure facts, each with its own advice — collapsing them
// into one message either hides that unlocking won't help (a missing
// credential), actively misdirects away from a security event (calling a
// database outage "may indicate the stored data was altered or corrupted"),
// or actively misdirects AWAY from one (calling a real tampering event a
// transient database problem). See task-7-brief.md Resolution 1 and
// task-7-report.md "Fix round 5".
//
// revealCredential() in credentials.ts is deliberately narrow about what it
// lets escape here: VaultLockedError and CredentialNotFoundError are always
// positively identified; CredentialDecryptError is thrown ONLY when open()
// itself fails a GCM authentication check; everything else (a database
// connectivity blip at any of the three separate database operations inside
// revealCredential) is an untouched error of whatever type actually caused
// it, which is what lets isDatabaseConnectivityError() below recognise it
// correctly regardless of which of those three operations failed.
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
    if (err instanceof CredentialDecryptError) {
      // The ONE case positively identified as a decrypt failure — a GCM
      // authentication-tag mismatch, the tamper/moved-ciphertext case the
      // AAD binding defends against. Show it as unreadable, never as an
      // empty field, and never suggest unlocking again since the vault is
      // already unlocked at this point.
      return failed('This credential could not be decrypted and is unreadable. This may indicate the stored data was altered or corrupted.')
    }
    if (isDatabaseConnectivityError(err)) return failed(DATABASE_UNAVAILABLE_MESSAGE)
    return failed(REVEAL_FAILED_MESSAGE)
  }
}

export async function removeCredentialAction(id: string): Promise<{ ok: true } | Err> {
  try {
    await removeCredential(id)
    revalidatePath('/vault')
    return { ok: true }
  } catch (err) {
    // A locked vault is its own fact, and the one with a useful next step:
    // unlock and try again. Folding it into "could not delete" would send the
    // operator looking for a database problem that isn't there.
    if (err instanceof VaultLockedError) {
      return failed('The vault is locked. Unlock it and try again.')
    }
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
