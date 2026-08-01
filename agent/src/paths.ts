import { join } from 'node:path'

/**
 * A system's `key` comes from a Docker container label
 * (`com.docker.compose.project`) and is NOT fully trusted: it is set by
 * whatever compose file happens to be running on the monitored host, not
 * by this agent's own configuration. Both call sites below turn a key into
 * a filesystem path, so a key containing a path separator or a `..`
 * segment must never reach either `String.replace` or `node:path.join` --
 * `join` in particular NORMALISES `..` segments, so an unguarded join
 * could resolve OUTSIDE `repoRoot` entirely.
 */
function isSafeSystemKey(key: string): boolean {
  if (key.length === 0) return false
  if (key.includes('/') || key.includes('\\')) return false
  if (key === '..' || key.includes('..')) return false
  if (key.includes('\0')) return false
  return true
}

/**
 * Substitutes `key` into the configured deploy-log glob. Two things are
 * checked, both deliberately fail-loud (throw) rather than silently doing
 * something plausible-looking but wrong:
 *
 *  - `glob` must contain a `*` placeholder. `String.replace('*', key)` on a
 *    glob with no `*` is a silent no-op: every system would resolve to the
 *    SAME fixed path, so the board would show one system's deploy history
 *    duplicated across every row, with no error to reveal the misconfig.
 *  - `key` must be a safe path segment (see `isSafeSystemKey`).
 */
export function resolveDeployLogPath(glob: string, key: string): string {
  if (!glob.includes('*')) {
    throw new Error('deploy log glob must contain a "*" placeholder for the system key')
  }
  if (!isSafeSystemKey(key)) {
    throw new Error('refusing to resolve a deploy log path for an unsafe system key')
  }
  return glob.replace('*', key)
}

/** Joins `root` and `key` into a repo directory, guarding the same untrusted-key hazard as `resolveDeployLogPath`. */
export function resolveRepoDir(root: string, key: string): string {
  if (!isSafeSystemKey(key)) {
    throw new Error('refusing to resolve a repo directory for an unsafe system key')
  }
  return join(root, key)
}
