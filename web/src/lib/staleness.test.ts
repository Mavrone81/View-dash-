import { describe, it, expect } from 'vitest'
import { displayState } from './staleness.js'

const now = new Date('2026-08-01T12:00:00Z')
const ago = (ms: number) => new Date(now.getTime() - ms)

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
})
