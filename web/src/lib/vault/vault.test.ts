import { describe, it, expect, beforeEach, vi } from 'vitest'
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
    await acknowledgeRecoveryKey()
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
    await acknowledgeRecoveryKey()
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
      await acknowledgeRecoveryKey()
      await addCredential({ label: 'admin', username: 'operator', secret: 'hunter2' })
      lockSession()
      // Stored credentials are the graver fact and the one with no way
      // around it; reporting "unlock and retry" here would send the operator
      // to unlock and hit a different wall.
      await expect(recreateVault('a different passphrase')).rejects.toBeInstanceOf(VaultNotEmptyError)
    })
  })

  // --- Task 10 round 4. The SERIALIZABLE pairing was reasoned about and was
  // WRONG, which a real database settled: with both transactions at
  // SERIALIZABLE, this interleaving committed BOTH of them. Postgres SSI
  // aborts on a dangerous structure that needs a CYCLE; `recreateVault` read
  // Credential and wrote VaultConfig, `addCredential` wrote Credential and
  // read nothing `recreateVault` writes -- one rw-edge, no cycle, no abort.
  // The credential survived, sealed under the OLD vault key, while
  // VaultConfig held the new one. Permanently unreadable, silently, with no
  // error anywhere.
  //
  // These tests DRIVE the interleaving against the real database rather than
  // describing it: one transaction is suspended mid-flight, at the exact
  // statement that matters, while the other runs into it. Both orderings are
  // covered, because the fix has a different mechanism in each.
  describe('a credential stored while a recreate is in flight (round 4)', () => {
    /**
     * Suspends the NEXT `prisma.$transaction` immediately after a chosen
     * statement, using the real transaction underneath so the locking under
     * test is Postgres's own and not a simulation.
     *
     * `after: 'count'` pauses a recreate just past its `credential.count()`;
     * `after: 'lock'` pauses an addCredential just past the `$queryRaw` that
     * takes the row lock. In both cases the transaction stays OPEN, holding
     * whatever it has locked, until `release()`.
     */
    function suspendNextTransaction(after: 'count' | 'lock') {
      let release!: () => void
      const suspended = new Promise<void>((resolve) => {
        release = resolve
      })
      let reach!: () => void
      const reached = new Promise<void>((resolve) => {
        reach = resolve
      })

      const realTransaction = prisma.$transaction.bind(prisma)
      const spy = vi
        .spyOn(prisma, '$transaction')
        .mockImplementationOnce((run: unknown, options: unknown) =>
          (realTransaction as (r: unknown, o: unknown) => Promise<unknown>)(
            async (tx: unknown) => {
              const target = tx as Record<string, unknown>
              const paused = new Proxy(target, {
                get(t, prop, receiver) {
                  if (after === 'count' && prop === 'credential') {
                    const real = Reflect.get(t, prop, receiver) as {
                      count: (...a: unknown[]) => Promise<number>
                    }
                    return {
                      ...real,
                      count: async (...args: unknown[]) => {
                        const n = await real.count(...args)
                        reach()
                        await suspended
                        return n
                      },
                    }
                  }
                  if (after === 'lock' && prop === '$queryRaw') {
                    const real = Reflect.get(t, prop, receiver) as (
                      ...a: unknown[]
                    ) => Promise<unknown>
                    return async (...args: unknown[]) => {
                      const rows = await real.apply(t, args)
                      reach()
                      await suspended
                      return rows
                    }
                  }
                  return Reflect.get(t, prop, receiver)
                },
              })
              return (run as (t: unknown) => Promise<unknown>)(paused)
            },
            options,
          ),
        )

      return { release, reached, restore: () => spy.mockRestore() }
    }

    /** Long enough for the other transaction to reach its lock and block on it. */
    const settle = () => new Promise((resolve) => setTimeout(resolve, 250))

    /**
     * The invariant, checked against the DATABASE rather than inferred from
     * which promise rejected: whatever survived must still be readable under
     * whatever configuration survived. A credential sealed under a discarded
     * vault key is the exact silent corruption this is about.
     */
    async function everySurvivingCredentialIsStillReadable() {
      const survivors = await prisma.credential.findMany({ select: { id: true } })
      lockSession()
      const opened =
        (await unlockWithPassphrase('right passphrase')) ||
        (await unlockWithPassphrase('a different passphrase'))
      expect(opened).toBe(true)
      for (const row of survivors) {
        await expect(revealCredential(row.id)).resolves.toBe('hunter2')
      }
      return survivors.length
    }

    it('refuses the ADD when a recreate already holds the vault configuration', async () => {
      await createVault('right passphrase')
      await acknowledgeRecoveryKey()

      const held = suspendNextTransaction('count')
      let addOutcome: PromiseSettledResult<string>
      let recreateOutcome: PromiseSettledResult<{ recoveryKey: string }>
      try {
        const recreating = recreateVault('a different passphrase')
        await held.reached

        // Starts while the recreate holds the row lock, so this blocks on it.
        const adding = addCredential({ label: 'admin', username: 'operator', secret: 'hunter2' })
        await settle()
        held.release()
        ;[recreateOutcome, addOutcome] = await Promise.allSettled([recreating, adding])
      } finally {
        held.restore()
      }

      // Both succeeding is the reviewer's finding. Before the fix this
      // assertion failed with `expected true to be false`.
      expect(
        addOutcome.status === 'fulfilled' && recreateOutcome.status === 'fulfilled',
      ).toBe(false)
      // In THIS ordering the recreate wins and the add is the one refused:
      // the row it waited for was deleted, so its lock query returns nothing.
      expect(recreateOutcome.status).toBe('fulfilled')
      expect(addOutcome.status).toBe('rejected')
      expect(await everySurvivingCredentialIsStillReadable()).toBe(0)
    })

    it('refuses the RECREATE when an add already holds the vault configuration', async () => {
      await createVault('right passphrase')
      await acknowledgeRecoveryKey()

      const held = suspendNextTransaction('lock')
      let addOutcome: PromiseSettledResult<string>
      let recreateOutcome: PromiseSettledResult<{ recoveryKey: string }>
      try {
        const adding = addCredential({ label: 'admin', username: 'operator', secret: 'hunter2' })
        await held.reached

        const recreating = recreateVault('a different passphrase')
        await settle()
        held.release()
        ;[recreateOutcome, addOutcome] = await Promise.allSettled([recreating, adding])
      } finally {
        held.restore()
      }

      expect(
        addOutcome.status === 'fulfilled' && recreateOutcome.status === 'fulfilled',
      ).toBe(false)
      // The mirror ordering: the add commits, and the recreate's count --
      // taken only after it finally acquires the lock -- sees it.
      expect(addOutcome.status).toBe('fulfilled')
      expect(recreateOutcome.status).toBe('rejected')
      if (recreateOutcome.status === 'rejected') {
        expect(recreateOutcome.reason).toBeInstanceOf(VaultNotEmptyError)
      }
      expect(await everySurvivingCredentialIsStillReadable()).toBe(1)
    })
  })

  it('allows recreation again once the last credential is gone', async () => {
    await createVault('right passphrase')
    await acknowledgeRecoveryKey()
    const id = await addCredential({ label: 'admin', username: 'operator', secret: 'hunter2' })
    await expect(recreateVault('a different passphrase')).rejects.toThrow()
    await prisma.credential.delete({ where: { id } })
    await expect(recreateVault('a different passphrase')).resolves.toBeDefined()
  })
})
