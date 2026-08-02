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
  await prisma.credential.create({
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
  await prisma.credentialAccess.create({ data: { credentialId: id, action: 'create' } })
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
  //    moved-ciphertext/AAD-mismatch case) writes 'reveal-failed' and rethrows the
  //    ORIGINAL error unchanged, rather than letting a bug in the audit write itself
  //    mask why the reveal actually failed.
  //
  // In every failure path, the row written to the audit table is the id and an action
  // string only — never the ciphertext, the key, or any fragment of a secret.
  const row = await prisma.credential.findUnique({ where: { id }, select: { id: true, secretSealed: true } })
  if (!row) throw new CredentialNotFoundError('credential not found')

  const key = currentVaultKey()
  if (!key) {
    await prisma.credentialAccess.create({ data: { credentialId: id, action: 'reveal-denied' } })
    throw new VaultLockedError('vault is locked')
  }

  let secret: string
  try {
    secret = open(row.secretSealed, aadFor(row.id), key)
  } catch (err) {
    await prisma.credentialAccess.create({ data: { credentialId: id, action: 'reveal-failed' } })
    throw err
  }

  await prisma.credentialAccess.create({ data: { credentialId: id, action: 'reveal' } })
  return secret
}

export async function removeCredential(id: string): Promise<void> {
  // NOTE: CredentialAccess.credentialId cascades on Credential delete, so
  // this cannot also write a 'delete' audit row — it would be removed by the
  // same statement it belongs to. See task-6-report.md for the discussion;
  // not resolved in this task.
  await prisma.credential.delete({ where: { id } })
}
