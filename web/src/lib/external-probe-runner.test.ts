import { describe, it, expect, beforeEach } from 'vitest'
import type { HostnameConfig } from '@bevora-ops/shared'
import { prisma } from './db.js'
import { runExternalProbes } from './external-probe-runner.js'
import type { ExternalDeps, ExternalScheme } from './external-probe.js'

// This table is new in this migration and touched by no other spec file,
// so a wholesale wipe here is safe under `vitest.config.ts`'s
// `fileParallelism: false` -- see fleet-query.test.ts's own comment on the
// same pattern for `SystemObservation`.
beforeEach(async () => {
  await prisma.externalProbeResult.deleteMany()
  await prisma.externalProbeRun.deleteMany()
})

const HOST_A = 'runner-a.example.invalid'
const HOST_B = 'runner-b.example.invalid'
const HOST_C = 'runner-c.example.invalid'

/**
 * `runExternalProbes` takes `HostnameConfig[]`, not a bare hostname list --
 * see that function's own docstring for why (`listensTls` must travel with
 * each hostname all the way to `probeExternally`). Every test in this file
 * except the "carries listensTls through" group below is indifferent to
 * `listensTls`, so this helper defaults it to `null` (undetermined) to keep
 * every other test's intent focused on what it actually means to exercise.
 */
function target(hostname: string, listensTls: boolean | null = null): HostnameConfig {
  return { hostname, listensTls }
}

/** A network failure with the shape `probeExternally` expects to classify as `not-answering`. */
function networkFailure(): Error {
  return Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })
}

/** A TLS verification failure `probeExternally` classifies as `tls-failed`. */
function tlsFailure(): Error {
  return Object.assign(new Error('certificate has expired'), { code: 'CERT_HAS_EXPIRED' })
}

/** Builds fake `ExternalDeps` from a hostname -> outcome map. */
function depsFor(
  outcomes: Record<string, { status: number; certExpiresAt: Date | null } | Error>,
): ExternalDeps {
  return {
    request: async (hostname: string) => {
      const outcome = outcomes[hostname]
      if (outcome === undefined) throw new Error(`unexpected hostname in test: ${hostname}`)
      if (outcome instanceof Error) throw outcome
      return outcome
    },
  }
}

