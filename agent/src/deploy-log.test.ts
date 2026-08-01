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

  // Defect 3: Failure sha capture must distinguish certain failures from ambiguous shas.
  // Design principle: we are certain the deploy failed (keywords unambiguous).
  // But the sha is ambiguous if it runs directly into word characters (could be bleed from next word).
  // Return status: 'failed' in both cases, but sha: null when ambiguous.

  it('returns failed with null sha when sha is ambiguously followed by word characters', () => {
    // Input: 'abc1234deployed' — is it sha 'abc1234' + word 'deployed', or sha 'abc1234de' + word 'ployed'?
    // No regex can determine this. Report the certain fact (failed) and admit the uncertainty (sha: null).
    const r = parseDeployLog('BUILD FAILED for abc1234deployed')
    expect(r).toMatchObject({ status: 'failed', sha: null })
  })

  it('returns failed with sha when sha is cleanly delimited by punctuation', () => {
    // Unambiguous: semicolon clearly marks the sha boundary.
    const r = parseDeployLog('2026-08-01T10:00:00Z  BUILD FAILED for abc1234; retry next tick')
    expect(r).toMatchObject({ status: 'failed', sha: 'abc1234' })
  })

  it('returns failed with sha when sha is cleanly delimited by space', () => {
    // Unambiguous: space clearly marks where the sha ends and the next word begins.
    const r = parseDeployLog('BUILD FAILED for abc1234 deployed')
    expect(r).toMatchObject({ status: 'failed', sha: 'abc1234' })
  })

  it('returns failed with sha for health check failure with clear delimiter', () => {
    // Real-world format with clear boundaries.
    const r = parseDeployLog('2026-08-01T10:00:00Z  HEALTH CHECK FAILED for abc1234 after 10 attempts; retry next tick')
    expect(r).toMatchObject({ status: 'failed', sha: 'abc1234' })
  })
})
