import { describe, it, expect, beforeEach, vi } from 'vitest'
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

  it('returns null after lock, then the new key after unlock', () => {
    const vk1 = randomBytes(32)
    const vk2 = randomBytes(32)
    unlockSession(vk1, at(1000))
    lockSession()
    expect(currentVaultKey(at(1000))).toBeNull()
    unlockSession(vk2, at(2000))
    expect(currentVaultKey(at(2000))?.equals(vk2)).toBe(true)
  })

  it('default clock is evaluated per-call, not frozen at module load', () => {
    vi.useFakeTimers()
    try {
      const vk = randomBytes(32)
      // Unlock with no clock argument (uses default per-call evaluation)
      unlockSession(vk)
      // Advance time past the TTL
      vi.advanceTimersByTime(DEFAULT_TTL_MS + 1)
      // Check with no clock argument (uses default per-call evaluation)
      // If the default were frozen at module load, this would still see the old time
      // and return the key. Since it's per-call, it sees the advanced time and returns null.
      expect(currentVaultKey()).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })
})
