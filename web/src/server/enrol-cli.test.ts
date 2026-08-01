import { describe, it, expect, beforeEach, vi } from 'vitest'
import { prisma } from '../lib/db.js'
import { authenticateAgent } from './auth-agent.js'
import { main, USAGE } from './enrol-cli.js'

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
    expect(out.error).toHaveBeenCalledWith(USAGE)
    expect(out.log).not.toHaveBeenCalled()
  })

  it('fails clearly when the host-name argument is an empty string', async () => {
    // Distinct from "missing": `argv[2]` can be present but empty (e.g.
    // `enrol ''`), and must be treated the same as absent rather than
    // handed to `enrolAgent` as a real, blank host name.
    const out = fakeOut()
    const code = await main(['node', 'enrol-cli.mjs', ''], out)
    expect(code).toBe(1)
    expect(out.error).toHaveBeenCalledWith(USAGE)
  })

  it('documents the revoke path in its own usage text, so decommissioning is discoverable', () => {
    expect(USAGE).toContain('--revoke')
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

// `revokeAgent` was implemented and unit-tested from the start, but nothing
// an operator could actually RUN ever called it. A host therefore could not
// be decommissioned without re-enrolling it -- minting a fresh working
// credential for a machine you are trying to take away.
describe('enrol-cli main() --revoke', () => {
  it('kills a live token: the agent that holds it can no longer authenticate', async () => {
    const enrolled = fakeOut()
    await main(['node', 'enrol-cli.mjs', 'cli-host-revoke'], enrolled)
    const token = enrolled.log.mock.calls[0]?.[0] as string
    expect(await authenticateAgent(token)).not.toBeNull()

    const out = fakeOut()
    const code = await main(['node', 'enrol-cli.mjs', '--revoke', 'cli-host-revoke'], out)

    expect(code).toBe(0)
    expect(await authenticateAgent(token)).toBeNull()
  })

  it('mints nothing: revoking must never hand back a fresh working credential', async () => {
    // The entire point of having this separately from re-enrolment.
    const enrolled = fakeOut()
    await main(['node', 'enrol-cli.mjs', 'cli-host-nomint'], enrolled)

    const out = fakeOut()
    await main(['node', 'enrol-cli.mjs', '--revoke', 'cli-host-nomint'], out)

    expect(out.log).not.toHaveBeenCalled()
  })

  it('is idempotent for a host whose tokens are already revoked, so a lost response is safe to retry', async () => {
    const enrolled = fakeOut()
    await main(['node', 'enrol-cli.mjs', 'cli-host-twice'], enrolled)
    await main(['node', 'enrol-cli.mjs', '--revoke', 'cli-host-twice'], fakeOut())

    const out = fakeOut()
    const code = await main(['node', 'enrol-cli.mjs', '--revoke', 'cli-host-twice'], out)
    expect(code).toBe(0)
  })

  it('fails rather than claiming success for a host name that does not exist', async () => {
    // A typo must not report "revoked". Believing a credential is dead
    // while it is still live is the one outcome this command must never
    // produce.
    const out = fakeOut()
    const code = await main(['node', 'enrol-cli.mjs', '--revoke', 'no-such-host-anywhere'], out)
    expect(code).toBe(1)
    const said = out.error.mock.calls.map((c) => String(c[0])).join('\n')
    expect(said).toMatch(/no such host/i)
  })

  it('fails with usage when --revoke is given no host name', async () => {
    const out = fakeOut()
    const code = await main(['node', 'enrol-cli.mjs', '--revoke'], out)
    expect(code).toBe(1)
    expect(out.error).toHaveBeenCalledWith(USAGE)
  })

  it('revokes only the named host, never every host at once', async () => {
    // A decommission command that doubles as a fleet-wide kill switch would
    // take nine businesses' monitoring offline in one keystroke.
    const outA = fakeOut()
    const outB = fakeOut()
    await main(['node', 'enrol-cli.mjs', 'cli-host-keep'], outA)
    await main(['node', 'enrol-cli.mjs', 'cli-host-drop'], outB)
    const keepToken = outA.log.mock.calls[0]?.[0] as string
    const dropToken = outB.log.mock.calls[0]?.[0] as string

    await main(['node', 'enrol-cli.mjs', '--revoke', 'cli-host-drop'], fakeOut())

    expect(await authenticateAgent(dropToken)).toBeNull()
    expect(await authenticateAgent(keepToken)).not.toBeNull()
  })

  it('does not treat a host literally named --revoke as a flag in the host-name position', async () => {
    // `argv[2] === '--revoke'` with nothing after it is a usage error, not
    // an attempt to enrol a host called "--revoke".
    const out = fakeOut()
    const code = await main(['node', 'enrol-cli.mjs', '--revoke', ''], out)
    expect(code).toBe(1)
    expect(out.log).not.toHaveBeenCalled()
  })
})
