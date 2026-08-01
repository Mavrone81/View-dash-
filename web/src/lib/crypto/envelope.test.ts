import { describe, it, expect } from 'vitest'
import { randomBytes } from 'node:crypto'
import { seal, open, wrapDek, unwrapDek } from './envelope.js'

const dek = randomBytes(32)

describe('envelope', () => {
  it('round-trips under the same AAD', () => {
    const s = seal('super-secret', 'agent_enrolment:7:secret', dek)
    expect(open(s, 'agent_enrolment:7:secret', dek)).toBe('super-secret')
  })

  it('produces a different ciphertext each time (random IV)', () => {
    expect(seal('x', 'a:1:b', dek)).not.toBe(seal('x', 'a:1:b', dek))
  })

  it('refuses a ciphertext moved to a different row', () => {
    const s = seal('super-secret', 'agent_enrolment:7:secret', dek)
    expect(() => open(s, 'agent_enrolment:8:secret', dek)).toThrow()
  })

  it('refuses a tampered ciphertext', () => {
    const s = seal('super-secret', 'a:1:b', dek)
    const parts = s.split(':')
    // Non-null: seal() always emits 4 ':'-joined parts (asserted by open() itself).
    const ct = Buffer.from(parts[3]!, 'base64')
    ct[0] = ct[0]! ^ 0xff
    parts[3] = ct.toString('base64')
    expect(() => open(parts.join(':'), 'a:1:b', dek)).toThrow()
  })

  it('refuses the wrong key', () => {
    const s = seal('super-secret', 'a:1:b', dek)
    expect(() => open(s, 'a:1:b', randomBytes(32))).toThrow()
  })

  it('refuses an envelope with an unsupported version tag', () => {
    const s = seal('super-secret', 'a:1:b', dek)
    const parts = s.split(':')
    parts[0] = 'v2'
    expect(() => open(parts.join(':'), 'a:1:b', dek)).toThrow()
  })

  it('refuses a truncated auth tag, even a genuine prefix of the real one', () => {
    const s = seal('super-secret', 'a:1:b', dek)
    const parts = s.split(':')
    const fullTag = Buffer.from(parts[2]!, 'base64')
    // Node's GCM accepts tags as short as 4 bytes and verifies by truncated
    // comparison, so a genuine 4-byte PREFIX of the real tag verifies
    // successfully unless the length is rejected outright. A random 4-byte
    // tag would fail GCM's own comparison anyway and wouldn't prove this
    // check exists; a real prefix is the case that actually distinguishes
    // "length enforced" from "length not enforced" (and is exactly what an
    // attacker doing ~2^32 forgery work against a 4-byte tag would exploit).
    parts[2] = fullTag.subarray(0, 4).toString('base64')
    expect(() => open(parts.join(':'), 'a:1:b', dek)).toThrow()
  })

  it('refuses an envelope with too few fields', () => {
    expect(() => open('v1:onlyonefield', 'a:1:b', dek)).toThrow()
  })

  it('refuses an envelope with too many fields', () => {
    const s = seal('super-secret', 'a:1:b', dek)
    expect(() => open(`${s}:extra`, 'a:1:b', dek)).toThrow()
  })

  it('refuses an empty envelope string', () => {
    expect(() => open('', 'a:1:b', dek)).toThrow()
  })

  it('unwraps a DEK sealed by the KEK at the expected generation', () => {
    const kek = randomBytes(32)
    const rawDek = randomBytes(32)
    const wrapped = wrapDek(rawDek, 1, kek)
    expect(unwrapDek(wrapped, 1, kek)).toEqual(rawDek)
  })

  it('refuses to unwrap a DEK with the wrong KEK', () => {
    const kek = randomBytes(32)
    const rawDek = randomBytes(32)
    const wrapped = wrapDek(rawDek, 1, kek)
    expect(() => unwrapDek(wrapped, 1, randomBytes(32))).toThrow()
  })

  it('refuses to unwrap a value that is not a 32-byte key', () => {
    const kek = randomBytes(32)
    const wrapped = seal('too-short', 'dek:1:wrapped', kek)
    expect(() => unwrapDek(wrapped, 1, kek)).toThrow()
  })

  it('refuses a DEK wrapped at generation 1 when generation 2 is expected (rollback protection)', () => {
    const kek = randomBytes(32)
    const rawDek = randomBytes(32)
    const wrapped = wrapDek(rawDek, 1, kek)
    // This is the case that matters: without generation binding, a stale or
    // rolled-back wrapped key would authenticate perfectly and silently roll
    // the system back to a retired key generation.
    expect(() => unwrapDek(wrapped, 2, kek)).toThrow()
  })

  it('refuses a DEK wrapped at generation 2 when generation 1 is expected', () => {
    const kek = randomBytes(32)
    const rawDek = randomBytes(32)
    const wrapped = wrapDek(rawDek, 2, kek)
    expect(() => unwrapDek(wrapped, 1, kek)).toThrow()
  })

  it('refuses to wrap a key that is not 32 bytes', () => {
    const kek = randomBytes(32)
    expect(() => wrapDek(randomBytes(16), 1, kek)).toThrow()
  })

  it('round-trips a key through wrapDek/unwrapDek unchanged', () => {
    const kek = randomBytes(32)
    const rawDek = randomBytes(32)
    const wrapped = wrapDek(rawDek, 7, kek)
    expect(unwrapDek(wrapped, 7, kek)).toEqual(rawDek)
  })

  // Carried forward from an earlier round: dekAad happily stringified any
  // number into the AAD, so a negative, fractional, NaN, or Infinity
  // generation produced a syntactically fine but semantically meaningless
  // AAD instead of failing loudly. Guarded centrally in dekAad so both
  // wrapDek and unwrapDek inherit the check from their one shared source.
  it('refuses to wrap a DEK under a negative generation', () => {
    const kek = randomBytes(32)
    expect(() => wrapDek(randomBytes(32), -1, kek)).toThrow()
  })

  it('refuses to wrap a DEK under a fractional generation', () => {
    const kek = randomBytes(32)
    expect(() => wrapDek(randomBytes(32), 1.5, kek)).toThrow()
  })

  it('refuses to wrap a DEK under a NaN generation', () => {
    const kek = randomBytes(32)
    expect(() => wrapDek(randomBytes(32), NaN, kek)).toThrow()
  })

  it('refuses to wrap a DEK under an Infinity generation', () => {
    const kek = randomBytes(32)
    expect(() => wrapDek(randomBytes(32), Infinity, kek)).toThrow()
  })

  // These two fabricate the wrapped value with `seal` directly, using the
  // EXACT AAD unwrapDek would derive for the same bad generation, rather
  // than going through wrapDek(..., 1, ...) and requesting a different
  // generation. That distinction matters: wrapDek(dek, 1, kek) vs.
  // unwrapDek(wrapped, -1, kek) would already throw on ordinary AAD
  // mismatch (generation 1 was never validated, it's just a different
  // string from generation -1) whether or not the new guard exists, so it
  // would not prove anything. Matching the AAD isolates the guard: if it
  // did not exist, `open` would succeed outright (same key, same AAD).
  it('refuses to unwrap a DEK requested at a negative generation', () => {
    const kek = randomBytes(32)
    const rawDek = randomBytes(32)
    const fabricated = seal(rawDek.toString('base64'), 'dek:-1:wrapped', kek)
    expect(() => unwrapDek(fabricated, -1, kek)).toThrow()
  })

  it('refuses to unwrap a DEK requested at a fractional generation', () => {
    const kek = randomBytes(32)
    const rawDek = randomBytes(32)
    const fabricated = seal(rawDek.toString('base64'), 'dek:1.5:wrapped', kek)
    expect(() => unwrapDek(fabricated, 1.5, kek)).toThrow()
  })
})
