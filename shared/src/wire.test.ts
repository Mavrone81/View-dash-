import { describe, it, expect } from 'vitest'
import { FleetSnapshotSchema } from './wire.js'

const system = {
  key: 'proj-a',
  displayName: 'proj-a',
  health: 'healthy',
  containers: { total: 3, running: 3 },
  deployedSha: 'a'.repeat(40),
  deployedSubject: 'fix: something',
  deployedAt: '2026-08-01T10:00:00.000Z',
  driftCommits: 0,
}

describe('FleetSnapshotSchema', () => {
  it('accepts a complete snapshot', () => {
    const r = FleetSnapshotSchema.safeParse({ collectedAt: '2026-08-01T10:00:00.000Z', systems: [system] })
    expect(r.success).toBe(true)
  })

  it('accepts a system with everything unknown', () => {
    const r = FleetSnapshotSchema.safeParse({
      collectedAt: '2026-08-01T10:00:00.000Z',
      systems: [{ key: 'p', displayName: 'p', health: 'unknown', containers: { total: 0, running: 0 },
                  deployedSha: null, deployedSubject: null, deployedAt: null, driftCommits: null }],
    })
    expect(r.success).toBe(true)
  })

  it('rejects an unknown health value', () => {
    const r = FleetSnapshotSchema.safeParse({ collectedAt: '2026-08-01T10:00:00.000Z',
      systems: [{ ...system, health: 'green' }] })
    expect(r.success).toBe(false)
  })

  it('rejects a short sha', () => {
    const r = FleetSnapshotSchema.safeParse({ collectedAt: '2026-08-01T10:00:00.000Z',
      systems: [{ ...system, deployedSha: 'abc' }] })
    expect(r.success).toBe(false)
  })
})
