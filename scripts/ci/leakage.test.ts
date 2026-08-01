import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scanForLeakage, loadPatternsFromFile } from './assert-no-environment-leakage.mjs'

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

  it('flags a real IPv6 literal', () => { // leak-gate:allow
    const hits = scanForLeakage([{ path: 'a.ts', content: 'const h = "fd00::1"' }], []) // leak-gate:allow
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({ path: 'a.ts', line: 1, match: 'fd00::1' }) // leak-gate:allow
  })

  it('allows the IPv6 loopback address', () => {
    expect(scanForLeakage([{ path: 'a.ts', content: 'const h = "::1"' }], [])).toEqual([])
  })

  it('allows the 2001:db8::/32 IPv6 documentation prefix', () => {
    expect(scanForLeakage([{ path: 'a.ts', content: 'const h = "2001:db8::1"' }], [])).toEqual([])
  })

  it('does not flag a non-address double-colon token', () => {
    expect(scanForLeakage([{ path: 'a.ts', content: 'foo::bar' }], [])).toEqual([])
  })
})

describe('loadPatternsFromFile', () => {
  it('returns no extra patterns when unset — IPv4/IPv6 rules still run regardless', () => {
    expect(loadPatternsFromFile(undefined)).toEqual([])
  })

  it('fails loudly rather than silently continuing when the configured file cannot be read', () => {
    const missing = join(tmpdir(), 'leak-gate-patterns-file-that-does-not-exist')
    expect(() => loadPatternsFromFile(missing)).toThrow()
  })

  it('reads patterns from the file when one is configured', () => {
    const dir = mkdtempSync(join(tmpdir(), 'leak-gate-'))
    const file = join(dir, 'patterns.txt')
    writeFileSync(file, 'widgetco\\.example')
    expect(loadPatternsFromFile(file)).toEqual(['widgetco\\.example'])
  })
})
