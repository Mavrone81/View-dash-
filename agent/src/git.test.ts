import { describe, it, expect, beforeAll } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { readGitState, parseCommitDate } from './git.js'

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
