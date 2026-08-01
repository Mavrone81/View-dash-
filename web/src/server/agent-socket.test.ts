import { describe, it, expect, beforeEach } from 'vitest'
import { prisma } from '../lib/db.js'
import { enrolAgent } from './auth-agent.js'
import { handleSnapshotMessage } from './agent-socket.js'

let hostId: string

beforeEach(async () => {
  await prisma.systemObservation.deleteMany()
  await prisma.system.deleteMany()
  await prisma.agentEnrolment.deleteMany()
  await prisma.host.deleteMany()
  hostId = (await enrolAgent('host-a')).hostId
})

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

describe('handleSnapshotMessage', () => {
  it('acks a valid snapshot with the accepted count', async () => {
    const res = await handleSnapshotMessage(hostId, validSnapshot())
    expect(res).toEqual({ type: 'ack', accepted: 1 })
  })

  it('returns an error (not a thrown exception) for a schema-invalid snapshot', async () => {
    const res = await handleSnapshotMessage(hostId, { collectedAt: 'not-a-date', systems: [{ key: '' }] })
    expect(res.type).toBe('error')
  })

  // This is the carried-forward finding from Task 10's review: ingestSnapshot
  // throws ZodErrors carrying field paths/enum values, and can throw raw
  // Prisma errors naming tables/columns. Neither may ever reach a peer that
  // merely holds a valid agent token.
  it('never leaks schema-shape detail (Zod field paths, issue codes) in the error response', async () => {
    const res = await handleSnapshotMessage(hostId, { collectedAt: 'not-a-date', systems: [{ key: '' }] })
    expect(res.type).toBe('error')
    const message = res.type === 'error' ? res.message : ''
    for (const leak of ['collectedAt', 'systems', '"path"', 'invalid_string', 'invalid_type', 'too_small']) {
      expect(message).not.toContain(leak)
    }
  })

  // A snapshot for a hostId with no matching Host row fails the foreign-key
  // constraint on System.hostId inside the transaction -- a REAL raw Prisma
  // error naming the table/column, not a fabricated example.
  it('never leaks database detail (table/column names) when the host row does not exist', async () => {
    const res = await handleSnapshotMessage('00000000-0000-0000-0000-000000000000', validSnapshot())
    expect(res.type).toBe('error')
    const message = res.type === 'error' ? res.message : ''
    for (const leak of ['System', 'SystemObservation', 'hostId_key', 'Prisma', 'foreign key', 'constraint']) {
      expect(message).not.toContain(leak)
    }
  })

  it('returns the SAME generic message for every rejection reason, so the response cannot be used to distinguish failure causes', async () => {
    const schemaRejected = await handleSnapshotMessage(hostId, { collectedAt: 'not-a-date', systems: [] })
    const noSuchHost = await handleSnapshotMessage('00000000-0000-0000-0000-000000000000', validSnapshot())
    expect(schemaRejected.type).toBe('error')
    expect(noSuchHost.type).toBe('error')
    if (schemaRejected.type === 'error' && noSuchHost.type === 'error') {
      expect(schemaRejected.message).toBe(noSuchHost.message)
    }
  })
})
