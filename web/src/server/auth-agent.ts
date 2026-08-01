import { createHash, randomBytes } from 'node:crypto'
import { prisma } from '../lib/db.js'
import { seal } from '../lib/crypto/envelope.js'

const TOKEN_BYTES = 32

const hashToken = (token: string): string => createHash('sha256').update(token, 'utf8').digest('hex')

/**
 * Mints a new agent token for `hostName` (creating the host if it does not
 * already exist) and persists only a hash of it plus an encrypted,
 * row-bound copy — never the raw token itself.
 */
export async function enrolAgent(hostName: string, dek: Buffer): Promise<{ token: string; hostId: string }> {
  const token = randomBytes(TOKEN_BYTES).toString('base64url')
  const host = await prisma.host.upsert({
    where: { name: hostName },
    create: { name: hostName },
    update: {},
  })
  // tokenHash is the lookup key at authentication time. secretSealed keeps a
  // copy recoverable ONLY by whoever holds the DEK (e.g. to re-display the
  // token once to an operator who lost it) — sealed under AAD bound to this
  // exact row, so a sealed value can never be replayed onto a different
  // enrolment. It is created in a second write because the row's own id is
  // part of that AAD and does not exist until the row does.
  const row = await prisma.agentEnrolment.create({
    data: { hostId: host.id, tokenHash: hashToken(token), secretSealed: 'pending' },
  })
  await prisma.agentEnrolment.update({
    where: { id: row.id },
    data: { secretSealed: seal(token, `agent_enrolment:${row.id}:secret`, dek) },
  })
  return { token, hostId: host.id }
}

/**
 * Authenticates a raw agent token. Returns the owning host id, or null if
 * the token is empty, was never issued, or belongs to a revoked enrolment.
 *
 * Never throws: hashing accepts any string, and the only value passed to
 * Prisma is the fixed-length (64 hex char) hash, never the raw token, so an
 * oversized or oddly-shaped input cannot blow up the query.
 *
 * No secret-vs-secret comparison happens here (and so no `===`-timing
 * concern applies): identity is established purely by an indexed database
 * lookup on a SHA-256 hash, not by comparing token bytes in this process.
 */
export async function authenticateAgent(token: string): Promise<{ hostId: string } | null> {
  // Empty tokens are rejected before any database round-trip: there is
  // nothing to hash-and-look-up, so spending a query on it buys nothing.
  if (!token) return null
  const row = await prisma.agentEnrolment.findUnique({ where: { tokenHash: hashToken(token) } })
  // revokedAt is checked on every call, never cached from enrolment time —
  // revoking an enrolment must take effect on the very next attempt.
  if (!row || row.revokedAt) return null
  return { hostId: row.hostId }
}
