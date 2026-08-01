import { describe, it, expect, beforeEach, vi } from 'vitest'
import { prisma } from '../lib/db.js'
import { authenticateAgent } from './auth-agent.js'
import { main } from './enrol-cli.js'

beforeEach(async () => {
  await prisma.agentEnrolment.deleteMany()
  await prisma.system.deleteMany()
  await prisma.host.deleteMany()
})

// A minimal stand-in for `console` that records calls instead of writing
// to real stdout/stderr, so assertions can check exactly what was printed
// and how many times -- in particular, that the token itself is written
// on stdout (`log`) exactly once, never repeated onto stderr or logged a
// second time by some other path.
function fakeOut() {
  return { log: vi.fn(), error: vi.fn() }
}

describe('enrol-cli main()', () => {
  it('fails clearly when the host-name argument is missing', async () => {
    const out = fakeOut()
    const code = await main(['node', 'enrol-cli.mjs'], out)
    expect(code).toBe(1)
    expect(out.error).toHaveBeenCalledWith('usage: node enrol-cli.mjs <host-name>')
    expect(out.log).not.toHaveBeenCalled()
  })

  it('fails clearly when the host-name argument is an empty string', async () => {
    // Distinct from "missing": `argv[2]` can be present but empty (e.g.
    // `enrol ''`), and must be treated the same as absent rather than
    // handed to `enrolAgent` as a real, blank host name.
    const out = fakeOut()
    const code = await main(['node', 'enrol-cli.mjs', ''], out)
    expect(code).toBe(1)
    expect(out.error).toHaveBeenCalledWith('usage: node enrol-cli.mjs <host-name>')
  })

  it('on a valid enrolment, prints the token on stdout exactly once, and it authenticates', async () => {
    const out = fakeOut()
    const code = await main(['node', 'enrol-cli.mjs', 'cli-host-a'], out)
    expect(code).toBe(0)
    expect(out.log).toHaveBeenCalledTimes(1)
    const token = out.log.mock.calls[0]?.[0] as string
    expect(typeof token).toBe('string')
    expect(token.length).toBeGreaterThan(0)
    const auth = await authenticateAgent(token)
    expect(auth).not.toBeNull()
    // Never printed via `error` (only the surrounding, non-secret lines
    // are) -- if the token leaked onto the wrong stream, this would still
    // pass `out.log` above, so it has to be checked independently.
    for (const call of out.error.mock.calls) {
      expect(String(call[0])).not.toContain(token)
    }
  })

  it('re-running with the same host name revokes the old token and mints a working new one', async () => {
    const out1 = fakeOut()
    await main(['node', 'enrol-cli.mjs', 'cli-host-b'], out1)
    const firstToken = out1.log.mock.calls[0]?.[0] as string
    expect(await authenticateAgent(firstToken)).not.toBeNull()

    const out2 = fakeOut()
    const code2 = await main(['node', 'enrol-cli.mjs', 'cli-host-b'], out2)
    expect(code2).toBe(0)
    const secondToken = out2.log.mock.calls[0]?.[0] as string
    expect(secondToken).not.toBe(firstToken)

    // This is `enrolAgent`'s own atomic-rotation contract (see
    // auth-agent.ts): the OLD token must stop working the instant the
    // new one is minted, not just eventually or on some separate revoke
    // call the CLI forgot to make.
    expect(await authenticateAgent(firstToken)).toBeNull()
    expect(await authenticateAgent(secondToken)).not.toBeNull()
  })
})
