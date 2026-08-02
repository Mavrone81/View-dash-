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

function requireKey(): Buffer {
  const key = currentVaultKey()
  // A locked vault must fail loudly. Returning an empty string here would let
  // a caller render a blank field, which reads as "no credential stored" —
  // a different and false fact.
  if (!key) throw new Error('vault is locked')
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
  const key = requireKey()
  const row = await prisma.credential.findUniqueOrThrow({ where: { id }, select: { id: true, secretSealed: true } })
  const secret = open(row.secretSealed, aadFor(row.id), key)
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
