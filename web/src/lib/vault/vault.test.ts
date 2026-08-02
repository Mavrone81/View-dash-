import { describe, it, expect, beforeEach } from 'vitest'
import { prisma } from '../db.js'
import { lockSession, unlockSession, isUnlocked, currentVaultKey } from './session.js'
import {
  createVault,
  isInitialised,
  unlockWithPassphrase,
  unlockWithRecoveryKey,
  changePassphrase,
  readVaultStatus,
  acknowledgeRecoveryKey,
  recreateVault,
  VaultNotEmptyError,
  RecoveryKeyStillValidError,
} from './vault.js'
import { addCredential, revealCredential } from './credentials.js'

beforeEach(async () => {
  lockSession()
  await prisma.credentialAccess.deleteMany()
  await prisma.credential.deleteMany()
  await prisma.vaultConfig.deleteMany()
})

describe('vault lifecycle', () => {
  it('reports uninitialised before creation', async () => {
    expect(await isInitialised()).toBe(false)
  })

  it('creates a vault and returns a recovery key exactly once', async () => {
    const { recoveryKey } = await createVault('right passphrase')
    expect(recoveryKey.length).toBeGreaterThan(20)
    expect(await isInitialised()).toBe(true)
  })

  it('REFUSES to create a second vault over an existing one', async () => {
    await createVault('first')
    await expect(createVault('second')).rejects.toThrow()
  })

  it('unlocks with the right passphrase', async () => {
    await createVault('right'); lockSession()
    expect(await unlockWithPassphrase('right')).toBe(true)
    expect(isUnlocked()).toBe(true)
  })

  it('REFUSES the wrong passphrase and stays locked', async () => {
    await createVault('right'); lockSession()
    expect(await unlockWithPassphrase('wrong')).toBe(false)
    expect(isUnlocked()).toBe(false)
  })

  it('unlocks with the recovery key', async () => {
    const { recoveryKey } = await createVault('right'); lockSession()
    expect(await unlockWithRecoveryKey(recoveryKey)).toBe(true)
  })

  it('REFUSES a wrong recovery key and stays locked', async () => {
    await createVault('right'); lockSession()
    expect(await unlockWithRecoveryKey('AAAAAAAA-BBBBBBBB-CCCCCCCC-DDDDDDDD-EEEEEEEE-FFFFFFFF')).toBe(false)
    expect(isUnlocked()).toBe(false)
  })

  it('changes the passphrase and yields the SAME vault key', async () => {
    await createVault('old')
    await unlockWithPassphrase('old')
    const before = currentVaultKey()?.toString('base64')
    expect(await changePassphrase('old', 'new')).toBe(true)
    lockSession()
    expect(await unlockWithPassphrase('new')).toBe(true)
    expect(currentVaultKey()?.toString('base64')).toBe(before)
  })

  it('REFUSES to change the passphrase with the wrong current one', async () => {
    await createVault('old')
    expect(await changePassphrase('not-old', 'new')).toBe(false)
    lockSession()
    expect(await unlockWithPassphrase('old')).toBe(true)
  })

  it('leaves the RECOVERY key working after a passphrase change', async () => {
    const { recoveryKey } = await createVault('old')
    await changePassphrase('old', 'new')
    lockSession()
    expect(await unlockWithRecoveryKey(recoveryKey)).toBe(true)
  })
})

