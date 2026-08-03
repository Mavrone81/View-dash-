import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { PrismaClient } from '@prisma/client'
import { prisma } from './db.js'
import {
  shouldRunExternalProbe,
  EXTERNAL_PROBE_INTERVAL_MS,
  runExternalProbeCycle,
  type SchedulerLogger,
} from './probe-scheduler.js'
import { EXTERNAL_PROBE_INTERVAL_MS as FLEET_QUERY_EXTERNAL_PROBE_INTERVAL_MS } from './fleet-query.js'
import type { ExternalDeps } from './external-probe.js'

beforeEach(async () => {
  await prisma.externalProbeResult.deleteMany()
  await prisma.externalProbeRun.deleteMany()
  await prisma.systemObservation.deleteMany()
  await prisma.system.deleteMany()
  await prisma.host.deleteMany()
})

function silentLogger(): { log: SchedulerLogger; entries: unknown[][] } {
  const entries: unknown[][] = []
  return {
    log: {
      warn: (...args: unknown[]) => entries.push(args),
      error: (...args: unknown[]) => entries.push(args),
    },
    entries,
  }
}

describe('external probe cadence', () => {
  it('runs when nothing has ever run', () => {
    expect(shouldRunExternalProbe(null, new Date('2026-08-03T00:00:00Z'))).toBe(true)
  })

  it('does not run again within the interval', () => {
    const last = new Date('2026-08-03T00:00:00Z')
    const soon = new Date(last.getTime() + EXTERNAL_PROBE_INTERVAL_MS - 1)
    expect(shouldRunExternalProbe(last, soon)).toBe(false)
  })

  it('runs once the interval has elapsed', () => {
    const last = new Date('2026-08-03T00:00:00Z')
    const later = new Date(last.getTime() + EXTERNAL_PROBE_INTERVAL_MS)
    expect(shouldRunExternalProbe(last, later)).toBe(true)
  })
})

// Fix round obligation carried from Task 8's review: nothing in the type
// system stops this module from picking its own interval instead of
// importing `fleet-query.ts`'s. If it did, `EXTERNAL_RESULT_STALE_AFTER_MS`
// there (derived as `EXTERNAL_PROBE_INTERVAL_MS * 3`) would silently stop
// meaning "three missed cycles" the moment either number changed without the
// other. This is a governance test, not a behavioural one: value equality
// alone (the first assertion) would still pass if this file hardcoded the
// same literal, so the second assertion inspects the SOURCE directly to
// confirm this constant is an import, not a redefinition.
describe('the interval is imported, not redefined', () => {
  it('is numerically identical to fleet-query.ts\'s constant', () => {
    expect(EXTERNAL_PROBE_INTERVAL_MS).toBe(FLEET_QUERY_EXTERNAL_PROBE_INTERVAL_MS)
  })

  it('is an import from fleet-query.ts in the source, and defines no numeric literal of its own', () => {
    const path = fileURLToPath(new URL('./probe-scheduler.ts', import.meta.url))
    const source = readFileSync(path, 'utf8')
    expect(source).toMatch(/EXTERNAL_PROBE_INTERVAL_MS as FLEET_QUERY_EXTERNAL_PROBE_INTERVAL_MS/)
    expect(source).toMatch(/from '\.\/fleet-query\.js'/)
    // 300_000 (or 300000) is five minutes in milliseconds. This checks for
    // an actual ASSIGNMENT of that literal (`= 300_000`), not merely the
    // digits appearing anywhere -- this file's own docstrings quote
    // `300_000` in backticks, in prose, to explain why it must NOT be
    // written as an assignment here, and a substring-only check would flag
    // its own explanation as a violation.
    expect(source).not.toMatch(/=\s*300[_,]?000\b/)
  })
})

describe('runExternalProbeCycle', () => {
  it('does nothing when the last sweep is still within the interval', async () => {
    await prisma.externalProbeRun.create({
      data: { ranAt: new Date('2026-08-03T00:00:00Z'), reachedAnything: true },
    })
    let requestCalls = 0
    const deps: ExternalDeps = { request: async () => (requestCalls++, { status: 200, certExpiresAt: null }) }

    await runExternalProbeCycle(new Date('2026-08-03T00:01:00Z'), deps, prisma)

    expect(requestCalls).toBe(0)
    expect(await prisma.externalProbeRun.count()).toBe(1) // no new sweep recorded
  })

  it('runs a sweep, against the fleet\'s current hostnames, once the interval has elapsed', async () => {
    await prisma.externalProbeRun.create({
      data: {
        ranAt: new Date('2026-08-03T00:00:00Z'),
        reachedAnything: true,
      },
    })
    const host = await prisma.host.create({ data: { name: 'sched-host' } })
    const system = await prisma.system.create({
      data: { hostId: host.id, key: 'sched-sys', displayName: 'sched-sys' },
    })
    await prisma.systemObservation.create({
      data: {
        systemId: system.id,
        health: 'healthy',
        containersTotal: 1,
        containersRunning: 1,
        hostnames: [{ hostname: 'due.example.invalid', listensTls: true }],
      },
    })

    const seen: string[] = []
    const deps: ExternalDeps = {
      request: async (hostname) => {
        seen.push(hostname)
        return { status: 200, certExpiresAt: null }
      },
    }

    // A full interval after the seeded run -- due.
    await runExternalProbeCycle(
      new Date(new Date('2026-08-03T00:00:00Z').getTime() + EXTERNAL_PROBE_INTERVAL_MS),
      deps,
      prisma,
    )

    expect(seen).toEqual(['due.example.invalid'])
    expect(await prisma.externalProbeRun.count()).toBe(2)
  })

  it('runs immediately when no sweep has ever run (a fresh deploy)', async () => {
    const host = await prisma.host.create({ data: { name: 'sched-host-fresh' } })
    const system = await prisma.system.create({
      data: { hostId: host.id, key: 'sched-sys-fresh', displayName: 'sched-sys-fresh' },
    })
    await prisma.systemObservation.create({
      data: {
        systemId: system.id,
        health: 'healthy',
        containersTotal: 1,
        containersRunning: 1,
        hostnames: [{ hostname: 'fresh.example.invalid', listensTls: null }],
      },
    })
    const seen: string[] = []
    const deps: ExternalDeps = {
      request: async (hostname) => {
        seen.push(hostname)
        return { status: 200, certExpiresAt: null }
      },
    }

    await runExternalProbeCycle(new Date(), deps, prisma)

    expect(seen).toEqual(['fresh.example.invalid'])
  })

  // Scheduled-path rule, restated everywhere in this slice: a failure in a
  // diagnostic must never propagate to whatever called it. A real,
  // unreachable database (a closed loopback port, not a mock) forces
  // `latestExternalProbeRun`'s own query to reject, which is exactly the
  // kind of operational fault `runExternalProbeCycle`'s own try/catch exists
  // to contain -- lower layers (`probeExternally`, `runExternalProbes`'s
  // handling of a probe failure) never throw in the first place, so THIS is
  // the one layer whose own containment can actually be exercised.
  it('never throws, even when the database itself is unreachable', async () => {
    const brokenClient = new PrismaClient({
      datasources: { db: { url: 'postgresql://invalid:invalid@127.0.0.1:1/nonexistent' } },
    })
    const { log, entries } = silentLogger()
    const deps: ExternalDeps = { request: async () => ({ status: 200, certExpiresAt: null }) }

    await expect(runExternalProbeCycle(new Date(), deps, brokenClient, log)).resolves.toBeUndefined()
    expect(entries.length).toBeGreaterThan(0)
    await brokenClient.$disconnect()
  })
})
