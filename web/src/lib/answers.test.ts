import { describe, it, expect } from 'vitest'
import { combine, isFleetWideExternalFailure, primaryHostname, type Axis } from './answers.js'

const ok = { outcome: 'answering' as const, status: 200 }
const oddly = { outcome: 'answering-oddly' as const, status: 404 }
const bad = { outcome: 'not-answering' as const, status: null }
const tls = { outcome: 'tls-failed' as const, status: null }
const noUpstream = { outcome: 'proxy-no-upstream' as const, status: 502 }
const notProbed: Axis = { outcome: 'not-probed', status: null }

describe('the two-axis verdict', () => {
  it('is healthy only when BOTH axes answer', () => {
    expect(combine(ok, ok)).toBe('healthy')
  })

  it('is healthy when an odd 4xx still counts as answering on both sides', () => {
    expect(combine(oddly, oddly)).toBe('healthy')
  })

  // The row this whole slice exists for.
  it('says the ROUTE is broken when the app answers on-box but not outside', () => {
    expect(combine(ok, bad)).toBe('route-broken')
    expect(combine(ok, tls)).toBe('route-broken')
  })

  it('says the app is down when neither answers', () => {
    expect(combine(bad, bad)).toBe('app-down')
  })

  it('a proxy answering with no upstream behind it is still a failure, not an answer', () => {
    expect(combine(noUpstream, bad)).toBe('app-down')
  })

  it('flags a contradiction rather than picking a winner', () => {
    expect(combine(bad, ok)).toBe('contradiction')
  })

  it('is unprobed when neither axis ran, and never healthy', () => {
    expect(combine(null, null)).toBe('unprobed')
  })

  it('does not call a system healthy on one axis alone', () => {
    expect(combine(ok, null)).not.toBe('healthy')
    expect(combine(null, ok)).not.toBe('healthy')
  })

  // --- The defect in the original brief: `not-probed` is absence, not failure. ---

  it('does NOT read route-broken when the external axis simply had no opinion', () => {
    // The brief's helper treated `not-probed` as a failed answer, so this
    // used to come out `route-broken` -- claiming DNS/routing/TLS is broken
    // when the external probe never ran (e.g. an unmapped port, spec §3.1).
    expect(combine(ok, notProbed)).not.toBe('route-broken')
    expect(combine(ok, notProbed)).toBe('unconfirmed')
  })

  it('does NOT read contradiction when the on-box axis simply had no opinion', () => {
    // The brief's helper used to produce `contradiction` here -- flagging a
    // disagreement between the axes that does not exist, because the
    // on-box axis never had an opinion to disagree with.
    expect(combine(notProbed, ok)).not.toBe('contradiction')
    expect(combine(notProbed, ok)).toBe('unconfirmed')
  })

  it('does NOT declare the app down when both axes simply had no opinion', () => {
    // The brief's helper used to produce `app-down` here -- a red row
    // asserting an outage nobody observed, from zero evidence.
    expect(combine(notProbed, notProbed)).not.toBe('app-down')
    expect(combine(notProbed, notProbed)).toBe('unprobed')
  })

  it('treats a not-probed axis identically to a missing (null) one', () => {
    expect(combine(notProbed, null)).toBe('unprobed')
    expect(combine(null, notProbed)).toBe('unprobed')
    expect(combine(notProbed, bad)).toBe('unconfirmed')
    expect(combine(bad, notProbed)).toBe('unconfirmed')
  })

  // --- The partial-evidence distinction this file adds beyond the brief. ---

  it('distinguishes partial evidence (unconfirmed) from zero evidence (unprobed)', () => {
    expect(combine(ok, null)).toBe('unconfirmed')
    expect(combine(null, ok)).toBe('unconfirmed')
    expect(combine(bad, null)).toBe('unconfirmed')
    expect(combine(null, bad)).toBe('unconfirmed')
    expect(combine(null, null)).toBe('unprobed')
    expect(combine(ok, null)).not.toBe('unprobed')
  })
})

describe('fleet-wide external failure', () => {
  it('is true only when EVERY external probe failed', () => {
    expect(isFleetWideExternalFailure([{ outcome: 'not-answering' }, { outcome: 'tls-failed' }])).toBe(true)
  })

  it('is false when even one answered — that is a real outage, not our network', () => {
    expect(isFleetWideExternalFailure([{ outcome: 'not-answering' }, { outcome: 'answering' }])).toBe(false)
  })

  it('is false for an empty set, which proves nothing', () => {
    expect(isFleetWideExternalFailure([])).toBe(false)
  })

  it('is false when every entry is not-probed — absence wearing a different shape', () => {
    expect(isFleetWideExternalFailure([{ outcome: 'not-probed' }, { outcome: 'not-probed' }])).toBe(false)
  })

  it('ignores not-probed entries when judging the ones that actually ran', () => {
    expect(isFleetWideExternalFailure([{ outcome: 'not-probed' }, { outcome: 'not-answering' }])).toBe(true)
    expect(isFleetWideExternalFailure([{ outcome: 'not-probed' }, { outcome: 'answering' }])).toBe(false)
  })
})

describe('primary hostname', () => {
  it('prefers one that answers', () => {
    const r = new Map([['zzz.example.invalid', 'answering' as const], ['a.example.invalid', 'not-answering' as const]])
    expect(primaryHostname(['a.example.invalid', 'zzz.example.invalid'], r)).toBe('zzz.example.invalid')
  })

  it('treats answering-oddly as answering too', () => {
    const r = new Map([['zzz.example.invalid', 'answering-oddly' as const], ['a.example.invalid', 'not-answering' as const]])
    expect(primaryHostname(['a.example.invalid', 'zzz.example.invalid'], r)).toBe('zzz.example.invalid')
  })

  it('falls back to shortest, then alphabetical, so it never changes between refreshes', () => {
    const r = new Map<string, never>()
    expect(primaryHostname(['bbb.example.invalid', 'a.example.invalid'], r)).toBe('a.example.invalid')
    expect(primaryHostname(['b.example.invalid', 'a.example.invalid'], r)).toBe('a.example.invalid')
  })

  it('prefers shortest over alphabetical when the two disagree', () => {
    // `z.example.invalid` (17 chars) is SHORTER than `aaaa.example.invalid`
    // (20 chars) but sorts AFTER it alphabetically ('a' < 'z'). A rule that
    // fell through to pure alphabetical ordering — skipping the length
    // tiebreak entirely — would still pass a fixture where the shorter
    // hostname also happens to be alphabetically first (as the pair above
    // is), so it would not catch a missing length rule. This fixture forces
    // the two rules to disagree, so it only passes if length is genuinely
    // checked before alphabetical order.
    const r = new Map<string, never>()
    expect(primaryHostname(['aaaa.example.invalid', 'z.example.invalid'], r)).toBe('z.example.invalid')
  })

  it('is null when there are no hostnames', () => {
    expect(primaryHostname([], new Map())).toBeNull()
  })
})
