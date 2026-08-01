export type DeployOutcome = {
  status: 'ok' | 'failed' | 'unknown'
  sha: string | null
  at: Date | null
}

const TS = /(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)/
// Deliberately narrow: only the explicit success banner counts as success.
const OK = /===\s*Deploy OK:\s*([0-9a-f]{7,40})\s*===/i
const FAILED = /(?:BUILD FAILED|HEALTH CHECK FAILED)\s+for\s+([0-9a-f]{7,40})/i

export function parseDeployLog(text: string): DeployOutcome | null {
  const lines = text.split('\n').filter((l) => l.trim().length > 0)
  if (lines.length === 0) return null

  // Scan backwards: the newest outcome wins.
  for (let i = lines.length - 1; i >= 0; i--) {
    // noUncheckedIndexedAccess requires explicit guard for array access
    const line = lines[i]
    if (line === undefined) continue
    const tsExec = TS.exec(line)
    // Capture group [1] is guaranteed to exist if the regex matches (has exactly one group)
    const at = tsExec ? new Date(tsExec[1]!) : null
    const ok = OK.exec(line)
    if (ok) {
      // Capture group [1] is guaranteed to exist if the regex matches (has exactly one group)
      return { status: 'ok', sha: ok[1]!, at }
    }
    const failed = FAILED.exec(line)
    if (failed) {
      // Capture group [1] is guaranteed to exist if the regex matches (has exactly one group)
      return { status: 'failed', sha: failed[1]!, at }
    }
  }
  // Non-empty but in no dialect we know. Say so rather than assume health.
  return { status: 'unknown', sha: null, at: null }
}
