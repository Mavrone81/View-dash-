import { describe, it, expect } from 'vitest'
import { randomBytes } from 'node:crypto'
import { newVaultKey, newRecoveryKey, wrapVaultKey, unwrapVaultKey, recoveryKeyFromDisplay } from './keyring.js'

describe('keyring', () => {
  it('round-trips the vault key through the passphrase wrapping', () => {
    const vk = newVaultKey(); const wk = randomBytes(32)
    expect(unwrapVaultKey(wrapVaultKey(vk, wk, 'passphrase'), wk, 'passphrase').equals(vk)).toBe(true)
  })

  it('round-trips the vault key through the recovery wrapping', () => {
    const vk = newVaultKey(); const rk = newRecoveryKey()
    expect(unwrapVaultKey(wrapVaultKey(vk, rk.key, 'recovery'), rk.key, 'recovery').equals(vk)).toBe(true)
  })

  it('REFUSES to open a passphrase wrapping as a recovery wrapping', () => {
    const vk = newVaultKey(); const wk = randomBytes(32)
    const wrapped = wrapVaultKey(vk, wk, 'passphrase')
    expect(() => unwrapVaultKey(wrapped, wk, 'recovery')).toThrow()
  })

  it('REFUSES the wrong wrapping key', () => {
    const vk = newVaultKey()
    const wrapped = wrapVaultKey(vk, randomBytes(32), 'passphrase')
    expect(() => unwrapVaultKey(wrapped, randomBytes(32), 'passphrase')).toThrow()
  })

  it('recovers the same key bytes from its printed form', () => {
    const rk = newRecoveryKey()
    expect(recoveryKeyFromDisplay(rk.display).equals(rk.key)).toBe(true)
  })

  it('REJECTS a malformed printed recovery key rather than deriving something', () => {
    expect(() => recoveryKeyFromDisplay('not a recovery key')).toThrow()
  })

  it('produces a different vault key every time', () => {
    expect(newVaultKey().equals(newVaultKey())).toBe(false)
  })
})
