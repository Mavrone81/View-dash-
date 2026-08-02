import { randomUUID } from 'node:crypto'
import { prisma } from '../db.js'
import { seal, open } from '../crypto/envelope.js'
import { currentVaultKey } from './session.js'

export type CredentialSummary = {
  id: string
  label: string
  username: string
  notes: string | null
  hostId: string | null
  systemKey: string | null
  rotatedAt: Date | null
}

const SUMMARY = {
  id: true, label: true, username: true, notes: true,
  hostId: true, systemKey: true, rotatedAt: true,
} as const

const aadFor = (id: string): string => `credential:${id}:secret`

// Named so callers (the server-action layer, in particular) can distinguish
// "the vault is locked" from "the id doesn't exist" from a decrypt failure
// with `instanceof`, rather than matching on error message text — a rename
// of the message would otherwise silently break that distinction. Messages
// are kept identical to what this file already threw so existing tests that
// assert on them keep passing.
export class VaultLockedError extends Error {}
export class CredentialNotFoundError extends Error {}
// Thrown ONLY when `open()` itself fails (a GCM authentication-tag mismatch,
// an unsupported envelope version, or a malformed envelope shape -- see
// envelope.ts). This is deliberately the ONE thing revealCredential lets
// escape that a caller may treat as "the stored ciphertext could not be
// authenticated" -- every other failure in this function (a missing row, a
// locked vault, a database connectivity blip while reading the row or
// writing an audit record) is either one of the two error types above or an
// untouched error from whatever actually threw it, precisely so a caller
// is never left inferring "corrupted" from an error that could have come
// from an unrelated database operation. See task-7-report.md "Fix round 5".
export class CredentialDecryptError extends Error {}

function requireKey(): Buffer {
  const key = currentVaultKey()
  // A locked vault must fail loudly. Returning an empty string here would let
  // a caller render a blank field, which reads as "no credential stored" —
  // a different and false fact.
  if (!key) throw new VaultLockedError('vault is locked')
  return key
}

export async function addCredential(input: {
  label: string; username: string; secret: string
  notes?: string; hostId?: string; systemKey?: string
}): Promise<string> {
  const key = requireKey()
  // The id is generated client-side (rather than left to the database
  // default) specifically so it exists BEFORE sealing: the AAD binds the
  // ciphertext to this id, and the row must be written once, already
  // holding the real ciphertext. A create-then-update split would leave a
  // window where the row exists with a placeholder secretSealed value — a
  // crash in that window persists a credential that lists fine and throws
  // on every reveal forever, since there is no plaintext to recover it from.
  const id = randomUUID()
  const sealed = seal(input.secret, aadFor(id), key)
  // ONE transaction, deliberately -- and deliberately NOT the swallow that
  // revealCredential uses for its own audit writes. The two situations look
  // alike and are not:
  //
  // In revealCredential the fact is already established and outside this
  // code's gift: the vault IS locked, the ciphertext DID fail to
  // authenticate. A failed audit write cannot make those untrue, so
  // swallowing it and reporting the real fact is the only honest option --
  // replacing it with an unrelated database error would misreport a security
  // event.
  //
  // Here the fact is still ours to decide. Nothing is established until this
  // function says so, and the caller is holding the plaintext they just
  // typed, so a genuine rollback costs them one retry and nothing else.
  // Swallowing instead would leave an UNAUDITED credential in an audited
  // vault -- design spec section 7 makes CredentialAccess the record of
  // every 'create' -- and, worse, would report success for a row whose
  // creation nothing witnessed. Rolling back makes the failure the operator
  // is shown TRUE, which is what stops the retry from silently storing a
  // second copy of the same production password.
  await prisma.$transaction(async (tx) => {
    await tx.credential.create({
      data: {
        id,
        label: input.label,
        username: input.username,
        secretSealed: sealed,
        notes: input.notes ?? null,
        hostId: input.hostId ?? null,
        systemKey: input.systemKey ?? null,
      },
      select: { id: true },
    })
    await tx.credentialAccess.create({ data: { credentialId: id, action: 'create' } })
  })
  return id
}

export async function listCredentials(): Promise<CredentialSummary[]> {
  // `select` is exhaustive on purpose: it is what guarantees no sealed secret
  // can reach a caller by someone later adding a field to the model.
  return prisma.credential.findMany({ select: SUMMARY, orderBy: { label: 'asc' } })
}

