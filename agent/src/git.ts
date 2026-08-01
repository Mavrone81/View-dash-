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

// Same principle as the date: a `rev-list --count` value that looks numeric but isn't
// (missing, empty, or garbage) must not silently become 0 or NaN and be mistaken for a
// real drift count downstream.
export function parseDriftCount(count: string | null): number | null {
  if (!count) return null
  const n = Number(count)
  return Number.isNaN(n) ? null : n
}

// Deployed shas originate from parsing a deploy log on a monitored host (see
// deploy-log.ts) and arrive here as plain strings. `readGitState` is exported, so a
// future caller has no reason to know -- or keep re-verifying -- that upstream
// invariant. Validate the shape at this boundary instead of trusting it implicitly:
// a value that isn't hex (e.g. beginning with `-`) would otherwise be handed straight
// into a git argument list, where git would parse it as an option rather than a
// revision (`--upload-pack=...`, `-n`, etc).
const SHA_SHAPE = /^[0-9a-f]{7,40}$/

export async function readGitState(repoDir: string, deployedSha: string | null): Promise<GitState> {
  if (!deployedSha) {
    return { deployedSha: null, subject: null, deployedAt: null, driftCommits: null }
  }

  if (!SHA_SHAPE.test(deployedSha)) {
    // Not a git-shaped sha at all -- treat exactly like an unknown sha (below): the
    // input is echoed back for the caller's own record-keeping, everything derived
    // from it is unknown. Never throw; never invoke git with this value.
    return { deployedSha, subject: null, deployedAt: null, driftCommits: null }
  }

  // `--end-of-options` is passed before every revision argument below as a second,
  // independent layer of defence: even if the shape check above were ever loosened
  // or bypassed, this stops git from reinterpreting the argument as an option.
  const full = await git(repoDir, ['rev-parse', '--verify', '--end-of-options', `${deployedSha}^{commit}`])
  if (!full) {
    return { deployedSha, subject: null, deployedAt: null, driftCommits: null }
  }

  const subject = await git(repoDir, ['log', '-1', '--format=%s', '--end-of-options', full])
  const iso = await git(repoDir, ['log', '-1', '--format=%cI', '--end-of-options', full])
  const count = await git(repoDir, ['rev-list', '--count', '--end-of-options', `${full}..HEAD`])

  return {
    deployedSha: full,
    subject: subject || null,
    deployedAt: parseCommitDate(iso),
    driftCommits: parseDriftCount(count),
  }
}
