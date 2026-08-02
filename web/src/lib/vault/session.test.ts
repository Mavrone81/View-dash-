import { describe, it, expect, beforeEach, vi } from 'vitest'
import { randomBytes } from 'node:crypto'
import {
  unlockSession,
  currentVaultKey,
  lockSession,
  isUnlocked,
  sessionExpiresAt,
  remainingSessionMs,
  DEFAULT_TTL_MS,
} from './session.js'

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

  describe('sessionExpiresAt', () => {
    it('is null while locked', () => {
      expect(sessionExpiresAt()).toBeNull()
    })

    it('returns the exact deadline currentVaultKey is checking against', () => {
      unlockSession(randomBytes(32), at(1000))
      expect(sessionExpiresAt(at(1000))).toBe(1000 + DEFAULT_TTL_MS)
    })

    it('locks itself and returns null once the window expires -- same boundary as currentVaultKey', () => {
      unlockSession(randomBytes(32), at(1000))
      expect(sessionExpiresAt(at(1000 + DEFAULT_TTL_MS + 1))).toBeNull()
      // The side effect (locking) is shared with currentVaultKey, not a
      // separate check that could disagree with it.
      expect(currentVaultKey(at(1000 + DEFAULT_TTL_MS + 1))).toBeNull()
    })

    it('is still non-null exactly AT the boundary, not past it', () => {
      unlockSession(randomBytes(32), at(1000))
      expect(sessionExpiresAt(at(1000 + DEFAULT_TTL_MS))).toBe(1000 + DEFAULT_TTL_MS)
    })

    it('reflects a lock taken on demand', () => {
      unlockSession(randomBytes(32), at(1000))
      lockSession()
      expect(sessionExpiresAt(at(1000))).toBeNull()
    })
  })

  // fix round 2: a DURATION, not the absolute instant sessionExpiresAt
  // returns -- see session.ts's doc comment for why.
  describe('remainingSessionMs', () => {
    it('is null while locked', () => {
      expect(remainingSessionMs()).toBeNull()
    })

    it('returns the full TTL at the moment of unlock', () => {
      unlockSession(randomBytes(32), at(1000))
      expect(remainingSessionMs(at(1000))).toBe(DEFAULT_TTL_MS)
    })

    it('counts down as time passes, unlike the absolute instant sessionExpiresAt returns', () => {
      unlockSession(randomBytes(32), at(1000))
      expect(remainingSessionMs(at(1000 + 60_000))).toBe(DEFAULT_TTL_MS - 60_000)
      // sessionExpiresAt, by contrast, is the same fixed instant regardless
      // of how much of the window has already elapsed -- the two functions
      // exist to answer different questions.
      expect(sessionExpiresAt(at(1000 + 60_000))).toBe(1000 + DEFAULT_TTL_MS)
    })

    it('is exactly zero at the boundary, not null -- the window has not yet expired', () => {
      unlockSession(randomBytes(32), at(1000))
      expect(remainingSessionMs(at(1000 + DEFAULT_TTL_MS))).toBe(0)
    })

    it('locks itself and returns null once the window expires -- same boundary as sessionExpiresAt', () => {
      unlockSession(randomBytes(32), at(1000))
      expect(remainingSessionMs(at(1000 + DEFAULT_TTL_MS + 1))).toBeNull()
      expect(currentVaultKey(at(1000 + DEFAULT_TTL_MS + 1))).toBeNull()
    })

    it('reflects a lock taken on demand', () => {
      unlockSession(randomBytes(32), at(1000))
      lockSession()
      expect(remainingSessionMs(at(1000))).toBeNull()
    })
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
