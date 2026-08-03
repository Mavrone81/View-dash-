import { describe, it, expect } from 'vitest'
import {
  FleetSnapshotSchema,
  SystemStateSchema,
  classifyHttpStatus,
  classifyProbeFailure,
  probeOutcomeToHealth,
} from './wire.js'

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

  it('rejects empty key', () => {
    const r = FleetSnapshotSchema.safeParse({ collectedAt: '2026-08-01T10:00:00.000Z',
      systems: [{ ...system, key: '' }] })
    expect(r.success).toBe(false)
  })

  it('rejects empty displayName', () => {
    const r = FleetSnapshotSchema.safeParse({ collectedAt: '2026-08-01T10:00:00.000Z',
      systems: [{ ...system, displayName: '' }] })
    expect(r.success).toBe(false)
  })

  it('rejects negative containers.total', () => {
    const r = FleetSnapshotSchema.safeParse({ collectedAt: '2026-08-01T10:00:00.000Z',
      systems: [{ ...system, containers: { total: -1, running: 3 } }] })
    expect(r.success).toBe(false)
  })

  it('rejects negative containers.running', () => {
    const r = FleetSnapshotSchema.safeParse({ collectedAt: '2026-08-01T10:00:00.000Z',
      systems: [{ ...system, containers: { total: 3, running: -1 } }] })
    expect(r.success).toBe(false)
  })

  it('rejects negative driftCommits', () => {
    const r = FleetSnapshotSchema.safeParse({ collectedAt: '2026-08-01T10:00:00.000Z',
      systems: [{ ...system, driftCommits: -1 }] })
    expect(r.success).toBe(false)
  })

  it('rejects invalid deployedAt datetime', () => {
    const r = FleetSnapshotSchema.safeParse({ collectedAt: '2026-08-01T10:00:00.000Z',
      systems: [{ ...system, deployedAt: 'not-a-datetime' }] })
    expect(r.success).toBe(false)
  })

  it('rejects invalid collectedAt datetime', () => {
    const r = FleetSnapshotSchema.safeParse({ collectedAt: 'not-a-datetime',
      systems: [system] })
    expect(r.success).toBe(false)
  })

  it('rejects over-long deployedSha', () => {
    const r = FleetSnapshotSchema.safeParse({ collectedAt: '2026-08-01T10:00:00.000Z',
      systems: [{ ...system, deployedSha: 'a'.repeat(41) }] })
    expect(r.success).toBe(false)
  })
})

describe('SystemStateSchema.hostnames / onBoxProbes (Task 5)', () => {
  it('accepts a system with neither field -- an OLDER agent, from before these fields existed', () => {
    // .optional(), not .default([]): an absent key must parse to `undefined`,
    // never silently become `[]`, or "we do not know this tick" would read
    // identically to "we looked and found nothing" downstream.
    const r = SystemStateSchema.safeParse(system)
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.data.hostnames).toBeUndefined()
      expect(r.data.onBoxProbes).toBeUndefined()
    }
  })

  it('accepts a system that genuinely has zero hostnames and zero probes, distinct from omitting the fields', () => {
    const r = SystemStateSchema.safeParse({ ...system, hostnames: [], onBoxProbes: [] })
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.data.hostnames).toEqual([])
      expect(r.data.onBoxProbes).toEqual([])
    }
  })

  it('accepts a named hostname with its listensTls bit, and a matching probe result', () => {
    const r = SystemStateSchema.safeParse({
      ...system,
      hostnames: [{ hostname: 'alpha.example.invalid', listensTls: true }],
      onBoxProbes: [{ hostname: 'alpha.example.invalid', outcome: 'proxy-no-upstream', status: 502 }],
    })
    expect(r.success).toBe(true)
  })

  it('accepts a null hostname on a probe result -- an unmapped port, a real fact, not an unknown', () => {
    const r = SystemStateSchema.safeParse({
      ...system,
      onBoxProbes: [{ hostname: null, outcome: 'not-probed', status: null }],
    })
    expect(r.success).toBe(true)
  })

  it('rejects a null hostname in the CONFIG list -- unlike a probe result, an unnamed vhost entry is not a thing', () => {
    const r = SystemStateSchema.safeParse({
      ...system,
      hostnames: [{ hostname: null, listensTls: false }],
    })
    expect(r.success).toBe(false)
  })

  it('rejects an unknown probe outcome value', () => {
    const r = SystemStateSchema.safeParse({
      ...system,
      onBoxProbes: [{ hostname: 'alpha.example.invalid', outcome: 'flaky', status: 200 }],
    })
    expect(r.success).toBe(false)
  })

  it('accepts a null listensTls -- the hostname is known but its TLS bit was not determined this tick', () => {
    const r = SystemStateSchema.safeParse({
      ...system,
      hostnames: [{ hostname: 'alpha.example.invalid', listensTls: null }],
    })
    expect(r.success).toBe(true)
  })

  it('rejects a non-boolean, non-null listensTls', () => {
    const r = SystemStateSchema.safeParse({
      ...system,
      hostnames: [{ hostname: 'alpha.example.invalid', listensTls: 'yes' }],
    })
    expect(r.success).toBe(false)
  })
})

describe('probe classification', () => {
  it('treats 2xx and 3xx as answering', () => {
    for (const s of [200, 201, 204, 301, 302, 307, 308]) {
      expect(classifyHttpStatus(s)).toBe('answering')
    }
  })

  // A login wall is an application doing its job. Measured against the live
  // host, a "200 is healthy" rule would have marked 19 of 42 hostnames
  // broken while they worked correctly.
  it('treats 401 and 403 as answering, NOT as a fault', () => {
    expect(classifyHttpStatus(401)).toBe('answering')
    expect(classifyHttpStatus(403)).toBe('answering')
  })

  it('treats other 4xx as answering oddly', () => {
    expect(classifyHttpStatus(404)).toBe('answering-oddly')
    expect(classifyHttpStatus(418)).toBe('answering-oddly')
  })

  // 502 and 504 come from the PROXY, not the application: they are exactly
  // what is served when the proxy is healthy and the container behind it is
  // not. That is the fault this slice exists to catch, so it gets its own
  // outcome rather than being folded into a generic 5xx.
  it('names 502 and 504 as the proxy having no upstream', () => {
    expect(classifyHttpStatus(502)).toBe('proxy-no-upstream')
    expect(classifyHttpStatus(504)).toBe('proxy-no-upstream')
  })

  it('treats other 5xx as not answering', () => {
    expect(classifyHttpStatus(500)).toBe('not-answering')
    expect(classifyHttpStatus(503)).toBe('not-answering')
  })

  it('keeps a TLS failure distinct from an application being down', () => {
    expect(classifyProbeFailure('tls')).toBe('tls-failed')
    expect(classifyProbeFailure('network')).toBe('not-answering')
    expect(classifyProbeFailure('timeout')).toBe('not-answering')
  })

  it('maps outcomes onto health, with not-probed expressing NO opinion', () => {
    expect(probeOutcomeToHealth('answering')).toBe('healthy')
    expect(probeOutcomeToHealth('answering-oddly')).toBe('degraded')
    expect(probeOutcomeToHealth('not-answering')).toBe('down')
    expect(probeOutcomeToHealth('proxy-no-upstream')).toBe('down')
    expect(probeOutcomeToHealth('tls-failed')).toBe('down')
    // null, never 'healthy': "we did not look" must not read as "we looked
    // and it was fine".
    expect(probeOutcomeToHealth('not-probed')).toBeNull()
  })
})
