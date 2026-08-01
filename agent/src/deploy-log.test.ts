import { describe, it, expect } from 'vitest'
import { parseDeployLog } from './deploy-log.js'

describe('parseDeployLog', () => {
  it('reads the canonical success line', () => {
    const r = parseDeployLog('2026-08-01T15:42:54Z  === Deploy OK: abc1234 ===')
    expect(r).toMatchObject({ status: 'ok', sha: 'abc1234' })
    expect(r!.at!.toISOString()).toBe('2026-08-01T15:42:54.000Z')
  })

  it('takes the LAST outcome, not the first', () => {
    const text = [
      '2026-08-01T10:00:00Z  === Deploy OK: aaaaaaa ===',
      '2026-08-01T11:00:00Z  BUILD FAILED for bbbbbbb; retry next tick',
    ].join('\n')
    expect(parseDeployLog(text)).toMatchObject({ status: 'failed', sha: 'bbbbbbb' })
  })

  it('recognises a health-check failure as failed', () => {
    const r = parseDeployLog('2026-08-01T11:00:00Z  HEALTH CHECK FAILED for ccccccc after 10 attempts')
    expect(r).toMatchObject({ status: 'failed', sha: 'ccccccc' })
  })

  it('returns unknown for a log in a dialect it does not recognise', () => {
    expect(parseDeployLog('finished ok\nall good')).toMatchObject({ status: 'unknown', sha: null })
  })

  it('returns null for an empty log', () => {
    expect(parseDeployLog('   \n  ')).toBeNull()
  })

  it('does not treat the word "ok" in prose as a successful deploy', () => {
    expect(parseDeployLog('2026-08-01T10:00:00Z  everything looks ok to me')).toMatchObject({ status: 'unknown' })
  })

  // Defect 1: Success banner must be anchored — prose quoting/echoing other logs must not match.
  it('rejects success banner when preceded by other text (log quote)', () => {
    expect(parseDeployLog('2026-08-01T10:00:00Z  previous attempt logged: === Deploy OK: abc1234 === (superseded)')).toMatchObject({
      status: 'unknown',
    })
  })

  it('rejects success banner when preceded by other text (dry-run echo)', () => {
    expect(parseDeployLog('2026-08-01T10:00:00Z  would emit: === Deploy OK: abc1234 ===')).toMatchObject({ status: 'unknown' })
  })

  it('rejects success banner when preceded by other text (grep output)', () => {
    expect(parseDeployLog('2026-08-01T10:00:00Z  grep found: === Deploy OK: abc1234 ===')).toMatchObject({ status: 'unknown' })
  })

  // Defect 2: Timestamps must be validated; shape-valid but semantically invalid times (0000-00-00) become Invalid Date.
  it('validates timestamp semantically and sets at to null for invalid times', () => {
    const r = parseDeployLog('0000-00-00T00:00:00Z  === Deploy OK: abc1234 ===')
    expect(r).toMatchObject({ status: 'ok', sha: 'abc1234', at: null })
  })

  // Defect 3: Failure sha capture must have word boundary to stop at proper delimiters.
  it('does not over-capture when followed by hex-valid word prefix (with space)', () => {
    // Real deployment logs have spaces/punctuation after the sha. When a word like 'deployed'
    // (starting with hex letters 'de') follows the sha, the word boundary \b ensures we
    // capture only the sha portion before the boundary, not including hex letters from the next word.
    const r = parseDeployLog('2026-08-01T10:00:00Z  BUILD FAILED for abc1234 deployed; last-deployed stays at def5678')
    // The space after 'abc1234' creates a word boundary, so \b matches there and prevents
    // the capture from including 'deployed'. The sha is 'abc1234'.
    expect(r).toMatchObject({ status: 'failed', sha: 'abc1234' })
  })
})
