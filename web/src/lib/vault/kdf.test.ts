import { describe, it, expect } from 'vitest'
import { newKdfParams, deriveWrappingKey, makeVerifier, checkVerifier } from './kdf.js'

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

  it('still derives normally for valid params (happy path untouched)', () => {
    const p = newKdfParams()
    const a = deriveWrappingKey('correct horse battery staple', p)
    const b = deriveWrappingKey('correct horse battery staple', p)
    expect(a.length).toBe(32)
    expect(a.equals(b)).toBe(true)
  })
})
