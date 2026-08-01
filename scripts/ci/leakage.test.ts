import { describe, it, expect } from 'vitest'
import { scanForLeakage } from './assert-no-environment-leakage.mjs'

describe('scanForLeakage', () => {
  it('flags a real IPv4 literal', () => { // leak-gate:allow
    const hits = scanForLeakage([{ path: 'a.ts', content: 'const h = "203.0.113.9"\nconst r = "8.8.4.4"' }], []) // leak-gate:allow
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({ path: 'a.ts', line: 2, match: '8.8.4.4' }) // leak-gate:allow
  })

  it('honours an explicit per-line opt-out marker', () => {
    const content = 'const doc = "8.8.4.4" // leak-gate:allow'
    expect(scanForLeakage([{ path: 'a.ts', content }], [])).toEqual([])
  })

  it('allows loopback, unspecified and RFC-5737 documentation ranges', () => {
    const content = '127.0.0.1 0.0.0.0 192.0.2.1 198.51.100.7 203.0.113.4'
    expect(scanForLeakage([{ path: 'a.ts', content }], [])).toEqual([])
  })

  it('does not flag version strings or semver', () => {
    expect(scanForLeakage([{ path: 'a.ts', content: 'v1.2.3 and 10.0.0 alpha' }], [])).toEqual([])
  })

  it('flags a caller-supplied secret pattern', () => {
    const hits = scanForLeakage([{ path: 'doc.md', content: 'runs on widgetco.example' }], ['widgetco\\.example'])
    expect(hits).toHaveLength(1)
    expect(hits[0].match).toBe('widgetco.example')
  })

  it('returns nothing for clean content', () => {
    expect(scanForLeakage([{ path: 'a.ts', content: 'const host = process.env.HOST' }], ['nope'])).toEqual([])
  })
})
