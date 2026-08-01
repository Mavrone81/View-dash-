export type DeployOutcome = {
  status: 'ok' | 'failed' | 'unknown'
  sha: string | null
  at: Date | null
}

const TS = /(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)/
// Success banner must occupy the whole line (apart from optional timestamp and whitespace).
// Anchored both ends to prevent false positives from logs quoting or echoing other scripts.
const OK = /^\s*(?:\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z\s+)?===\s*Deploy OK:\s*([0-9a-f]{7,40})\s*===\s*$/i
// Failure patterns anchor at start (optional timestamp + keyword) but not end, as real emitters have trailing text.
// Word boundary after sha ensures it stops at transitions between word/non-word characters,
// preventing the greedy match from running into the next word when delimiters are present.
const FAILED = /(?:BUILD FAILED|HEALTH CHECK FAILED)\s+for\s+([0-9a-f]{7,40})\b/i

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
    let at: Date | null = null
    if (tsExec) {
      const d = new Date(tsExec[1]!)
      // Verify the timestamp is valid; shape-valid but semantically invalid timestamps (e.g., 0000-00-00)
      // produce Invalid Date objects where getTime() returns NaN. Return null for invalid dates.
      if (!Number.isNaN(d.getTime())) {
        at = d
      }
    }
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
