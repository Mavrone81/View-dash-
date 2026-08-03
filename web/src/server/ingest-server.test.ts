import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { WebSocket, type WebSocketServer } from 'ws'
import type { AddressInfo } from 'node:net'
import { prisma } from '../lib/db.js'
import { enrolAgent, revokeAgent } from './auth-agent.js'
import { startIngestServer, startIngestProcess } from './ingest-server.js'

let wss: WebSocketServer
let url: string
let hostId: string
let token: string

beforeEach(async () => {
  await prisma.systemObservation.deleteMany()
  await prisma.system.deleteMany()
  await prisma.agentEnrolment.deleteMany()
  await prisma.host.deleteMany()
  const enrolled = await enrolAgent('host-a')
  hostId = enrolled.hostId
  token = enrolled.token
  wss = startIngestServer({ host: '127.0.0.1', port: 0, maxPayloadBytes: 1024 * 1024, maxConnections: 64 })
  await new Promise<void>((resolve) => wss.once('listening', resolve))
  const { port } = wss.address() as AddressInfo
  url = `ws://127.0.0.1:${port}`
})

afterEach(async () => {
  for (const client of wss.clients) client.terminate()
  await new Promise<void>((resolve) => wss.close(() => resolve()))
})

function connect(headers: Record<string, string> = {}): WebSocket {
  return new WebSocket(url, { headers })
}

const validSnapshot = () => ({
  collectedAt: '2026-08-01T12:00:00.000Z',
  systems: [
    {
      key: 'alpha',
      displayName: 'alpha',
      health: 'healthy',
      containers: { total: 1, running: 1 },
      deployedSha: 'a'.repeat(40),
      deployedSubject: 'feat: x',
      deployedAt: '2026-08-01T10:00:00.000Z',
      driftCommits: 0,
    },
  ],
})

function waitForClose(client: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    client.once('close', (code: number, reason: Buffer) => resolve({ code, reason: reason.toString() }))
  })
}

