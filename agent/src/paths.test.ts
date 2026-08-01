import { describe, it, expect } from 'vitest'
import { resolveDeployLogPath, resolveRepoDir } from './paths.js'

describe('resolveDeployLogPath', () => {
  it('substitutes the system key into the configured glob', () => {
    expect(resolveDeployLogPath('/var/log/deploy-*.log', 'alpha')).toBe('/var/log/deploy-alpha.log')
  })

  it('rejects a glob with no "*" placeholder rather than silently reading one fixed path for every system', () => {
    // Without a placeholder, every system would resolve to the SAME file --
    // a config mistake that would silently make every row report one
    // system's deploy history. Fail loud at read time instead.
    expect(() => resolveDeployLogPath('/var/log/deploy.log', 'alpha')).toThrow(/\*/)
  })

  it('rejects a system key containing a path separator', () => {
    // The key originates from a Docker container label, which is not fully
    // trusted input: a stray "/" would let a compose project label read (or
    // in resolveRepoDir's case, run git in) an arbitrary path.
    expect(() => resolveDeployLogPath('/var/log/deploy-*.log', 'a/b')).toThrow()
  })

  it('rejects a system key containing a parent-directory segment', () => {
    expect(() => resolveDeployLogPath('/var/log/deploy-*.log', '..')).toThrow()
  })

  it('rejects an empty system key', () => {
    expect(() => resolveDeployLogPath('/var/log/deploy-*.log', '')).toThrow()
  })
})

describe('resolveRepoDir', () => {
  it('joins the repo root with the system key', () => {
    expect(resolveRepoDir('/srv/repos', 'alpha')).toBe('/srv/repos/alpha')
  })

  it('rejects a key that would escape the repo root via ".."', () => {
    // node:path.join normalises ".." segments, so an unguarded join of a
    // container-label-derived key could resolve OUTSIDE repoRoot entirely
    // -- readGitState would then run git against a directory this agent was
    // never configured to trust.
    expect(() => resolveRepoDir('/srv/repos', '../etc')).toThrow()
  })

  it('rejects a key containing a path separator', () => {
    expect(() => resolveRepoDir('/srv/repos', 'a/b')).toThrow()
  })
})
