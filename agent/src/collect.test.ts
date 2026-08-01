import { describe, it, expect, beforeAll, vi } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { collectSnapshot } from './collect.js'
import { FleetSnapshotSchema } from '@bevora-ops/shared'

const deps = (over: Partial<Parameters<typeof collectSnapshot>[0]> = {}) => ({
  listContainers: async () => [{ names: ['/a'], project: 'alpha', state: 'running', health: null }],
  readDeployLog: async () => '2026-08-01T10:00:00Z  === Deploy OK: abc1234 ===',
  repoDirFor: () => '/nonexistent',
  now: () => new Date('2026-08-01T12:00:00Z'),
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
            { names: ['/a'], project: 'alpha', state: 'running', health: null },
            { names: ['/b'], project: 'beta', state: 'running', health: null },
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
      { names: ['/a'], project: 'alpha', state: 'running', health: null },
      { names: ['/b'], project: 'beta', state: 'running', health: null },
    ]

    it('does not render green when every container is up but the app 502s', async () => {
      const snap = await collectSnapshot(
        deps({
          listContainers: async () => [{ names: ['/a'], project: 'alpha', state: 'running', health: null }],
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
          listContainers: async () => [{ names: ['/a'], project: 'alpha', state: 'running', health: null }],
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
          listContainers: async () => [{ names: ['/a'], project: 'alpha', state: 'exited', health: null }],
          urlFor: () => 'https://alpha.example.invalid/',
          probe: async () => 'healthy' as const,
        }),
      )
      expect(snap.systems[0]!.health).toBe('down')
    })

    it('treats a configured URL whose probe throws as down, never as healthy', async () => {
      const snap = await collectSnapshot(
        deps({
          listContainers: async () => [{ names: ['/a'], project: 'alpha', state: 'running', health: null }],
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
})
