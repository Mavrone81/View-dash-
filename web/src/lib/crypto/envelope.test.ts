import { describe, it, expect } from 'vitest'
import { randomBytes } from 'node:crypto'
import { seal, open, unwrapDek } from './envelope.js'

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

  it('unwraps a DEK sealed by the KEK', () => {
    const kek = randomBytes(32)
    const rawDek = randomBytes(32)
    const wrapped = seal(rawDek.toString('base64'), 'dek:0:wrapped', kek)
    expect(unwrapDek(wrapped, kek)).toEqual(rawDek)
  })

  it('refuses to unwrap a DEK with the wrong KEK', () => {
    const kek = randomBytes(32)
    const rawDek = randomBytes(32)
    const wrapped = seal(rawDek.toString('base64'), 'dek:0:wrapped', kek)
    expect(() => unwrapDek(wrapped, randomBytes(32))).toThrow()
  })

  it('refuses to unwrap a value that is not a 32-byte key', () => {
    const kek = randomBytes(32)
    const wrapped = seal('too-short', 'dek:0:wrapped', kek)
    expect(() => unwrapDek(wrapped, kek)).toThrow()
  })
})
