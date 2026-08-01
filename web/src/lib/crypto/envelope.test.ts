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
})
