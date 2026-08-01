import { describe, it, expect, beforeEach, vi } from 'vitest'
import { prisma } from '../lib/db.js'
import { enrolAgent, authenticateAgent, revokeAgent } from './auth-agent.js'

beforeEach(async () => {
  await prisma.agentEnrolment.deleteMany()
  await prisma.system.deleteMany()
  await prisma.host.deleteMany()
})

describe('agent auth', () => {
  it('accepts the token it issued', async () => {
    const { token, hostId } = await enrolAgent('host-a')
    expect(await authenticateAgent(token)).toEqual({ hostId })
  })

  it('rejects a token it never issued', async () => {
    await enrolAgent('host-b')
    expect(await authenticateAgent('not-a-real-token')).toBeNull()
  })

  it('rejects a revoked token', async () => {
    const { token } = await enrolAgent('host-c')
    await revokeAgent('host-c')
    expect(await authenticateAgent(token)).toBeNull()
  })

  it('never stores the token in plaintext', async () => {
    const { token } = await enrolAgent('host-d')
    const rows = await prisma.agentEnrolment.findMany()
    const dump = JSON.stringify(rows)
    expect(dump).not.toContain(token)
  })

  it('rejects an empty token without touching the database', async () => {
    expect(await authenticateAgent('')).toBeNull()
  })

  // The test above only proves the RESULT is null; it says nothing about
  // whether a query fired. This proves the short-circuit is real by
  // asserting the underlying Prisma call never happens for an empty token,
  // and (below) DOES happen for a non-empty one — so the guard is genuinely
  // discriminating on emptiness, not just coincidentally returning null.
  it('does not query the database for an empty token', async () => {
    const spy = vi.spyOn(prisma.agentEnrolment, 'findUnique')
    try {
      await authenticateAgent('')
      expect(spy).not.toHaveBeenCalled()
    } finally {
      spy.mockRestore()
    }
  })

  it('does query the database for a non-empty, unknown token', async () => {
    const spy = vi.spyOn(prisma.agentEnrolment, 'findUnique')
    try {
      await authenticateAgent('some-nonempty-value')
      expect(spy).toHaveBeenCalledTimes(1)
    } finally {
      spy.mockRestore()
    }
  })

  it('rejects a single-bit-flipped copy of a real, issued token', async () => {
    const { token } = await enrolAgent('host-e')
    // Non-null: token[0] always exists (it is a freshly generated,
    // non-empty base64url string), only its type is widened by
    // noUncheckedIndexedAccess.
    const flippedFirstChar = token[0] === 'a' ? 'b' : 'a'
    const flipped = flippedFirstChar + token.slice(1)
    expect(await authenticateAgent(flipped)).toBeNull()
  })

  it("revoking one host's enrolment does not affect another host's", async () => {
    const first = await enrolAgent('host-f')
    const second = await enrolAgent('host-g')
    await revokeAgent('host-f')
    expect(await authenticateAgent(first.token)).toBeNull()
    expect(await authenticateAgent(second.token)).toEqual({ hostId: second.hostId })
  })

  it('after re-enrolling a host, the old token no longer authenticates and the new one does', async () => {
    const first = await enrolAgent('host-h')
    const second = await enrolAgent('host-h')
    // Re-enrolling the same host name reuses the host, not a new one.
    expect(second.hostId).toBe(first.hostId)
    expect(await authenticateAgent(first.token)).toBeNull()
    expect(await authenticateAgent(second.token)).toEqual({ hostId: second.hostId })
  })

  it('revokeAgent is idempotent: revoking twice does not throw and stays revoked', async () => {
    const { token } = await enrolAgent('host-i')
    await revokeAgent('host-i')
    await expect(revokeAgent('host-i')).resolves.toBeUndefined()
    expect(await authenticateAgent(token)).toBeNull()
  })

  it('revoking a host that was never enrolled does not throw', async () => {
    await expect(revokeAgent('host-never-enrolled')).resolves.toBeUndefined()
  })

  // The `\0`s here are deliberate, not incidental: Postgres text columns
  // reject NUL outright, so this also proves the raw token is never handed
  // to Prisma unhashed — an implementation that (bug) passed `token` itself
  // into a query would throw here, not resolve to null. (A prior version of
  // this file used literal NUL bytes instead of the `\0` escape below,
  // which made git classify the whole file as binary and hide it from
  // review entirely — `git diff` rendered `Bin 0 -> 3408 bytes`. Escaped
  // form keeps the same runtime string while staying readable text.)
  it('never throws for a garbage-shaped token', async () => {
    await expect(authenticateAgent('¡not-base64url!\0\0')).resolves.toBeNull()
  })

  // TypeScript's `string`/`unknown` parameter type only protects callers
  // inside this repo. Task 10 will pass this function a raw HTTP header
  // value (`string | string[] | undefined` at best, and nothing enforces
  // even that once the request is attacker-controlled), so the guard must
  // hold at runtime regardless of what the declared type promises. Each
  // case below must resolve to null and must NOT throw — a thrown 500 that
  // only happens for certain malformed shapes is a probe oracle an
  // attacker can use to map the system.
  it('rejects an array-valued token (e.g. a duplicated HTTP header) without throwing', async () => {
    await expect(authenticateAgent(['a', 'b'])).resolves.toBeNull()
  })

  it('rejects a number-valued token without throwing', async () => {
    await expect(authenticateAgent(42)).resolves.toBeNull()
  })

  it('rejects a null token without throwing', async () => {
    await expect(authenticateAgent(null)).resolves.toBeNull()
  })

  it('rejects an undefined token without throwing', async () => {
    await expect(authenticateAgent(undefined)).resolves.toBeNull()
  })

  it('rejects an object-valued token without throwing', async () => {
    await expect(authenticateAgent({ not: 'a token' })).resolves.toBeNull()
  })
})