// --- Task 10 round 2. The recovery key is displayed exactly once and
// persisted nowhere, so a vault whose operator walked away or reloaded looked
// completely healthy while its only recovery key had been recorded nowhere.
// The discovery moment would be a forgotten passphrase, with every credential
// already unrecoverable -- a mitigation that can be silently absent is not
// one. `recoveryKeyAcknowledgedAt` makes the absence visible; `recreateVault`
// is the only way out of it, and is destructive, so it refuses unless the
// vault is empty. ---
describe('recovery-key acknowledgement', () => {
  it('a freshly created vault is initialised but NOT acknowledged', async () => {
    await createVault('right passphrase')
    expect(await readVaultStatus()).toEqual({ initialised: true, recoveryKeyAcknowledged: false })
  })

  it('reports neither initialised nor acknowledged when no vault exists', async () => {
    expect(await readVaultStatus()).toEqual({ initialised: false, recoveryKeyAcknowledged: false })
  })

  it('acknowledging records it, and the status flips', async () => {
    await createVault('right passphrase')
    expect(await acknowledgeRecoveryKey()).toBe(true)
    expect(await readVaultStatus()).toEqual({ initialised: true, recoveryKeyAcknowledged: true })
  })

  it('acknowledging with no vault reports failure rather than a silent success', async () => {
    expect(await acknowledgeRecoveryKey()).toBe(false)
  })

  it('acknowledging twice keeps the FIRST timestamp -- a retry must not rewrite when it was confirmed', async () => {
    await createVault('right passphrase')
    await acknowledgeRecoveryKey(new Date('2026-08-02T01:00:00.000Z'))
    const first = (await prisma.vaultConfig.findFirstOrThrow()).recoveryKeyAcknowledgedAt
    expect(await acknowledgeRecoveryKey(new Date('2026-08-02T09:00:00.000Z'))).toBe(true)
    const second = (await prisma.vaultConfig.findFirstOrThrow()).recoveryKeyAcknowledgedAt
    expect(second).toEqual(first)
  })

  it('never stores the recovery key itself, only that it was acknowledged', async () => {
    const { recoveryKey } = await createVault('right passphrase')
    await acknowledgeRecoveryKey()
    const row = await prisma.vaultConfig.findFirstOrThrow()
    expect(JSON.stringify(row)).not.toContain(recoveryKey)
  })
})

