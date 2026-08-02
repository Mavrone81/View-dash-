import { describe, it, expect } from 'vitest'
import { buildBeatTrace, BEAT_COUNT, BEAT_INTERVAL_MS, BEAT_WINDOW_MS } from './beats.js'

const now = new Date('2026-08-01T12:00:00Z')
// `intervalsAgo(3)` lands squarely inside slot 3-from-newest, well clear of
// any boundary rounding, so these fixtures are not accidentally sensitive to
// off-by-one slot math.
const intervalsAgo = (n: number) => new Date(now.getTime() - n * BEAT_INTERVAL_MS - BEAT_INTERVAL_MS / 2)

describe('buildBeatTrace', () => {
  it('reports the fixed slot geometry: 40 beats at 30s covers 20 minutes', () => {
    expect(BEAT_COUNT).toBe(40)
    expect(BEAT_INTERVAL_MS).toBe(30_000)
    expect(BEAT_WINDOW_MS).toBe(20 * 60_000)
  })

  it('produces exactly BEAT_COUNT slots even with zero observations', () => {
    const trace = buildBeatTrace([], now)
    expect(trace).toHaveLength(BEAT_COUNT)
    expect(trace.every((b) => b.state === 'absent')).toBe(true)
  })

  it('marks a slot with a healthy observation as good', () => {
    const trace = buildBeatTrace([{ receivedAt: intervalsAgo(1), health: 'healthy' }], now)
    expect(trace.filter((b) => b.state === 'good')).toHaveLength(1)
  })

  it('marks a slot with a faulty observation as alarm, not good', () => {
    const trace = buildBeatTrace([{ receivedAt: intervalsAgo(1), health: 'down' }], now)
    expect(trace.filter((b) => b.state === 'alarm')).toHaveLength(1)
    expect(trace.filter((b) => b.state === 'good')).toHaveLength(0)
  })

  it('leaves every other slot absent when only one beat was received', () => {
    const trace = buildBeatTrace([{ receivedAt: intervalsAgo(5), health: 'healthy' }], now)
    const nonAbsent = trace.filter((b) => b.state !== 'absent')
    expect(nonAbsent).toHaveLength(1)
    expect(trace.filter((b) => b.state === 'absent')).toHaveLength(BEAT_COUNT - 1)
  })

  it('places the most recent observation in the last slot (newest last, oldest first)', () => {
    const trace = buildBeatTrace([{ receivedAt: intervalsAgo(0), health: 'healthy' }], now)
    expect(trace[BEAT_COUNT - 1]!.state).toBe('good')
    expect(trace[0]!.state).toBe('absent')
  })

  it('places an observation near the edge of the window in the first slot', () => {
    const trace = buildBeatTrace([{ receivedAt: intervalsAgo(BEAT_COUNT - 1), health: 'healthy' }], now)
    expect(trace[0]!.state).toBe('good')
  })

  it('drops an observation older than the window entirely, rather than clipping it into slot 0', () => {
    const trace = buildBeatTrace([{ receivedAt: intervalsAgo(BEAT_COUNT + 10), health: 'healthy' }], now)
    expect(trace.every((b) => b.state === 'absent')).toBe(true)
  })

  it('treats a future receivedAt as not a real beat, never fabricating a good slot from it', () => {
    const future = new Date(now.getTime() + 60_000)
    const trace = buildBeatTrace([{ receivedAt: future, health: 'healthy' }], now)
    expect(trace.every((b) => b.state === 'absent')).toBe(true)
  })

  it('lets a fault beat win over a good one landing in the same 30s slot, regardless of order', () => {
    // Same slot, health disagrees between the two observations: a fault must
    // never be hideable by a second, later-processed good reading in the
    // same slot.
    const t = intervalsAgo(2)
    const nearby = new Date(t.getTime() + 1) // 1ms later: same slot, not a new one
    const traceGoodThenBad = buildBeatTrace([{ receivedAt: t, health: 'healthy' }, { receivedAt: nearby, health: 'down' }], now)
    const traceBadThenGood = buildBeatTrace([{ receivedAt: t, health: 'down' }, { receivedAt: nearby, health: 'healthy' }], now)
    expect(traceGoodThenBad.filter((b) => b.state === 'alarm')).toHaveLength(1)
    expect(traceBadThenGood.filter((b) => b.state === 'alarm')).toHaveLength(1)
  })

  it('treats an unrecognised health string as alarm, never silently as good', () => {
    const trace = buildBeatTrace([{ receivedAt: intervalsAgo(1), health: 'banana' }], now)
    expect(trace.filter((b) => b.state === 'alarm')).toHaveLength(1)
  })
})
