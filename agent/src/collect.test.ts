import { describe, it, expect, beforeAll } from 'vitest'
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
})
