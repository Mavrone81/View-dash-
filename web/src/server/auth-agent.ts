import { createHash, randomBytes, randomUUID } from 'node:crypto'
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
  // The id is generated here, client-side, rather than left to the
  // database's default(uuid()) — so the row can be written in ONE create
  // instead of a create-then-update. secretSealed's AAD binds to this same
  // id, so the id has to exist before the seal call regardless; generating
  // it ourselves is what lets both writes collapse into one. (A prior
  // version created the row with a 'pending' sentinel and updated it
  // after: a crash between the two writes left a row that authenticated
  // successfully but whose sealed copy was the literal string 'pending'.)
  const id = randomUUID()
  await prisma.agentEnrolment.create({
    data: { id, hostId: host.id, tokenHash: hashToken(token), secretSealed: seal(token, `agent_enrolment:${id}:secret`, dek) },
  })
  return { token, hostId: host.id }
}

/**
 * Authenticates a raw agent token. Returns the owning host id, or null if
 * the token is not a non-empty string, was never issued, or belongs to a
 * revoked enrolment.
 *
 * Does not throw for malformed input: `token` is typed `unknown` rather
 * than `string` on purpose, because the real caller (Task 10's ingest
 * endpoint) reads this from an HTTP header, which Node types as
 * `string | string[] | undefined` and which nothing stops from being
 * anything else once it has crossed the wire — a duplicated header, a
 * missing one, a client that sends JSON instead. TypeScript's protection
 * stops at this repo's boundary; a runtime check is what actually holds at
 * the network boundary. Getting this wrong would surface as a 500 for
 * certain malformed inputs only, which is exactly the kind of probe oracle
 * an attacker uses to map a system, so the failure mode for "not a string"
 * must be the same `null` as "not a match" — not an exception.
 * (It can still throw for reasons unrelated to the input's shape — e.g. if
 * the database itself is unreachable, Prisma throws and that propagates.)
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
