import { describe, it, expect, beforeAll, vi } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { collectSnapshot } from './collect.js'
import { FleetSnapshotSchema, type ProbeOutcome } from '@bevora-ops/shared'

const deps = (over: Partial<Parameters<typeof collectSnapshot>[0]> = {}) => ({
  listContainers: async () => [{ names: ['/a'], project: 'alpha', state: 'running', health: null, publishedPorts: [] }],
  readDeployLog: async () => '2026-08-01T10:00:00Z  === Deploy OK: abc1234 ===',
  repoDirFor: () => '/nonexistent',
  now: () => new Date('2026-08-01T12:00:00Z'),
  // `onBoxProbing` is REQUIRED (not optional) on CollectDeps -- fix round
  // 2's response to the on-box pair being deletable one key at a time, see
  // its docstring -- so every fixture needs an explicit value. `null` is
  // the honest default here: it means "not configured", the same thing
  // omitting the two former separate optional keys used to mean.
  onBoxProbing: null as Parameters<typeof collectSnapshot>[0]['onBoxProbing'],
  ...over,
})

describe('collectSnapshot', () => {
  it('produces a snapshot that satisfies the wire schema', async () => {
    const snap = await collectSnapshot(deps())
    expect(FleetSnapshotSchema.safeParse(snap).success).toBe(true)
  })

  it('reports the system even when its git repo cannot be read', async () => {
    const snap = await collectSnapshot(deps())
    expect(snap.systems).toHaveLength(1)
    expect(snap.systems[0]).toMatchObject({ key: 'alpha', health: 'healthy', deployedSubject: null })
  })

  it('survives a deploy log that cannot be read', async () => {
    const snap = await collectSnapshot(deps({ readDeployLog: async () => null }))
    expect(snap.systems[0]).toMatchObject({ key: 'alpha', deployedSha: null })
  })

  // NOTE on this fixture: the brief's original version pointed BOTH alpha and beta
  // at the same unresolvable `repoDirFor: () => '/nonexistent'`. Verified empirically
  // (see task-8-report.md) that under a wire-safe implementation -- required by the
  // "satisfies the wire schema" test above, which forces an unresolved short sha to
  // become null -- git resolution fails identically for alpha and beta against that
  // path (`ENOENT`, regardless of which sha string is passed). That made the two
  // systems indistinguishable: beta's deployedSha would be null for the exact same
  // structural reason as alpha's, not because containment failed. Running the
  // original fixture against the wire-safe implementation fails with
  // "beta.deployedSha: expected null not to be null" every time.
  //
  // The fix gives beta a REAL resolvable temp git repo, so its sha genuinely resolves
  // end-to-end while alpha's log-read throws and never reaches git at all. That is
  // the only way to actually prove "one system's failure didn't degrade the other's
  // real, resolved data" rather than coincidentally getting null on both sides.
  describe('containment: one system fails without taking down the others', () => {
    let repo: string
    let fullSha: string

    beforeAll(() => {
      repo = mkdtempSync(join(tmpdir(), 'collect-test-'))
      const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' }).trim()
      git('init', '-q', '-b', 'main')
      git('config', 'user.email', 't@example.com')
      git('config', 'user.name', 'T')
      writeFileSync(join(repo, 'a.txt'), '1')
      git('add', '-A')
      git('commit', '-q', '-m', 'feat: seed commit')
      fullSha = git('rev-parse', 'HEAD')
    })

    it('does not let one failing system remove the others', async () => {
      const snap = await collectSnapshot(
        deps({
          listContainers: async () => [
            { names: ['/a'], project: 'alpha', state: 'running', health: null, publishedPorts: [] },
            { names: ['/b'], project: 'beta', state: 'running', health: null, publishedPorts: [] },
          ],
          readDeployLog: async (key: string) => {
            if (key === 'alpha') throw new Error('permission denied')
            // A deploy log carries a SHORT sha; git resolves it against beta's real repo.
            return `2026-08-01T10:00:00Z  === Deploy OK: ${fullSha.slice(0, 8)} ===`
          },
          repoDirFor: (key: string) => (key === 'beta' ? repo : '/nonexistent'),
        }),
      )
      expect(snap.systems).toHaveLength(2)
      expect(snap.systems.find((s) => s.key === 'alpha')!.deployedSha).toBeNull()
      expect(snap.systems.find((s) => s.key === 'beta')!.deployedSha).toBe(fullSha)
    })
  })

  // Spec §4.1: health is the worst-of container state AND an HTTP probe of
  // the system's public URL. Before this, only container state was ever
  // consulted, so a stack whose containers all read `Up` while nginx
  // returned 502 to every real visitor rendered green on the one page
  // whose job is to say whether things are up.
  describe('HTTP probe folded into health (spec §4.1 worst-of)', () => {
    const twoRunningContainers = async () => [
      { names: ['/a'], project: 'alpha', state: 'running', health: null, publishedPorts: [] },
      { names: ['/b'], project: 'beta', state: 'running', health: null, publishedPorts: [] },
    ]

    it('does not render green when every container is up but the app 502s', async () => {
      const snap = await collectSnapshot(
        deps({
          listContainers: async () => [{ names: ['/a'], project: 'alpha', state: 'running', health: null, publishedPorts: [] }],
          urlFor: () => 'https://alpha.example.invalid/',
          probe: async () => 'down' as const,
        }),
      )
      const alpha = snap.systems.find((s) => s.key === 'alpha')!
      // Containers alone say `healthy` here -- one container, running, no
      // healthcheck. Only the probe can move this row.
      expect(alpha.health).toBe('down')
      expect(alpha.health).not.toBe('healthy')
    })

    it('leaves a system with no known URL exactly as its containers describe it', async () => {
      // The honest case, and today the ONLY case in a real deployment:
      // nothing in this branch supplies a URL, so `urlFor` returns null and
      // no probe runs. That must not redden or amber a single row.
      const probe = vi.fn()
      const snap = await collectSnapshot(
        deps({
          listContainers: async () => [{ names: ['/a'], project: 'alpha', state: 'running', health: null, publishedPorts: [] }],
          urlFor: () => null,
          probe,
        }),
      )
      expect(snap.systems[0]!.health).toBe('healthy')
      expect(probe).not.toHaveBeenCalled()
    })

    it('does not upgrade a down container set just because the URL answers', async () => {
      const snap = await collectSnapshot(
        deps({
          listContainers: async () => [{ names: ['/a'], project: 'alpha', state: 'exited', health: null, publishedPorts: [] }],
          urlFor: () => 'https://alpha.example.invalid/',
          probe: async () => 'healthy' as const,
        }),
      )
      expect(snap.systems[0]!.health).toBe('down')
    })

    it('treats a configured URL whose probe throws as down, never as healthy', async () => {
      const snap = await collectSnapshot(
        deps({
          listContainers: async () => [{ names: ['/a'], project: 'alpha', state: 'running', health: null, publishedPorts: [] }],
          urlFor: () => 'https://alpha.example.invalid/',
          probe: async () => {
            throw new Error('probe blew up')
          },
        }),
      )
      expect(snap.systems[0]!.health).toBe('down')
    })

    it('probes only the system it belongs to, so one system cannot be judged by another URL', async () => {
      const probed: string[] = []
      await collectSnapshot(
        deps({
          listContainers: twoRunningContainers,
          urlFor: (key: string) => `https://${key}.example.invalid/`,
          probe: async (url: string) => {
            probed.push(url)
            return 'healthy' as const
          },
        }),
      )
      expect(probed.sort()).toEqual(['https://alpha.example.invalid/', 'https://beta.example.invalid/'])
    })

    it('runs probes concurrently, so one slow probe cannot stall collection for the others', async () => {
      // Measured by OVERLAP, not by elapsed time: a serial implementation
      // would not start beta's probe until alpha's had finished, so
      // recording when each starts and ends is a direct, non-flaky
      // discriminator between concurrent and sequential.
      const events: string[] = []
      const snap = await collectSnapshot(
        deps({
          listContainers: twoRunningContainers,
          urlFor: (key: string) => `https://${key}.example.invalid/`,
          probe: async (url: string) => {
            const key = url.includes('alpha') ? 'alpha' : 'beta'
            events.push(`start:${key}`)
            await new Promise((r) => setTimeout(r, key === 'alpha' ? 80 : 5))
            events.push(`end:${key}`)
            return 'healthy' as const
          },
        }),
      )
      expect(snap.systems).toHaveLength(2)
      // beta must have STARTED before the slow alpha probe ENDED.
      expect(events.indexOf('start:beta')).toBeLessThan(events.indexOf('end:alpha'))
    })
  })

  // This is the seam this task exists to close: a system's published
  // container ports resolved to hostnames via the host's OWN reverse-proxy
  // config (agent/src/vhosts.ts), and each of those hostnames probed
  // on-box (agent/src/probe.ts) -- with NO operator configuration, unlike
  // the urlFor/probe block above. `onBoxProbing` (a bundled
  // hostnamesByPort/probeOnBoxHostname pair, fix round 2) is the seam; see
  // its docstring on CollectDeps.
  describe('on-box probing of derived hostnames folded into health', () => {
    it('does not render green when every container is up but the on-box probe finds the proxy has no upstream', async () => {
      const snap = await collectSnapshot(
        deps({
          listContainers: async () => [
            { names: ['/a'], project: 'alpha', state: 'running', health: null, publishedPorts: [8081] },
          ],
          onBoxProbing: {
            hostnamesByPort: async () => new Map([[8081, ['alpha.example.invalid']]]),
            probeOnBoxHostname: async () => ({ outcome: 'proxy-no-upstream' as const, status: 502 }),
          },
        }),
      )
      const alpha = snap.systems.find((s) => s.key === 'alpha')!
      // Containers alone say `healthy` -- one container, running, no
      // healthcheck. Only the on-box probe can move this row.
      expect(alpha.health).toBe('down')
      expect(alpha.health).not.toBe('healthy')
    })

    it('never probes a system that publishes no port at all -- there is nothing to dial', async () => {
      // A system with no published port legitimately has no HTTP surface
      // (a worker, a database, a background job): this must not be
      // reported as a failure, and there is no port for the on-box probe
      // to address in the first place.
      const probeOnBoxHostname = vi.fn()
      const snap = await collectSnapshot(
        deps({
          listContainers: async () => [
            { names: ['/a'], project: 'alpha', state: 'running', health: null, publishedPorts: [] },
          ],
          onBoxProbing: {
            hostnamesByPort: async () => new Map([[8081, ['other.example.invalid']]]),
            probeOnBoxHostname,
          },
        }),
      )
      expect(snap.systems[0]!.health).toBe('healthy')
      expect(probeOnBoxHostname).not.toHaveBeenCalled()
    })

    it('still probes a published port that matches no vhost, with a null hostname -- fix round 1\'s explicit call, not a guess', async () => {
      // A published port with no vhost mapping is NOT the same as no HTTP
      // surface at all: the container is up and Docker has published a
      // port, but nobody (yet) wrote the nginx vhost for it -- exactly the
      // gap between a stack's first deploy and its vhost being written.
      // "The app answered on its port" is real evidence worth having there.
      const calls: Array<{ hostname: string | null; port: number }> = []
      const snap = await collectSnapshot(
        deps({
          listContainers: async () => [
            { names: ['/a'], project: 'alpha', state: 'running', health: null, publishedPorts: [9999] },
          ],
          onBoxProbing: {
            hostnamesByPort: async () => new Map([[8081, ['other.example.invalid']]]),
            probeOnBoxHostname: async (hostname, port) => {
              calls.push({ hostname, port })
              return { outcome: 'answering' as const, status: 200 }
            },
          },
        }),
      )
      expect(calls).toEqual([{ hostname: null, port: 9999 }])
      expect(snap.systems[0]!.health).toBe('healthy')
    })

    it('reports not-probed (never down) for a failed probe of an unmapped port, so it cannot redden a row on its own', async () => {
      // Fix round 2's second Critical: an unmapped port has no vhost
      // vouching it is HTTP-shaped at all, so a failed probe of it is not
      // evidence of anything -- probeOutcomeToHealth('not-probed') is
      // null, which worstOf treats as "no opinion".
      const snap = await collectSnapshot(
        deps({
          listContainers: async () => [
            { names: ['/a'], project: 'alpha', state: 'running', health: null, publishedPorts: [9999] },
          ],
          onBoxProbing: {
            hostnamesByPort: async () => new Map([[8081, ['other.example.invalid']]]),
            probeOnBoxHostname: async () => ({ outcome: 'not-probed' as const, status: null }),
          },
        }),
      )
      expect(snap.systems[0]!.health).toBe('healthy')
    })

    it('does not downgrade anything when the vhost directory could not be read this tick', async () => {
      // `hostnamesByPort` returning `null` means the read FAILED -- not
      // "read successfully and found zero vhosts". Collapsing those two
      // would report a diagnostic failure as a fact about the host (every
      // system reads "no HTTP surface"), which is exactly the false claim
      // this task's brief calls out by name.
      //
      // Honestly labelled: this is a CONTRACT test, not a discriminating
      // one. At the collectSnapshot layer, `null` and an empty `Map` both
      // already produce "no on-box probing, health untouched" -- a naive
      // implementation that collapsed the two would pass this exact
      // assertion too, because this fixture's port (8081) is absent from
      // an empty map in exactly the same way it is absent given `null`.
      // The distinction that DOES discriminate lives one layer down, in
      // `discoverHostnamesFromDir`'s own test in vhosts.test.ts ("returns
      // null, not an empty map, when the directory cannot be read at
      // all"), which is mutation-verified. This test exists to document
      // and pin collectSnapshot's side of the contract, not to prove it.
      const probeOnBoxHostname = vi.fn()
      const snap = await collectSnapshot(
        deps({
          listContainers: async () => [
            { names: ['/a'], project: 'alpha', state: 'running', health: null, publishedPorts: [8081] },
          ],
          onBoxProbing: {
            hostnamesByPort: async () => null,
            probeOnBoxHostname,
          },
        }),
      )
      expect(snap.systems[0]!.health).toBe('healthy')
      expect(probeOnBoxHostname).not.toHaveBeenCalled()
    })

    it('never lets the whole snapshot fail when hostnamesByPort() itself rejects, unlike every other on-box call which is per-system', async () => {
      // This call sits OUTSIDE the per-system Promise.all (it runs once,
      // before any system is processed), so it needs its own guard: without
      // one, a rejection here would fail collectSnapshot entirely --
      // container state, sha, and URL-probe results for EVERY system, not
      // just the on-box axis of one.
      const snap = await collectSnapshot(
        deps({
          listContainers: async () => [
            { names: ['/a'], project: 'alpha', state: 'running', health: null, publishedPorts: [8081] },
          ],
          onBoxProbing: {
            hostnamesByPort: async () => {
              throw new Error('vhost read exploded')
            },
            probeOnBoxHostname: vi.fn(),
          },
        }),
      )
      expect(snap.systems).toHaveLength(1)
      expect(snap.systems[0]!.health).toBe('healthy')
    })

    it('probes only the hostnames that resolve from THIS system\'s own published ports, never another system\'s', async () => {
      const probed: string[] = []
      const byPort = new Map([
        [8081, ['alpha.example.invalid']],
        [9001, ['beta.example.invalid']],
      ])
      await collectSnapshot(
        deps({
          listContainers: async () => [
            { names: ['/a'], project: 'alpha', state: 'running', health: null, publishedPorts: [8081] },
            { names: ['/b'], project: 'beta', state: 'running', health: null, publishedPorts: [9001] },
          ],
          onBoxProbing: {
            hostnamesByPort: async () => byPort,
            probeOnBoxHostname: async (hostname) => {
              probed.push(hostname ?? '')
              return { outcome: 'answering' as const, status: 200 }
            },
          },
        }),
      )
      expect(probed.sort()).toEqual(['alpha.example.invalid', 'beta.example.invalid'])
    })

    it('runs a system\'s hostname probes concurrently, so one slow hostname cannot stall the others', async () => {
      const events: string[] = []
      const byPort = new Map([
        [8081, ['slow.example.invalid']],
        [9001, ['fast.example.invalid']],
      ])
      const snap = await collectSnapshot(
        deps({
          listContainers: async () => [
            { names: ['/a'], project: 'alpha', state: 'running', health: null, publishedPorts: [8081, 9001] },
          ],
          onBoxProbing: {
            hostnamesByPort: async () => byPort,
            probeOnBoxHostname: async (hostname) => {
              const h = hostname ?? ''
              events.push(`start:${h}`)
              await new Promise((r) => setTimeout(r, h.startsWith('slow') ? 80 : 5))
              events.push(`end:${h}`)
              return { outcome: 'answering' as const, status: 200 }
            },
          },
        }),
      )
      expect(snap.systems).toHaveLength(1)
      expect(events.indexOf('start:fast.example.invalid')).toBeLessThan(events.indexOf('end:slow.example.invalid'))
    })

    it('treats an on-box probe function that throws outright as evidence of failure, never as healthy', async () => {
      const snap = await collectSnapshot(
        deps({
          listContainers: async () => [
            { names: ['/a'], project: 'alpha', state: 'running', health: null, publishedPorts: [8081] },
          ],
          onBoxProbing: {
            hostnamesByPort: async () => new Map([[8081, ['alpha.example.invalid']]]),
            probeOnBoxHostname: async () => {
              throw new Error('boom')
            },
          },
        }),
      )
      expect(snap.systems[0]!.health).toBe('down')
    })

    it('never lets the whole snapshot fail when a probe function throws synchronously instead of rejecting, and never takes down another system with it', async () => {
      // Deliberately violates probeOnBoxHostname's declared Promise-returning
      // type -- a defensive case, not a supported contract. `.catch()` only
      // guards a REJECTED promise; a synchronous throw would otherwise
      // escape it, reject this system's own Promise.all callback, and (left
      // uncaught) propagate out of collectSnapshot's OUTER Promise.all,
      // failing the entire snapshot for every system, not just this one.
      const syncThrow = (() => {
        throw new Error('boom')
      }) as unknown as (hostname: string | null, port: number) => Promise<{ outcome: ProbeOutcome; status: number | null }>
      const snap = await collectSnapshot(
        deps({
          listContainers: async () => [
            { names: ['/a'], project: 'alpha', state: 'running', health: null, publishedPorts: [8081] },
            { names: ['/b'], project: 'beta', state: 'running', health: null, publishedPorts: [] },
          ],
          onBoxProbing: {
            hostnamesByPort: async () => new Map([[8081, ['alpha.example.invalid']]]),
            probeOnBoxHostname: syncThrow,
          },
        }),
      )
      expect(snap.systems).toHaveLength(2)
      // `unknown`, not `down`: this is OUR machinery faulting (a
      // badly-behaved injected function), not a real probe attempt that
      // found the customer's system unreachable -- see the `catch` block's
      // comment in collect.ts for why those two must not read the same.
      expect(snap.systems.find((s) => s.key === 'alpha')!.health).toBe('unknown')
      // beta has no published ports, so it is never probed at all, and must
      // not be caught in alpha's failure.
      expect(snap.systems.find((s) => s.key === 'beta')!.health).toBe('healthy')
    })

    it('does not upgrade a down container set just because the on-box probe answers', async () => {
      const snap = await collectSnapshot(
        deps({
          listContainers: async () => [
            { names: ['/a'], project: 'alpha', state: 'exited', health: null, publishedPorts: [8081] },
          ],
          onBoxProbing: {
            hostnamesByPort: async () => new Map([[8081, ['alpha.example.invalid']]]),
            probeOnBoxHostname: async () => ({ outcome: 'answering' as const, status: 200 }),
          },
        }),
      )
      expect(snap.systems[0]!.health).toBe('down')
    })

    it('is inert when onBoxProbing is explicitly null -- no longer "every deployment today" (agent-deps.ts always wires a real object now), but still the honest state for a caller that wants this axis off', async () => {
      const snap = await collectSnapshot(
        deps({
          listContainers: async () => [
            { names: ['/a'], project: 'alpha', state: 'running', health: null, publishedPorts: [8081] },
          ],
          onBoxProbing: null,
        }),
      )
      expect(snap.systems[0]!.health).toBe('healthy')
    })
  })
})
