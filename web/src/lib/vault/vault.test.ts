import { describe, it, expect, beforeEach } from 'vitest'
import { prisma } from '../db.js'
import { lockSession, isUnlocked, currentVaultKey } from './session.js'
import { createVault, isInitialised, unlockWithPassphrase, unlockWithRecoveryKey, changePassphrase } from './vault.js'

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
