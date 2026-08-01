import { describe, it, expect, beforeAll } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { readGitState, parseCommitDate, parseDriftCount } from './git.js'

let repo: string
let firstSha: string

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'gitstate-'))
  const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' }).trim()
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 't@example.com')
  git('config', 'user.name', 'T')
  writeFileSync(join(repo, 'a.txt'), '1')
  git('add', '-A'); git('commit', '-q', '-m', 'feat: the first thing')
  firstSha = git('rev-parse', 'HEAD')
  writeFileSync(join(repo, 'a.txt'), '2')
  git('add', '-A'); git('commit', '-q', '-m', 'feat: the second thing')
})

describe('readGitState', () => {
  it('resolves the subject and timestamp of the deployed sha', async () => {
    const s = await readGitState(repo, firstSha)
    expect(s.subject).toBe('feat: the first thing')
    expect(s.deployedSha).toBe(firstSha)
    expect(s.deployedAt).toBeInstanceOf(Date)
  })

  it('counts drift between the deployed sha and HEAD', async () => {
    const s = await readGitState(repo, firstSha)
    expect(s.driftCommits).toBe(1)
  })

  it('reports zero drift when the deployed sha is HEAD', async () => {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim()
    expect((await readGitState(repo, head)).driftCommits).toBe(0)
  })

  it('returns nulls rather than throwing for an unknown sha', async () => {
    const s = await readGitState(repo, 'f'.repeat(40))
    expect(s).toMatchObject({ subject: null, driftCommits: null })
  })

  it('returns nulls rather than throwing for a directory that is not a repo', async () => {
    const s = await readGitState(tmpdir(), 'a'.repeat(40))
    expect(s).toMatchObject({ subject: null, driftCommits: null })
  })

  it('returns all nulls when there is no deployed sha, rather than guessing at HEAD', async () => {
    const s = await readGitState(repo, null)
    expect(s).toEqual({ deployedSha: null, subject: null, deployedAt: null, driftCommits: null })
  })

  // A deployed sha is untrusted input (it comes from parsing a log file elsewhere).
  // A value that isn't a plain hex sha must never reach a git argument list, where it
  // could be interpreted as an option instead of a revision.
  it('returns nulls rather than throwing or executing for a sha shaped like a git option', async () => {
    const s = await readGitState(repo, '--upload-pack=touch /tmp/pwned')
    expect(s).toMatchObject({ subject: null, driftCommits: null, deployedAt: null })
  })

  it('returns nulls rather than throwing or executing for a short flag-shaped sha', async () => {
    const s = await readGitState(repo, '-n')
    expect(s).toMatchObject({ subject: null, driftCommits: null, deployedAt: null })
  })

  it('returns nulls rather than throwing for a sha containing non-hex characters', async () => {
    const s = await readGitState(repo, 'not-hex-at-all-zz')
    expect(s).toMatchObject({ subject: null, driftCommits: null, deployedAt: null })
  })

  // This is the test that actually distinguishes "shape validated" from "shape not
  // validated": 'main' is a real, resolvable revision in this repo (it's the branch
  // itself), so without the boundary check git would happily resolve it and hand back
  // a real subject/date. The three tests above pass either way, because git's own
  // option parser already rejects those particular strings as unknown options or
  // unresolvable revisions -- they document the intent but don't, on their own, prove
  // the guard does anything. This one does: it fails (returns a non-null subject) if
  // the `SHA_SHAPE` check is removed.
  it('rejects a non-hex revision even when git itself could resolve it (branch name)', async () => {
    const s = await readGitState(repo, 'main')
    expect(s).toMatchObject({ subject: null, driftCommits: null, deployedAt: null })
  })
})

// Regression coverage for the specific failure mode where a bad timestamp string
// parses to a JS `Invalid Date` object rather than to `null`. An `Invalid Date` is
// still `instanceof Date`, so a naive `s.deployedAt ? ... : null` guard does not
// catch it -- it would render on the dashboard as if it were a real deploy time.
describe('parseCommitDate', () => {
  it('parses a well-formed git commit ISO timestamp', () => {
    const d = parseCommitDate('2024-01-02T03:04:05+00:00')
    expect(d).toBeInstanceOf(Date)
    expect(Number.isNaN(d?.getTime())).toBe(false)
  })

  it('returns null, not an Invalid Date, for a malformed timestamp', () => {
    expect(parseCommitDate('not-a-timestamp')).toBeNull()
  })

  it('returns null for an empty string', () => {
    expect(parseCommitDate('')).toBeNull()
  })
})

// Regression coverage mirroring parseCommitDate: `git rev-list --count` cannot be
// coerced into emitting a genuinely malformed count in practice, so this is tested
// as a pure function directly rather than through readGitState + a real repo.
describe('parseDriftCount', () => {
  it('parses a normal count string', () => {
    expect(parseDriftCount('3')).toBe(3)
  })

  it('returns null for an empty string, not 0', () => {
    expect(parseDriftCount('')).toBeNull()
  })

  it('returns null, not NaN, for a non-numeric string', () => {
    expect(parseDriftCount('not-a-number')).toBeNull()
  })

  it('returns null for null input', () => {
    expect(parseDriftCount(null)).toBeNull()
  })
})
