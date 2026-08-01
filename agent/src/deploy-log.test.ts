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
})
