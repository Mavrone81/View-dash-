export type DeployOutcome = {
  status: 'ok' | 'failed' | 'unknown'
  sha: string | null
  at: Date | null
}

// ISO 8601 timestamp pattern, shared between TS and OK to prevent drift
const TS_PATTERN = '\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}Z'
const TS = new RegExp(`(${TS_PATTERN})`)
// Success banner must occupy the whole line (apart from optional timestamp and whitespace).
// Both ends anchored to prevent false positives from logs quoting or echoing other scripts.
const OK = new RegExp(`^\\s*(?:${TS_PATTERN}\\s+)?===\\s*Deploy OK:\\s*([0-9a-f]{7,40})\\s*===\\s*$`, 'i')
// Failure pattern: match the keyword and sha. Do not anchor end-of-line (real emitters have trailing text).
// Do not use regex lookahead/boundary to determine sha validity; instead check at runtime
// to distinguish between certain failures (keyword matches) and ambiguous shas (runs into word chars).
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
    const failedMatch = FAILED.exec(line)
    if (failedMatch) {
      // We are certain the deploy failed (keywords are unambiguous).
      // But the sha might be ambiguous if it runs directly into another word.
      // Check what character comes immediately after the captured sha.
      const capturedSha = failedMatch[1]!
      const endIndex = failedMatch.index + failedMatch[0].length
      const nextChar = endIndex < line.length ? line[endIndex] : undefined
      // If the next character is a word character (letter/digit/underscore), the sha boundary is ambiguous:
      // we cannot tell if it's the end of a 7-char sha followed by a word, or part of a longer sha.
      // Report the certain fact (failed) and admit the uncertain fact (sha: null).
      const isAmbiguous = nextChar !== undefined && /[a-zA-Z0-9_]/.test(nextChar)
      const sha = isAmbiguous ? null : capturedSha
      return { status: 'failed', sha, at }
    }
  }
  // Non-empty but in no dialect we know. Say so rather than assume health.
  return { status: 'unknown', sha: null, at: null }
}