export async function credentialsForSystem(hostId: string, systemKey: string): Promise<CredentialSummary[]> {
  return prisma.credential.findMany({ where: { hostId, systemKey }, select: SUMMARY, orderBy: { label: 'asc' } })
}

export async function revealCredential(id: string): Promise<string> {
  // Order matters here, and each step exists to fix a specific failure mode:
  //
  // 1. Look the row up FIRST, before checking the lock. CredentialAccess.credentialId
  //    is a foreign key into Credential, so an audit row can never be written for an
  //    id that doesn't exist. Checking the lock first would mean a locked-vault reveal
  //    of an unknown id dies on an FK violation instead of surfacing "not found" — the
  //    real problem gets masked by an unrelated database error. A missing row writes
  //    no audit row at all: there is nothing here to audit against.
  // 2. Check the lock only once the row is known to exist, and write 'reveal-denied'
  //    before throwing. A probe against a locked vault is exactly the kind of access
  //    attempt an audit log exists to catch — recording only successes has it backwards.
  // 3. Wrap `open()` so a decrypt failure (wrong key, tampered ciphertext, or the
  //    moved-ciphertext/AAD-mismatch case) writes 'reveal-failed' and always reports
  //    itself as a CredentialDecryptError — a positively identified fact, not
  //    inferred from whatever happened to be the last thing to throw.
  //
  // In steps 2 and 3, the audit write is wrapped in its OWN try/catch, deliberately
  // swallowed on failure: a database blip while recording the audit row must not
  // replace the real, already-established fact (the vault is locked; the ciphertext
  // failed to authenticate) with an unrelated database error, nor silently turn that
  // real fact into a misreported one at the caller. See task-7-report.md "Fix round 5"
  // — this is what a database outage hitting revealCredential used to look like: a
  // connectivity error indistinguishable, to the caller, from a genuine decrypt
  // failure, which reported as "may indicate the stored data was altered or
  // corrupted" instead of "could not reach the database".
  //
  // In every failure path, the row written to the audit table is the id and an action
  // string only — never the ciphertext, the key, or any fragment of a secret.
  const row = await prisma.credential.findUnique({ where: { id }, select: { id: true, secretSealed: true } })
  if (!row) throw new CredentialNotFoundError('credential not found')

  const key = currentVaultKey()
  if (!key) {
    try {
      await prisma.credentialAccess.create({ data: { credentialId: id, action: 'reveal-denied' } })
    } catch {
      // Swallowed: see the block comment above. "The vault is locked" is
      // true regardless of whether this audit write succeeded.
    }
    throw new VaultLockedError('vault is locked')
  }

  let secret: string
  try {
    secret = open(row.secretSealed, aadFor(row.id), key)
  } catch (decryptErr) {
    try {
      await prisma.credentialAccess.create({ data: { credentialId: id, action: 'reveal-failed' } })
    } catch {
      // Swallowed: see the block comment above. The decrypt failure is what
      // gets reported below either way.
    }
    // A new, named error rather than the original rethrown: the caller needs
    // to know ONLY that this was a decrypt failure, positively, from open()
    // itself — not any detail from the original error, which is discarded
    // here rather than attached, consistent with never surfacing a caught
    // error's own text.
    throw new CredentialDecryptError('credential could not be decrypted')
  }

  await prisma.credentialAccess.create({ data: { credentialId: id, action: 'reveal' } })
  return secret
}

export async function removeCredential(id: string): Promise<void> {
  // Requires the vault to be unlocked, even though deleting a row needs no
  // key. Until task 10 this function was reachable from no UI at all; wiring
  // a Remove control to it makes it a destructive, irreversible operation
  // exposed on an unauthenticated server action, where the vault's own lock
  // is the only control standing in front of it (see actions.ts's note).
  // Refusing while locked costs the operator one unlock and removes the case
  // where a caller who cannot read a single credential can still destroy
  // every one of them.
  requireKey()
  // NOTE: CredentialAccess.credentialId cascades on Credential delete, so
  // this cannot also write a 'delete' audit row — it would be removed by the
  // same statement it belongs to. See task-6-report.md for the discussion;
  // not resolved in this task.
  await prisma.credential.delete({ where: { id } })
}