describe('runExternalProbes', () => {
  it('stores a result per hostname and it is readable back from the database', async () => {
    const certExpiresAt = new Date('2030-01-01T00:00:00Z')
    const deps = depsFor({ [HOST_A]: { status: 200, certExpiresAt } })

    await runExternalProbes([target(HOST_A)], deps)

    // Asserting on the STORED ROW, not on the value `runExternalProbes`
    // happened to return -- a test that only checked the return value
    // would pass even if the `createMany` call were silently dropped.
    const rows = await prisma.externalProbeResult.findMany({ where: { hostname: HOST_A } })
    expect(rows).toHaveLength(1)
    expect(rows[0]?.hostname).toBe(HOST_A)
    expect(rows[0]?.outcome).toBe('answering')
    expect(rows[0]?.status).toBe(200)
    expect(rows[0]?.certExpiresAt?.toISOString()).toBe(certExpiresAt.toISOString())
  })

  it('stores two hostnames on one system independently -- a failing one is not averaged into a passing sibling', async () => {
    const deps = depsFor({
      [HOST_A]: { status: 200, certExpiresAt: null },
      [HOST_B]: networkFailure(),
    })

    await runExternalProbes([target(HOST_A), target(HOST_B)], deps)

    const rows = await prisma.externalProbeResult.findMany({ orderBy: { hostname: 'asc' } })
    expect(rows).toHaveLength(2)
    const byHostname = new Map(rows.map((r) => [r.hostname, r]))
    expect(byHostname.get(HOST_A)?.outcome).toBe('answering')
    expect(byHostname.get(HOST_B)?.outcome).toBe('not-answering')
  })

  it('stores certExpiresAt as null when the handshake failed', async () => {
    // HOST_B is a passing companion so this run is a PARTIAL failure, not a
    // fleet-wide one -- a run where the only hostname probed also happens
    // to be the only one that failed is indistinguishable, to
    // `isFleetWideExternalFailure`, from every hostname on the whole board
    // failing at once, and correctly stores nothing (see the fleet-wide
    // tests below). That guard is not what this test means to exercise.
    const deps = depsFor({
      [HOST_A]: tlsFailure(),
      [HOST_B]: { status: 200, certExpiresAt: null },
    })

    await runExternalProbes([target(HOST_A), target(HOST_B)], deps)

    const row = await prisma.externalProbeResult.findFirst({ where: { hostname: HOST_A } })
    expect(row?.outcome).toBe('tls-failed')
    expect(row?.certExpiresAt).toBeNull()
  })

  it('never carries a previous successful probe\'s certExpiresAt forward into a later failed one for the SAME hostname', async () => {
    const firstExpiry = new Date('2031-05-05T00:00:00Z')
    await runExternalProbes(
      [target(HOST_A), target(HOST_B)],
      depsFor({
        [HOST_A]: { status: 200, certExpiresAt: firstExpiry },
        [HOST_B]: { status: 200, certExpiresAt: null },
      }),
    )

    // Confirm the first row really did land with a non-null expiry, so the
    // second assertion below is testing "did not carry forward", not
    // "was never set in the first place".
    const afterFirst = await prisma.externalProbeResult.findMany({ where: { hostname: HOST_A } })
    expect(afterFirst).toHaveLength(1)
    expect(afterFirst[0]?.certExpiresAt).not.toBeNull()

    // HOST_B stays passing so this second run is also partial, not
    // fleet-wide, and HOST_A's new failing row is actually stored.
    await runExternalProbes(
      [target(HOST_A), target(HOST_B)],
      depsFor({ [HOST_A]: networkFailure(), [HOST_B]: { status: 200, certExpiresAt: null } }),
    )

    const afterSecond = await prisma.externalProbeResult.findMany({
      where: { hostname: HOST_A },
      orderBy: { observedAt: 'desc' },
    })
    expect(afterSecond).toHaveLength(2)
    // The newest row is this run's failure, and its certExpiresAt must be
    // null -- not the previous row's remembered value.
    expect(afterSecond[0]?.outcome).toBe('not-answering')
    expect(afterSecond[0]?.certExpiresAt).toBeNull()
  })

  it('stores a result carrying an observation time', async () => {
    const before = new Date()
    await runExternalProbes([target(HOST_A)], depsFor({ [HOST_A]: { status: 200, certExpiresAt: null } }))
    const after = new Date()

    const row = await prisma.externalProbeResult.findFirst({ where: { hostname: HOST_A } })
    expect(row?.observedAt).toBeInstanceOf(Date)
    expect(row!.observedAt.getTime()).toBeGreaterThanOrEqual(before.getTime())
    expect(row!.observedAt.getTime()).toBeLessThanOrEqual(after.getTime())
  })

  it('writes nothing when every probed hostname fails in the same run (fleet-wide guard)', async () => {
    const deps = depsFor({
      [HOST_A]: networkFailure(),
      [HOST_B]: tlsFailure(),
      [HOST_C]: networkFailure(),
    })

    const result = await runExternalProbes([target(HOST_A), target(HOST_B), target(HOST_C)], deps)

    expect(result.stored).toBe(false)
    expect(result.results).toHaveLength(3) // the probes still ran and are still returned to the caller
    const count = await prisma.externalProbeResult.count()
    expect(count).toBe(0)
  })

  it('does NOT overwrite a previous good result with a fleet-wide failure -- the prior row remains the latest', async () => {
    await runExternalProbes([target(HOST_A)], depsFor({ [HOST_A]: { status: 200, certExpiresAt: null } }))

    await runExternalProbes(
      [target(HOST_A), target(HOST_B)],
      depsFor({ [HOST_A]: networkFailure(), [HOST_B]: networkFailure() }),
    )

    const rows = await prisma.externalProbeResult.findMany({ where: { hostname: HOST_A } })
    expect(rows).toHaveLength(1)
    expect(rows[0]?.outcome).toBe('answering')
  })

  it('a PARTIAL failure is still stored in full -- the fleet-wide guard must not swallow a genuine route-broken finding', async () => {
    const deps = depsFor({
      [HOST_A]: { status: 200, certExpiresAt: null },
      [HOST_B]: networkFailure(),
    })

    const result = await runExternalProbes([target(HOST_A), target(HOST_B)], deps)

    expect(result.stored).toBe(true)
    const rows = await prisma.externalProbeResult.findMany()
    expect(rows).toHaveLength(2)
  })

  it('never throws even when every probe fails, including a synchronous throw from the transport', async () => {
    const deps: ExternalDeps = {
      request: () => {
        throw networkFailure()
      },
    }
    await expect(runExternalProbes([target(HOST_A), target(HOST_B)], deps)).resolves.toMatchObject({
      stored: false,
    })
  })

  it('does nothing, without throwing, for an empty target list', async () => {
    const deps = depsFor({})
    await expect(runExternalProbes([], deps)).resolves.toEqual({ results: [], stored: true })
    expect(await prisma.externalProbeResult.count()).toBe(0)
  })

  // Task 9's substantive obligation: `listensTls` must reach `probeExternally`
  // unchanged for EACH target, not get flattened to one scheme for the whole
  // batch. Captures the `scheme` argument the real `ExternalDeps.request`
  // would receive (see external-probe.ts's `probeExternally`) rather than
  // asserting on `outcome`/`status`, which would stay identical either way
  // and hide exactly the bug this exists to catch.
  it('carries each target\'s own listensTls through to the prober, so a mixed batch dials different schemes per hostname', async () => {
    const seenSchemes: Record<string, ExternalScheme> = {}
    const deps: ExternalDeps = {
      request: async (hostname, _signal, scheme) => {
        seenSchemes[hostname] = scheme
        return { status: 200, certExpiresAt: null }
      },
    }

    await runExternalProbes(
      [target(HOST_A, false), target(HOST_B, true), target(HOST_C, null)],
      deps,
    )

    expect(seenSchemes[HOST_A]).toBe('http') // positively confirmed no TLS
    expect(seenSchemes[HOST_B]).toBe('https') // positively confirmed TLS
    expect(seenSchemes[HOST_C]).toBe('https') // undetermined -> the safe default
  })

  // Task 8 fix round 1 (C2b): a run-level record, distinct from the
  // per-hostname `ExternalProbeResult` table above, so the board's
  // fleet-wide banner has a directly queryable "when did the last sweep
  // run, and did it reach anything" fact instead of an inference over
  // per-hostname rows that may span unrelated cycles.
  describe('the ExternalProbeRun record', () => {
    it('records a successful sweep as having reached something', async () => {
      await runExternalProbes([target(HOST_A)], depsFor({ [HOST_A]: { status: 200, certExpiresAt: null } }))

      const runs = await prisma.externalProbeRun.findMany()
      expect(runs).toHaveLength(1)
      expect(runs[0]?.reachedAnything).toBe(true)
    })

    it('records a fleet-wide failure as having reached nothing -- EVEN THOUGH ExternalProbeResult itself writes nothing', async () => {
      const deps = depsFor({ [HOST_A]: networkFailure(), [HOST_B]: tlsFailure() })

      await runExternalProbes([target(HOST_A), target(HOST_B)], deps)

      const runs = await prisma.externalProbeRun.findMany()
      expect(runs).toHaveLength(1)
      expect(runs[0]?.reachedAnything).toBe(false)
      // The per-hostname table stays empty -- Task 7a's rule is untouched.
      expect(await prisma.externalProbeResult.count()).toBe(0)
    })

    it('records a PARTIAL failure (one hostname down, its neighbour fine) as having reached something', async () => {
      const deps = depsFor({
        [HOST_A]: { status: 200, certExpiresAt: null },
        [HOST_B]: networkFailure(),
      })

      await runExternalProbes([target(HOST_A), target(HOST_B)], deps)

      const runs = await prisma.externalProbeRun.findMany()
      expect(runs).toHaveLength(1)
      expect(runs[0]?.reachedAnything).toBe(true)
    })

    // Fix round 1 (Task 9 review), M4: this used to assert the OPPOSITE --
    // that an empty target list recorded NOTHING. That was the defect: a
    // fleet with zero currently-configured hostnames (no system has an HTTP
    // surface yet -- legitimate and common, not a failing scheduler) then
    // never got a single row, so `shouldRunExternalProbe` stayed permanently
    // "nothing has ever run" and `deploy/verify-board.sh`'s "the scheduler
    // has run at least once" check would fail FOREVER against a healthy
    // scheduler. `targetCount: 0` is what lets this row be written safely --
    // it is the field, not the row's mere existence, that says "swept
    // nothing because there was nothing to sweep."
    it('records a run even for an empty target list, with targetCount: 0 and reachedAnything: true -- "nothing to attempt" is not "attempted and failed"', async () => {
      await runExternalProbes([], depsFor({}))

      const runs = await prisma.externalProbeRun.findMany()
      expect(runs).toHaveLength(1)
      expect(runs[0]?.targetCount).toBe(0)
      expect(runs[0]?.reachedAnything).toBe(true)
    })

    // The discriminating half of the pair above: `reachedAnything` alone
    // cannot tell "0 targets, nothing to sweep" apart from "targets probed,
    // all reached" -- both read `true`. `targetCount` is what separates
    // them, and this test pins that it reflects the REAL number probed, not
    // a constant.
    it('records the real targetCount for a non-empty sweep, not just 0 or a placeholder', async () => {
      await runExternalProbes(
        [target(HOST_A), target(HOST_B), target(HOST_C)],
        depsFor({
          [HOST_A]: { status: 200, certExpiresAt: null },
          [HOST_B]: { status: 200, certExpiresAt: null },
          [HOST_C]: { status: 200, certExpiresAt: null },
        }),
      )

      const run = await prisma.externalProbeRun.findFirst()
      expect(run?.targetCount).toBe(3)
    })

    // The other discriminating half: a FLEET-WIDE FAILURE (targets probed,
    // none reached) must record `targetCount > 0` alongside
    // `reachedAnything: false` -- distinct from the empty-list case above,
    // which records `targetCount: 0` alongside `reachedAnything: true`. A
    // reader that only looked at `reachedAnything` could not tell "nothing
    // configured" apart from "everything down"; a reader with `targetCount`
    // can.
    it('records targetCount > 0 alongside reachedAnything: false for a genuine fleet-wide failure, distinct from the empty-list case', async () => {
      const deps = depsFor({ [HOST_A]: networkFailure(), [HOST_B]: tlsFailure() })

      await runExternalProbes([target(HOST_A), target(HOST_B)], deps)

      const run = await prisma.externalProbeRun.findFirst()
      expect(run?.targetCount).toBe(2)
      expect(run?.reachedAnything).toBe(false)
    })

    it('carries an observation time set by this server\'s own clock', async () => {
      const before = new Date()
      await runExternalProbes([target(HOST_A)], depsFor({ [HOST_A]: { status: 200, certExpiresAt: null } }))
      const after = new Date()

      const run = await prisma.externalProbeRun.findFirst()
      expect(run?.ranAt).toBeInstanceOf(Date)
      expect(run!.ranAt.getTime()).toBeGreaterThanOrEqual(before.getTime())
      expect(run!.ranAt.getTime()).toBeLessThanOrEqual(after.getTime())
    })
  })
})
