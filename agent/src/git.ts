import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile)

export type GitState = {
  deployedSha: string | null
  subject: string | null
  deployedAt: Date | null
  driftCommits: number | null
}

async function git(repoDir: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await exec('git', args, { cwd: repoDir, timeout: 10_000 })
    return stdout.trim()
  } catch {
    // A missing repo, an unknown sha, a directory that is not a git repo, a git binary
    // that is absent, or a timeout all mean the same thing to a caller: "I could not
    // determine this." Never throw -- one unreadable checkout on one host must degrade
    // its own row on the dashboard, not take collection down for every other system.
    return null
  }
}

// Git's committer-date ISO format (%cI) is well-formed in the ordinary case, but a
// caller must never trust a parsed timestamp blindly: `new Date(garbage)` silently
// produces an `Invalid Date` object that still satisfies `instanceof Date` and would
// render on the dashboard as if it were a real deploy time. Verify before returning.
export function parseCommitDate(iso: string | null): Date | null {
  if (!iso) return null
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? null : d
}

export async function readGitState(repoDir: string, deployedSha: string | null): Promise<GitState> {
  if (!deployedSha) {
    return { deployedSha: null, subject: null, deployedAt: null, driftCommits: null }
  }

  const full = await git(repoDir, ['rev-parse', '--verify', `${deployedSha}^{commit}`])
  if (!full) {
    return { deployedSha, subject: null, deployedAt: null, driftCommits: null }
  }

  const subject = await git(repoDir, ['log', '-1', '--format=%s', full])
  const iso = await git(repoDir, ['log', '-1', '--format=%cI', full])
  const count = await git(repoDir, ['rev-list', '--count', `${full}..HEAD`])

  let driftCommits: number | null = null
  if (count !== null) {
    const n = Number(count)
    // Same principle as the date: a value that looks numeric but isn't must not
    // silently become a wrong number (e.g. NaN comparisons downstream).
    driftCommits = Number.isNaN(n) ? null : n
  }

  return {
    deployedSha: full,
    subject: subject || null,
    deployedAt: parseCommitDate(iso),
    driftCommits,
  }
}