describe('recreating a vault whose recovery key was never stored', () => {
  it('issues a NEW recovery key that works, and retires the old one', async () => {
    const first = await createVault('right passphrase')
    const second = await recreateVault('a different passphrase')
    expect(second.recoveryKey).not.toBe(first.recoveryKey)

    lockSession()
    expect(await unlockWithRecoveryKey(second.recoveryKey)).toBe(true)
    lockSession()
    // The old key unwrapped the OLD vault key, which no longer exists.
    expect(await unlockWithRecoveryKey(first.recoveryKey)).toBe(false)
  })

  it('replaces the passphrase too: the old one no longer opens the new vault', async () => {
    await createVault('right passphrase')
    await recreateVault('a different passphrase')
    lockSession()
    expect(await unlockWithPassphrase('right passphrase')).toBe(false)
    lockSession()
    expect(await unlockWithPassphrase('a different passphrase')).toBe(true)
  })

  it('leaves the new vault UNACKNOWLEDGED -- its key has been shown and not yet stored', async () => {
    await createVault('right passphrase')
    await acknowledgeRecoveryKey()
    await recreateVault('a different passphrase')
    expect(await readVaultStatus()).toEqual({ initialised: true, recoveryKeyAcknowledged: false })
  })

  it('still leaves exactly one config row', async () => {
    await createVault('right passphrase')
    await recreateVault('a different passphrase')
    expect(await prisma.vaultConfig.count()).toBe(1)
  })

  // THE denial. Recreation throws away the vault key, so every sealed secret
  // becomes permanently unreadable. Refusing must be the code's doing, not
  // the UI's for having hidden a button.
  it('REFUSES to recreate a vault holding a credential, and destroys nothing', async () => {
    await createVault('right passphrase')
    const id = await addCredential({ label: 'admin', username: 'operator', secret: 'hunter2' })

    await expect(recreateVault('a different passphrase')).rejects.toBeInstanceOf(VaultNotEmptyError)

    // Nothing moved: the config row, the credential, and -- the part that
    // actually matters -- the ability to read the secret back.
    expect(await prisma.credential.count()).toBe(1)
    expect(await prisma.vaultConfig.count()).toBe(1)
    lockSession()
    expect(await unlockWithPassphrase('right passphrase')).toBe(true)
    expect(await revealCredential(id)).toBe('hunter2')
  })

  it('refuses on the credential COUNT, not on whether the credential is attached to a system', async () => {
    await createVault('right passphrase')
    await addCredential({ label: 'orphan', username: 'operator', secret: 'hunter2' })
    await expect(recreateVault('a different passphrase')).rejects.toBeInstanceOf(VaultNotEmptyError)
  })

  // --- Task 10 round 3. Emptiness alone was not enough. An empty vault has
  // nothing to destroy EXCEPT the thing recreation always destroys: the vault
  // key, and with it a recovery key the operator may already have printed and
  // filed. Create, print, acknowledge, get called away before storing
  // anything, and the vault is acknowledged, empty and correct -- at which
  // point anything that could reach these unauthenticated server actions
  // could have replaced the vault key and left the printed copy silently
  // dead, to be discovered on the day it was needed. That is the exact
  // failure the acknowledgement exists to remove, so leaving an
  // unauthenticated way to undo it would have been building the mitigation
  // and shipping its own bypass.
  //
  // Rule: zero credentials AND (unacknowledged OR unlocked).
  describe('who may recreate an empty vault', () => {
    it('ALLOWS it while the recovery key was never acknowledged, even with the vault locked', async () => {
      await createVault('right passphrase')
      lockSession()
      // No passphrase proof demanded, on purpose: this is the remedy path,
      // and the operator has a passphrase -- what they lack is a recovery
      // key, so gating on the passphrase would gate on the wrong thing.
      await expect(recreateVault('a different passphrase')).resolves.toBeDefined()
    })

    it('ALLOWS it when the key IS acknowledged but the session is unlocked', async () => {
      await createVault('right passphrase')
      await acknowledgeRecoveryKey()
      // createVault leaves the session unlocked; assert that rather than
      // assume it, since the whole case turns on it.
      expect(isUnlocked()).toBe(true)
      await expect(recreateVault('a different passphrase')).resolves.toBeDefined()
    })

    it('REFUSES when the key is acknowledged and the vault is locked, and changes nothing', async () => {
      const { recoveryKey } = await createVault('right passphrase')
      await acknowledgeRecoveryKey()
      const before = await prisma.vaultConfig.findFirstOrThrow()
      lockSession()

      await expect(recreateVault('a different passphrase')).rejects.toBeInstanceOf(
        RecoveryKeyStillValidError,
      )

      // The row is byte-for-byte the one that was there, and -- the fact that
      // actually matters to the operator -- the recovery key in their drawer
      // still works.
      const after = await prisma.vaultConfig.findFirstOrThrow()
      expect(after.wrappedByRecovery).toBe(before.wrappedByRecovery)
      expect(after.wrappedByPassphrase).toBe(before.wrappedByPassphrase)
      expect(await unlockWithRecoveryKey(recoveryKey)).toBe(true)
    })

    it('refuses on a session whose deadline has passed, not merely on an explicit lock', async () => {
      await createVault('right passphrase')
      await acknowledgeRecoveryKey()
      // An expired session is locked, and `isUnlocked()` applies that expiry
      // itself -- so this must be refused for the same reason an explicit
      // lock is, without recreateVault knowing anything about deadlines.
      unlockSession(Buffer.alloc(32), () => new Date(Date.now() - 60_000), 1)
      expect(isUnlocked()).toBe(false)
      await expect(recreateVault('a different passphrase')).rejects.toBeInstanceOf(
        RecoveryKeyStillValidError,
      )
    })

    it('reports the not-empty refusal, not the acknowledgement one, when BOTH would apply', async () => {
      await createVault('right passphrase')
      await addCredential({ label: 'admin', username: 'operator', secret: 'hunter2' })
      await acknowledgeRecoveryKey()
      lockSession()
      // Stored credentials are the graver fact and the one with no way
      // around it; reporting "unlock and retry" here would send the operator
      // to unlock and hit a different wall.
      await expect(recreateVault('a different passphrase')).rejects.toBeInstanceOf(VaultNotEmptyError)
    })
  })

  it('allows recreation again once the last credential is gone', async () => {
    await createVault('right passphrase')
    const id = await addCredential({ label: 'admin', username: 'operator', secret: 'hunter2' })
    await expect(recreateVault('a different passphrase')).rejects.toThrow()
    await prisma.credential.delete({ where: { id } })
    await expect(recreateVault('a different passphrase')).resolves.toBeDefined()
  })
})
