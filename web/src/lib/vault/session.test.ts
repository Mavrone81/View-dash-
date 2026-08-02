import { describe, it, expect, beforeEach } from 'vitest'
import { randomBytes } from 'node:crypto'
import { unlockSession, currentVaultKey, lockSession, isUnlocked, DEFAULT_TTL_MS } from './session.js'

const at = (ms: number) => () => new Date(ms)

beforeEach(() => lockSession())

describe('vault session', () => {
  it('starts locked', () => {
    expect(isUnlocked()).toBe(false)
    expect(currentVaultKey()).toBeNull()
  })

  it('returns the key while unlocked', () => {
    const vk = randomBytes(32)
    unlockSession(vk, at(1000))
    expect(currentVaultKey(at(1000))?.equals(vk)).toBe(true)
  })

  it('LOCKS ITSELF once the window expires', () => {
    unlockSession(randomBytes(32), at(1000))
    expect(currentVaultKey(at(1000 + DEFAULT_TTL_MS + 1))).toBeNull()
    expect(isUnlocked(at(1000 + DEFAULT_TTL_MS + 1))).toBe(false)
  })

  it('is still unlocked exactly AT the boundary, not past it', () => {
    unlockSession(randomBytes(32), at(1000))
    expect(currentVaultKey(at(1000 + DEFAULT_TTL_MS))).not.toBeNull()
  })

  it('locks on demand', () => {
    unlockSession(randomBytes(32), at(1000))
    lockSession()
    expect(currentVaultKey(at(1000))).toBeNull()
  })

  it('forgets the key on lock rather than merely flagging it locked', () => {
    const vk = randomBytes(32)
    unlockSession(vk, at(1000))
    lockSession()
    unlockSession(randomBytes(32), at(2000))
    expect(currentVaultKey(at(2000))?.equals(vk)).toBe(false)
  })
})