describe('ingest-server', () => {
  it('closes a connection with no Authorization header, before any message is ever ingested', async () => {
    const client = connect()
    const closed = waitForClose(client)
    client.once('open', () => client.send(JSON.stringify({ type: 'snapshot', payload: validSnapshot() })))
    const { code } = await closed
    expect(code).toBe(4001)
    // Give any (wrongly) processed message a moment to land before checking.
    await new Promise((r) => setTimeout(r, 100))
    expect(await prisma.systemObservation.count()).toBe(0)
  })

  it('closes a connection presenting an invalid token, before any message is ever ingested', async () => {
    const client = connect({ authorization: 'Bearer not-a-real-token-at-all' })
    const closed = waitForClose(client)
    client.once('open', () => client.send(JSON.stringify({ type: 'snapshot', payload: validSnapshot() })))
    const { code } = await closed
    expect(code).toBe(4001)
    await new Promise((r) => setTimeout(r, 100))
    expect(await prisma.systemObservation.count()).toBe(0)
  })

  it('closes a connection presenting a revoked token, before any message is ever ingested', async () => {
    await revokeAgent('host-a')
    const client = connect({ authorization: `Bearer ${token}` })
    const closed = waitForClose(client)
    client.once('open', () => client.send(JSON.stringify({ type: 'snapshot', payload: validSnapshot() })))
    const { code } = await closed
    expect(code).toBe(4001)
    await new Promise((r) => setTimeout(r, 100))
    expect(await prisma.systemObservation.count()).toBe(0)
  })

  it('accepts a valid token, ingests a sent snapshot for real, and acks it', async () => {
    const client = connect({ authorization: `Bearer ${token}` })
    const ack = await new Promise<unknown>((resolve, reject) => {
      client.once('open', () => client.send(JSON.stringify({ type: 'snapshot', payload: validSnapshot() })))
      client.once('message', (data: Buffer) => resolve(JSON.parse(data.toString())))
      client.once('close', (code: number, reason: Buffer) =>
        reject(new Error(`closed unexpectedly: ${code} ${reason.toString()}`)),
      )
    })
    expect(ack).toEqual({ type: 'ack', accepted: 1 })
    const system = await prisma.system.findFirstOrThrow({ where: { hostId } })
    expect(system.key).toBe('alpha')
    expect(await prisma.systemObservation.count()).toBe(1)
    client.close()
  })

  it('replies with a generic error for a malformed (non-JSON) message, and keeps working afterwards', async () => {
    const client = connect({ authorization: `Bearer ${token}` })
    const firstReply = await new Promise<{ type: string; message: string }>((resolve) => {
      client.once('open', () => client.send('this is not json'))
      client.once('message', (data: Buffer) => resolve(JSON.parse(data.toString())))
    })
    expect(firstReply.type).toBe('error')
    expect(typeof firstReply.message).toBe('string')

    // The connection must still be usable afterwards -- proof the malformed
    // message did not take the per-connection handler down.
    const secondReply = await new Promise<unknown>((resolve) => {
      client.once('message', (data: Buffer) => resolve(JSON.parse(data.toString())))
      client.send(JSON.stringify({ type: 'snapshot', payload: validSnapshot() }))
    })
    expect(secondReply).toEqual({ type: 'ack', accepted: 1 })
    client.close()
  })

  it('never leaks schema-shape or database detail in the close reason or an error reply', async () => {
    const unauth = connect()
    const { reason } = await waitForClose(unauth)
    for (const leak of ['collectedAt', 'systems', 'System', 'SystemObservation', 'hostId_key', 'Prisma']) {
      expect(reason).not.toContain(leak)
    }

    const client = connect({ authorization: `Bearer ${token}` })
    const errorReply = await new Promise<{ type: string; message: string }>((resolve) => {
      client.once('open', () =>
        client.send(JSON.stringify({ type: 'snapshot', payload: { collectedAt: 'not-a-date', systems: [] } })),
      )
      client.once('message', (data: Buffer) => resolve(JSON.parse(data.toString())))
    })
    expect(errorReply.type).toBe('error')
    for (const leak of ['collectedAt', 'systems', '"path"', 'invalid_string', 'invalid_type', 'System', 'Prisma']) {
      expect(errorReply.message).not.toContain(leak)
    }
    client.close()
  })

  // AGENT_HOST_NAME used to be a required agent setting that NOTHING read,
  // while deploy/README.md told operators it "must match the name used at
  // enrolment" -- which it neither must nor could, since identity comes
  // entirely from the token. It now has exactly one job: catching the case
  // where one host's token is installed on a different host, which
  // otherwise files that machine's systems under someone else's row
  // silently and forever.
  describe('agent hello / host-name mismatch detection', () => {
    function sendHello(client: WebSocket, hostName: string): Promise<void> {
      return new Promise((resolve) => {
        client.once('open', () => {
          client.send(JSON.stringify({ type: 'hello', hostName }))
          resolve()
        })
      })
    }

    it('logs a warning when the agent reports a different host name than its token belongs to', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      try {
        const client = connect({ authorization: `Bearer ${token}` })
        await sendHello(client, 'some-other-host')
        await vi.waitFor(() => expect(warn).toHaveBeenCalled())
        const logged = warn.mock.calls.map((args) => args.map(String).join(' ')).join('\n')
        expect(logged).toContain('some-other-host')
        expect(logged).toContain('host-a')
        client.close()
      } finally {
        warn.mockRestore()
      }
    })

    it('says nothing when the reported host name matches the token', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      try {
        const client = connect({ authorization: `Bearer ${token}` })
        await sendHello(client, 'host-a')
        // Long enough for a wrongly-emitted warning to have been emitted.
        await new Promise((r) => setTimeout(r, 150))
        expect(warn).not.toHaveBeenCalled()
        client.close()
      } finally {
        warn.mockRestore()
      }
    })

    it('keeps accepting snapshots after a MISMATCHED hello: the token stays authoritative, a typo never takes a host off the board', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      try {
        const client = connect({ authorization: `Bearer ${token}` })
        const ack = await new Promise<unknown>((resolve, reject) => {
          client.once('open', () => {
            client.send(JSON.stringify({ type: 'hello', hostName: 'wrong-name-entirely' }))
            client.send(JSON.stringify({ type: 'snapshot', payload: validSnapshot() }))
          })
          client.once('message', (data: Buffer) => resolve(JSON.parse(data.toString())))
          client.once('close', (code: number) => reject(new Error(`closed unexpectedly: ${code}`)))
        })
        expect(ack).toEqual({ type: 'ack', accepted: 1 })
        // Filed under the TOKEN's host, not the name the agent claimed.
        const system = await prisma.system.findFirstOrThrow({ where: { hostId } })
        expect(system.key).toBe('alpha')
        client.close()
      } finally {
        warn.mockRestore()
      }
    })

    it('does not answer a hello with a snapshot rejection', async () => {
      // A hello is not a snapshot; routing it into the snapshot path would
      // make every agent connection start with a spurious error reply.
      const client = connect({ authorization: `Bearer ${token}` })
      let reply: unknown = null
      client.on('message', (data: Buffer) => {
        reply = JSON.parse(data.toString())
      })
      await sendHello(client, 'host-a')
      await new Promise((r) => setTimeout(r, 150))
      expect(reply).toBeNull()
      client.close()
    })
  })

  // The listener is reached from other machines across the internet (TLS
  // terminates at a proxy in front of it) and runs on a 1 GB droplet.
  describe('resource limits on an internet-facing listener', () => {
    it('refuses a message larger than the configured maximum instead of buffering it', async () => {
      const small = startIngestServer({
        host: '127.0.0.1',
        port: 0,
        maxPayloadBytes: 256,
        maxConnections: 64,
      })
      try {
        await new Promise<void>((resolve) => small.once('listening', resolve))
        const { port } = small.address() as AddressInfo
        const client = new WebSocket(`ws://127.0.0.1:${port}`, {
          headers: { authorization: `Bearer ${token}` },
        })
        const closed = waitForClose(client)
        client.once('open', () => client.send('x'.repeat(10_000)))
        // 1009 is the RFC 6455 "message too big" close code, which `ws`
        // sends itself once maxPayload is exceeded -- proof the frame was
        // rejected rather than read into memory.
        expect((await closed).code).toBe(1009)
      } finally {
        for (const c of small.clients) c.terminate()
        await new Promise<void>((resolve) => small.close(() => resolve()))
      }
    })

    it('closes a connection over the cap BEFORE authenticating it, so an unauthenticated peer cannot drive database load', async () => {
      const capped = startIngestServer({
        host: '127.0.0.1',
        port: 0,
        maxPayloadBytes: 1024 * 1024,
        maxConnections: 1,
      })
      const open: WebSocket[] = []
      try {
        await new Promise<void>((resolve) => capped.once('listening', resolve))
        const { port } = capped.address() as AddressInfo
        const dial = (authorization?: string) => {
          const c = new WebSocket(`ws://127.0.0.1:${port}`, authorization ? { headers: { authorization } } : {})
          open.push(c)
          return c
        }

        // The first connection is a LEGITIMATE, authenticated agent, so it
        // stays open and genuinely occupies the single available slot. (An
        // unauthenticated first connection would be closed immediately and
        // free its slot again, so the cap would never be reached and this
        // test would prove nothing -- which is exactly what happened on the
        // first attempt: it saw 4001, not 4002.)
        const first = dial(`Bearer ${token}`)
        await new Promise<void>((resolve) => first.once('open', resolve))
        await vi.waitFor(() => expect(capped.clients.size).toBe(1))

        // The second connection carries NO Authorization header. If the cap
        // were absent it would reach `authenticateAgent` and be closed 4001
        // (unauthorized) after a database round trip. Getting 4002 is only
        // possible on the path that returns BEFORE authentication, which is
        // the whole point: the cheap defence must run before the expensive
        // check.
        const second = dial()
        const { code } = await waitForClose(second)
        expect(code).toBe(4002)
        expect(code).not.toBe(4001)
      } finally {
        for (const c of open) c.terminate()
        for (const c of capped.clients) c.terminate()
        await new Promise<void>((resolve) => capped.close(() => resolve()))
      }
    })
  })

  // H3 (fix round 1, Task 9 review): the external probe scheduler's ONLY
  // production call site is this file's `import.meta.url` self-start guard,
  // which is unreachable from any test that merely imports this module (the
  // guard is only true when the file is run as a script). Before
  // `startIngestProcess` was split out and exported, commenting out
  // `startExternalProbeScheduler()` from that guard left every test in the
  // suite passing. This test calls the REAL exported function (not a
  // reimplementation of the guard's body) and substitutes a spy for the
  // scheduler parameter, so mutating the real call away is caught here
  // rather than nowhere.
  describe('startIngestProcess (H3)', () => {
    it('starts the external probe scheduler as part of starting the real ingest process', async () => {
      let schedulerCalls = 0
      const spyScheduler = (): (() => void) => {
        schedulerCalls += 1
        return () => {}
      }

      const ingestProc = startIngestProcess(
        { host: '127.0.0.1', port: 0, maxPayloadBytes: 1024 * 1024, maxConnections: 64 },
        spyScheduler,
      )
      try {
        await new Promise<void>((resolve) => ingestProc.once('listening', resolve))
        expect(schedulerCalls).toBe(1)
      } finally {
        await new Promise<void>((resolve) => ingestProc.close(() => resolve()))
      }
    })

    it('returns the same live WebSocketServer startIngestServer would, still reachable for real connections', async () => {
      const wss2 = startIngestProcess(
        { host: '127.0.0.1', port: 0, maxPayloadBytes: 1024 * 1024, maxConnections: 64 },
        () => () => {},
      )
      try {
        await new Promise<void>((resolve) => wss2.once('listening', resolve))
        const { port } = wss2.address() as AddressInfo
        const client = new WebSocket(`ws://127.0.0.1:${port}`)
        const { code } = await waitForClose(client)
        // No Authorization header -- rejected, same as any other connection
        // to this listener. Proves this is a genuine, working ingest
        // listener, not a stub.
        expect(code).toBe(4001)
      } finally {
        await new Promise<void>((resolve) => wss2.close(() => resolve()))
      }
    })
  })
})
