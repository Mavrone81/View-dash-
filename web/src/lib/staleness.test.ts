import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { displayState, DEFAULT_STALE_AFTER_MS } from './staleness.js'
import { BEAT_INTERVAL_MS } from './beats.js'

const now = new Date('2026-08-01T12:00:00Z')
const ago = (ms: number) => new Date(now.getTime() - ms)

// Final whole-branch review, fix round 2, Important 6 -- a GOVERNANCE test,
// not a behavioural one, for the same reason `probe-scheduler.test.ts`'s
// "the interval is imported, not redefined" describe block is one: value
// equality alone (the first assertion) would still pass if this constant
// hardcoded the SAME literal `BEAT_INTERVAL_MS * 3` currently evaluates to,
// so mutating `DEFAULT_STALE_AFTER_MS = BEAT_INTERVAL_MS * 3` to a bare
// `90_000` in the source leaves every value-level test in this file (and
// all 844 elsewhere) green. The second assertion inspects the SOURCE
// directly to confirm this constant is a computation from the imported
// tick interval, not a redefinition -- so `fleet-query.ts`'s
// `ON_BOX_STALE_AFTER_MS` (which re-exports THIS constant) and
// `displayState`'s own default can never silently drift apart just because
// someone edited one of the two numbers that today happen to agree.
describe('DEFAULT_STALE_AFTER_MS is derived from BEAT_INTERVAL_MS, not a redefined literal', () => {
  it('is numerically three agent ticks', () => {
    expect(DEFAULT_STALE_AFTER_MS).toBe(BEAT_INTERVAL_MS * 3)
  })

  it('is computed from an import in the source, and defines no numeric literal of its own', () => {
    const path = fileURLToPath(new URL('./staleness.ts', import.meta.url))
    const source = readFileSync(path, 'utf8')
    expect(source).toMatch(/import \{ BEAT_INTERVAL_MS \} from '\.\/beats\.js'/)
    expect(source).toMatch(/DEFAULT_STALE_AFTER_MS = BEAT_INTERVAL_MS \* 3/)
    // 90_000 (or 90000) is three 30-second ticks. This checks for an actual
    // ASSIGNMENT of that literal, not merely the digits appearing anywhere --
    // this file's own docstrings quote "90 seconds" in prose to explain the
    // computed value, which a substring-only check on the digits would not
    // false-flag (the prose spells it as words, not as this numeral), but is
    // still worth excluding explicitly so a future edit that DOES paste the
    // numeral into a comment doesn't make this assertion pass for the wrong
    // reason.
    expect(source).not.toMatch(/=\s*90[_,]?000\b/)
  })
})

describe('displayState', () => {
  it('passes a fresh healthy observation through', () => {
    expect(displayState(ago(10_000), 'healthy', now)).toBe('healthy')
  })

  it('reports stale for an observation older than the threshold', () => {
    expect(displayState(ago(10 * 60_000), 'healthy', now)).toBe('stale')
  })

  it('NEVER reports healthy for a stale observation', () => {
    expect(displayState(ago(60 * 60_000), 'healthy', now)).not.toBe('healthy')
  })

  it('reports unknown when there is no observation at all', () => {
    expect(displayState(null, 'healthy', now)).toBe('unknown')
  })

  it('reports stale rather than down for an old failing observation', () => {
    expect(displayState(ago(10 * 60_000), 'down', now)).toBe('stale')
  })

  it('passes an unrecognised health value through as unknown', () => {
    expect(displayState(ago(1000), 'banana', now)).toBe('unknown')
  })

  it('reports unknown for a receivedAt in the future, never healthy forever', () => {
    const future = new Date(now.getTime() + 60_000)
    expect(displayState(future, 'healthy', now)).toBe('unknown')
  })

  it('treats an observation exactly at the threshold age as fresh, not stale', () => {
    expect(displayState(ago(90_000), 'healthy', now)).toBe('healthy')
  })
})
