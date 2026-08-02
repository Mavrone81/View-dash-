import { describe, it, expect } from 'vitest'
import { newKdfParams, deriveWrappingKey, makeVerifier, checkVerifier, KdfParamsError } from './kdf.js'
import type { KdfParams } from './kdf.js'

describe('kdf', () => {
  it('derives a stable 32-byte key for the same passphrase and params', () => {
    const p = newKdfParams()
    const a = deriveWrappingKey('correct horse battery staple', p)
    const b = deriveWrappingKey('correct horse battery staple', p)
    expect(a.length).toBe(32)
    expect(a.equals(b)).toBe(true)
  })

  it('derives a different key for a different passphrase', () => {
    const p = newKdfParams()
    expect(deriveWrappingKey('one', p).equals(deriveWrappingKey('two', p))).toBe(false)
  })

  it('derives a different key for the same passphrase under a fresh salt', () => {
    const a = deriveWrappingKey('same', newKdfParams())
    const b = deriveWrappingKey('same', newKdfParams())
    expect(a.equals(b)).toBe(false)
  })

  it('accepts the correct passphrase via the verifier', () => {
    const p = newKdfParams()
    const k = deriveWrappingKey('right', p)
    expect(checkVerifier(k, makeVerifier(k))).toBe(true)
  })

  it('REJECTS a wrong passphrase rather than returning garbage', () => {
    const p = newKdfParams()
    const verifier = makeVerifier(deriveWrappingKey('right', p))
    expect(checkVerifier(deriveWrappingKey('wrong', p), verifier)).toBe(false)
  })

  it('does not throw on a malformed verifier', () => {
    const k = deriveWrappingKey('x', newKdfParams())
    expect(checkVerifier(k, 'not-a-verifier')).toBe(false)
  })

  it('REJECTS an empty salt instead of deriving from a zero-byte salt', () => {
    const p = { ...newKdfParams(), saltB64: '' }
    expect(() => deriveWrappingKey('x', p)).toThrow(/salt/)
  })

  it('REJECTS a salt shorter than 16 bytes', () => {
    const p = { ...newKdfParams(), saltB64: Buffer.from('short').toString('base64') }
    expect(() => deriveWrappingKey('x', p)).toThrow(/salt/)
  })

  it('REJECTS a downgraded N instead of silently deriving a weaker key', () => {
    const p = { ...newKdfParams(), N: 2 }
    expect(() => deriveWrappingKey('x', p)).toThrow(/N/)
  })

  it('REJECTS a non-integer or NaN N', () => {
    const withNaN = { ...newKdfParams(), N: Number.NaN }
    const withFloat = { ...newKdfParams(), N: 65536.5 }
    expect(() => deriveWrappingKey('x', withNaN)).toThrow(/N/)
    expect(() => deriveWrappingKey('x', withFloat)).toThrow(/N/)
  })

  // --- Task 10 / finding I5: every rejection above must be a NAMED type, not
  // a plain Error. The caller that matters (actions.ts) classifies by
  // `instanceof`, and a plain Error there falls through to "try again in a
  // moment" -- permanent damage reported as a transient blip. These assert
  // the TYPE, which is the part the classifier depends on; the `/N/`-style
  // message assertions above stay as they are.
  describe('rejections are a named, classifiable type (I5)', () => {
    it('a downgraded N is rejected as a KdfParamsError, not a plain Error', () => {
      const p = { ...newKdfParams(), N: 1024 }
      expect(() => deriveWrappingKey('x', p)).toThrow(KdfParamsError)
    })

    it('a short salt is rejected as a KdfParamsError', () => {
      const p = { ...newKdfParams(), saltB64: Buffer.from('short').toString('base64') }
      expect(() => deriveWrappingKey('x', p)).toThrow(KdfParamsError)
    })

    // The two shapes that reach here through vault.ts's unchecked
    // `JSON.parse(...) as KdfParams`. `{}` used to throw a plain Error from
    // the N check; `null` used to die on a bare TypeError ("cannot read
    // properties of null") before any check ran at all -- neither of which
    // the caller could tell apart from an unrelated transient failure.
    it('an empty object is rejected as a KdfParamsError', () => {
      expect(() => deriveWrappingKey('x', {} as KdfParams)).toThrow(KdfParamsError)
    })

    it('a null params value is rejected as a KdfParamsError, not a TypeError', () => {
      expect(() => deriveWrappingKey('x', null as unknown as KdfParams)).toThrow(KdfParamsError)
      expect(() => deriveWrappingKey('x', null as unknown as KdfParams)).not.toThrow(TypeError)
    })

    it('a non-numeric N is rejected as a KdfParamsError, not coerced', () => {
      const p = { ...newKdfParams(), N: '65536' as unknown as number }
      expect(() => deriveWrappingKey('x', p)).toThrow(KdfParamsError)
    })

    it('a non-string salt is rejected as a KdfParamsError', () => {
      const p = { ...newKdfParams(), saltB64: 42 as unknown as string }
      expect(() => deriveWrappingKey('x', p)).toThrow(KdfParamsError)
    })

    it('never puts the salt value in the rejection message', () => {
      const salt = Buffer.from('a-recognisable-salt-value').toString('base64')
      const p = { ...newKdfParams(), N: 1024, saltB64: salt }
      try {
        deriveWrappingKey('the-passphrase', p)
        expect.unreachable('deriveWrappingKey should have rejected a downgraded N')
      } catch (err) {
        expect(err).toBeInstanceOf(KdfParamsError)
        expect((err as Error).message).not.toContain(salt)
        expect((err as Error).message).not.toContain('the-passphrase')
      }
    })
  })

  it('still derives normally for valid params (happy path untouched)', () => {
    const p = newKdfParams()
    const a = deriveWrappingKey('correct horse battery staple', p)
    const b = deriveWrappingKey('correct horse battery staple', p)
    expect(a.length).toBe(32)
    expect(a.equals(b)).toBe(true)
  })
})
