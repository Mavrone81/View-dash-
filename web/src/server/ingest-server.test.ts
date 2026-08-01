import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { WebSocket, type WebSocketServer } from 'ws'
import type { AddressInfo } from 'node:net'
import { prisma } from '../lib/db.js'
import { enrolAgent, revokeAgent } from './auth-agent.js'
import { startIngestServer } from './ingest-server.js'

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
  wss = startIngestServer({ host: '127.0.0.1', port: 0 })
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
})
