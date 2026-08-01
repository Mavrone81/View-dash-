import { createHash, randomBytes } from 'node:crypto'
import { prisma } from '../lib/db.js'

const TOKEN_BYTES = 32

const hashToken = (token: string): string => createHash('sha256').update(token, 'utf8').digest('hex')

/**
 * Mints a new agent token for `hostName` (creating the host if it does not
 * already exist), returns the raw token to the caller EXACTLY ONCE, and
 * persists only its hash. Nothing recoverable is ever written to disk:
 * this is a show-once credential by design (human ruling, superseding an
 * earlier spec that kept an encrypted, re-displayable copy) — the DEK that
 * would decrypt such a copy lives in the same process as the database
 * connection, so a single app-server compromise would otherwise yield both
 * the database AND a live, replayable write credential into a control
 * plane covering multiple businesses' production systems. Re-enrolling a
 * host (one command, plus an agent restart) is strictly better than
 * recovery: it also rotates the credential, which recovery cannot.
 *
 * Any of the host's existing, still-active enrolments are revoked in the
 * SAME transaction as the new one is created — re-enrolling is how an
 * operator rotates a credential, and a half-applied rotation (only the
 * revoke commits, or only the create) would leave either two live tokens
 * for one host or zero, neither of which is safe to leave partially done.
 */
export async function enrolAgent(hostName: string): Promise<{ token: string; hostId: string }> {
  const token = randomBytes(TOKEN_BYTES).toString('base64url')
  const host = await prisma.host.upsert({
    where: { name: hostName },
    create: { name: hostName },
    update: {},
  })
  await prisma.$transaction([
    prisma.agentEnrolment.updateMany({
      where: { hostId: host.id, revokedAt: null },
      data: { revokedAt: new Date() },
    }),
    prisma.agentEnrolment.create({
      data: { hostId: host.id, tokenHash: hashToken(token) },
    }),
  ])
  return { token, hostId: host.id }
}

/**
 * Revokes every currently-active enrolment for `hostName`. Idempotent:
 * revoking an already-revoked host, or a host name that was never
 * enrolled, is a no-op rather than an error — an operator re-running a
 * revoke command (e.g. because the first attempt's response was lost)
 * must not get a failure for something that already happened.
 *
 * Scoped to this one host's enrolments via `hostId` — it must never
 * become a global kill switch that blocks every other host's live token
 * as a side effect of revoking one.
 */
export async function revokeAgent(hostName: string): Promise<void> {
  const host = await prisma.host.findUnique({ where: { name: hostName } })
  if (!host) return
  await prisma.agentEnrolment.updateMany({
    where: { hostId: host.id, revokedAt: null },
    data: { revokedAt: new Date() },
  })
}

/**
 * Authenticates a raw agent token. Returns the owning host id, or null if
 * the token is not a non-empty string, was never issued, or belongs to a
 * revoked enrolment.
 *
 * `token` is typed `unknown`, not `string`, and kept that way deliberately
 * (not narrowed back after review): this value arrives from an HTTP
 * header, and TypeScript's compile-time guarantee does not survive the
 * network — a caller that relied on `string` here would be trusting a type
 * annotation for data it never actually checked. Widening the parameter
 * type makes that boundary explicit instead of implicit.
 *
 * Does not throw for malformed input: hashing accepts any string, and the
 * only value passed to Prisma is the fixed-length (64 hex char) hash,
 * never the raw token, so an oversized, wrongly-typed, or oddly-shaped
 * input cannot blow up the query. (It can still throw for reasons
 * unrelated to the input's shape — e.g. if the database itself is
 * unreachable, Prisma throws and that propagates.) A thrown 500 that only
 * happens for certain malformed shapes would be a probe oracle an attacker
 * could use to map the system, so the failure mode for "not a string" must
 * be the same `null` as "not a match."
 *
 * No secret-vs-secret comparison happens here (and so no `===`-timing
 * concern applies): identity is established purely by an indexed database
 * lookup on a SHA-256 hash, not by comparing token bytes in this process.
 */
export async function authenticateAgent(token: unknown): Promise<{ hostId: string } | null> {
  // Rejected before any database round-trip: there is nothing to
  // hash-and-look-up, so spending a query on a value that cannot possibly
  // match anything buys nothing.
  if (typeof token !== 'string' || token.length === 0) return null
  const row = await prisma.agentEnrolment.findUnique({ where: { tokenHash: hashToken(token) } })
  // revokedAt is checked on every call, never cached from enrolment time —
  // revoking an enrolment must take effect on the very next attempt.
  if (!row || row.revokedAt) return null
  return { hostId: row.hostId }
}
