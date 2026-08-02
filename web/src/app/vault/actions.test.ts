import { randomUUID } from 'node:crypto'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { Prisma } from '@prisma/client'
import { prisma } from '../../lib/db.js'
import { lockSession, DEFAULT_TTL_MS } from '../../lib/vault/session.js'

// `revalidatePath` throws outside a real Next.js request context ("static
// generation store missing" or similar) — which is exactly the situation
// under Vitest. Mocking it here means the revalidation behaviour itself is
// NOT exercised by this suite; only that the actions still return a plain
// result around it. See task-7-report.md.
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

import {
  createVaultAction,
  unlockAction,
  unlockWithRecoveryAction,
  lockAction,
  addCredentialAction,
  revealAction,
  removeCredentialAction,
  changePassphraseAction,
  acknowledgeRecoveryKeyAction,
  recreateVaultAction,
} from './actions.js'

beforeEach(async () => {
  lockSession()
  await prisma.credentialAccess.deleteMany()
  await prisma.credential.deleteMany()
  await prisma.vaultConfig.deleteMany()
})

describe('vault actions', () => {
  it('creates a vault and returns the recovery key once', async () => {
    const r = await createVaultAction('right passphrase')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.recoveryKey.length).toBeGreaterThan(20)
  })

  it('returns a plain failure for a wrong passphrase, never a thrown error', async () => {
    await createVaultAction('right passphrase'); lockSession()
    const r = await unlockAction('wrong passphrase')
    expect(r.ok).toBe(false)
  })

  it('does not leak the passphrase or secret in a failure message', async () => {
    await createVaultAction('right passphrase'); lockSession()
    const r = await unlockAction('my-secret-passphrase')
    expect(JSON.stringify(r)).not.toContain('my-secret-passphrase')
  })

  it('refuses to reveal while locked, without throwing at the client', async () => {
    await createVaultAction('right passphrase')
    await acknowledgeRecoveryKeyAction()
    const add = await addCredentialAction({ label: 'a', username: 'u', secret: 'hunter2' })
    expect(add.ok).toBe(true)
    lockSession()
    const r = await revealAction(add.ok ? add.id : '')
    expect(r.ok).toBe(false)
    expect(JSON.stringify(r)).not.toContain('hunter2')
  })

  // --- Resolution 1: reveal must discriminate locked / not-found / unreadable ---

  it('reveal while locked reports the vault as locked, distinct from other failures', async () => {
    await createVaultAction('right passphrase')
    await acknowledgeRecoveryKeyAction()
    const add = await addCredentialAction({ label: 'a', username: 'u', secret: 'hunter2' })
    expect(add.ok).toBe(true)
    lockSession()
    const r = await revealAction(add.ok ? add.id : '')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.message.toLowerCase()).toContain('locked')
  })

  it('reveal of an id that does not exist reports it as gone, not as locked', async () => {
    await createVaultAction('right passphrase')
    const r = await revealAction('00000000-0000-0000-0000-000000000000')
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.message.toLowerCase()).not.toContain('locked')
      expect(r.message.toLowerCase()).toMatch(/exist|found/)
    }
  })

  it('reveal of a tampered ciphertext reports it as unreadable, not as locked or missing', async () => {
    await createVaultAction('right passphrase')
    await acknowledgeRecoveryKeyAction()
    const a = await addCredentialAction({ label: 'a', username: 'u', secret: 'secret-a' })
    const b = await addCredentialAction({ label: 'b', username: 'u', secret: 'secret-b' })
    expect(a.ok).toBe(true)
    expect(b.ok).toBe(true)
    if (!a.ok || !b.ok) return
    const rowA = await prisma.credential.findUniqueOrThrow({ where: { id: a.id } })
    await prisma.credential.update({ where: { id: b.id }, data: { secretSealed: rowA.secretSealed } })
    const r = await revealAction(b.id)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.message.toLowerCase()).not.toContain('locked')
      expect(r.message.toLowerCase()).not.toMatch(/exist|found/)
      expect(r.message.toLowerCase()).toContain('unreadable')
      expect(r.message).not.toContain('secret-a')
      expect(r.message).not.toContain('secret-b')
    }
  })

  // --- Resolution 3: rules the brief enforces but never tests ---

  it('denies creating a vault with a passphrase shorter than 12 characters', async () => {
    const tooShort = await createVaultAction('eleven-char') // 11 characters
    expect(tooShort.ok).toBe(false)
    if (!tooShort.ok) expect(tooShort.message.toLowerCase()).toContain('12')
    expect(await prisma.vaultConfig.count()).toBe(0)
  })

  it('refuses to create a second vault', async () => {
    const first = await createVaultAction('right passphrase')
    expect(first.ok).toBe(true)
    const second = await createVaultAction('another passphrase')
    expect(second.ok).toBe(false)
    if (!second.ok) expect(second.message.toLowerCase()).toContain('already exists')
  })

  it('unlocks through the recovery key action', async () => {
    const created = await createVaultAction('right passphrase')
    await acknowledgeRecoveryKeyAction()
    expect(created.ok).toBe(true)
    if (!created.ok) return
    lockSession()
    const wrong = await unlockWithRecoveryAction('not a real recovery key')
    expect(wrong.ok).toBe(false)
    const r = await unlockWithRecoveryAction(created.recoveryKey)
    expect(r.ok).toBe(true)
    // Proves the recovery unlock actually unlocked the session, not just
    // that it returned ok: a reveal now succeeds.
    const add = await addCredentialAction({ label: 'a', username: 'u', secret: 'hunter2' })
    expect(add.ok).toBe(true)
  })

  it('lockAction actually locks the session: a reveal that worked before fails after', async () => {
    await createVaultAction('right passphrase')
    await acknowledgeRecoveryKeyAction()
    const add = await addCredentialAction({ label: 'a', username: 'u', secret: 'hunter2' })
    expect(add.ok).toBe(true)
    if (!add.ok) return
    const before = await revealAction(add.id)
    expect(before.ok).toBe(true)
    await lockAction()
    const after = await revealAction(add.id)
    expect(after.ok).toBe(false)
  })

  it('removeCredentialAction removes the credential', async () => {
    await createVaultAction('right passphrase')
    await acknowledgeRecoveryKeyAction()
    const add = await addCredentialAction({ label: 'a', username: 'u', secret: 'hunter2' })
    expect(add.ok).toBe(true)
    if (!add.ok) return
    const removed = await removeCredentialAction(add.id)
    expect(removed.ok).toBe(true)
    expect(await prisma.credential.count()).toBe(0)
  })

  // --- Task 10 / finding C1: removeCredentialAction is now reachable from
  // the UI, which makes it a destructive, irreversible operation on an
  // unauthenticated server action. It refuses while locked. ---

  it('removeCredentialAction REFUSES to delete while the vault is locked, and the credential survives', async () => {
    await createVaultAction('right passphrase')
    await acknowledgeRecoveryKeyAction()
    const add = await addCredentialAction({ label: 'a', username: 'u', secret: 'hunter2' })
    expect(add.ok).toBe(true)
    if (!add.ok) return
    lockSession()
    const r = await removeCredentialAction(add.id)
    expect(r.ok).toBe(false)
    // Distinct from "no longer exists": it very much does still exist, and
    // saying otherwise would be a lie the operator could act on.
    if (!r.ok) {
      expect(r.message.toLowerCase()).toContain('locked')
      expect(r.message.toLowerCase()).not.toMatch(/no longer exists/)
    }
    expect(await prisma.credential.count()).toBe(1)
  })

  // --- Task 10 / finding C1: changePassphrase() has existed in vault.ts,
  // tested, since the feature was built, with no action and no UI in front of
  // it -- so the passphrase could never be changed at all. ---

  describe('changePassphraseAction (C1)', () => {
    it('changes the passphrase: the old one stops working and the new one starts', async () => {
      await createVaultAction('right passphrase')
      const r = await changePassphraseAction('right passphrase', 'a different passphrase')
      expect(r.ok).toBe(true)

      lockSession()
      expect((await unlockAction('right passphrase')).ok).toBe(false)
      lockSession()
      expect((await unlockAction('a different passphrase')).ok).toBe(true)
    })

    it('leaves every stored credential readable under the new passphrase', async () => {
      await createVaultAction('right passphrase')
      await acknowledgeRecoveryKeyAction()
      const add = await addCredentialAction({ label: 'a', username: 'u', secret: 'hunter2' })
      expect(add.ok).toBe(true)
      if (!add.ok) return
      expect((await changePassphraseAction('right passphrase', 'a different passphrase')).ok).toBe(true)
      lockSession()
      await unlockAction('a different passphrase')
      const revealed = await revealAction(add.id)
      expect(revealed.ok).toBe(true)
      if (revealed.ok) expect(revealed.secret).toBe('hunter2')
    })

    it('leaves the RECOVERY key working, which is what the UI promises the operator', async () => {
      const created = await createVaultAction('right passphrase')
      expect(created.ok).toBe(true)
      if (!created.ok) return
      expect((await changePassphraseAction('right passphrase', 'a different passphrase')).ok).toBe(true)
      lockSession()
      expect((await unlockWithRecoveryAction(created.recoveryKey)).ok).toBe(true)
    })

    it('REFUSES a wrong current passphrase and leaves the old one working', async () => {
      await createVaultAction('right passphrase')
      const r = await changePassphraseAction('not the passphrase', 'a different passphrase')
      expect(r.ok).toBe(false)
      if (!r.ok) {
        expect(r.message.toLowerCase()).toContain('unchanged')
        expect(r.message).not.toContain('not the passphrase')
        expect(r.message).not.toContain('a different passphrase')
      }
      lockSession()
      expect((await unlockAction('right passphrase')).ok).toBe(true)
    })

    it('REFUSES a new passphrase shorter than 12 characters, matching vault creation', async () => {
      await createVaultAction('right passphrase')
      const r = await changePassphraseAction('right passphrase', 'eleven-char')
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.message.toLowerCase()).toContain('12')
      lockSession()
      expect((await unlockAction('right passphrase')).ok).toBe(true)
    })

    it('reports no vault distinctly, rather than as a wrong passphrase', async () => {
      const r = await changePassphraseAction('right passphrase', 'a different passphrase')
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.message.toLowerCase()).not.toContain('unchanged')
    })

    it('reports a database problem, not a thrown rejection, when isInitialised() itself rejects', async () => {
      const spy = vi.spyOn(prisma.vaultConfig, 'findUnique').mockRejectedValueOnce(new Error('connection refused'))
      try {
        const r = await changePassphraseAction('right passphrase', 'a different passphrase')
        expect(r.ok).toBe(false)
        if (!r.ok) {
          expect(r.message.toLowerCase()).toMatch(/database|reach|connect/)
          expect(r.message).not.toContain('connection refused')
        }
      } finally {
        spy.mockRestore()
      }
    })

    it('reports a database problem, not "corrupt configuration", when the change itself hits a real Prisma connectivity error', async () => {
      await createVaultAction('right passphrase')
      const spy = vi.spyOn(prisma.vaultConfig, 'update').mockRejectedValueOnce(
        new Prisma.PrismaClientKnownRequestError("Can't reach database server", { code: 'P1001', clientVersion: 'test' }),
      )
      try {
        const r = await changePassphraseAction('right passphrase', 'a different passphrase')
        expect(r.ok).toBe(false)
        if (!r.ok) {
          expect(r.message.toLowerCase()).toMatch(/database|reach|connect/)
          expect(r.message.toLowerCase()).not.toContain('corrupt')
        }
      } finally {
        spy.mockRestore()
      }
    })

    it('reports a neutral failure, naming no cause, for an error it cannot positively identify', async () => {
      await createVaultAction('right passphrase')
      const spy = vi.spyOn(prisma.vaultConfig, 'update').mockRejectedValueOnce(
        new Prisma.PrismaClientKnownRequestError('unrelated failure', { code: 'P2025', clientVersion: 'test' }),
      )
      try {
        const r = await changePassphraseAction('right passphrase', 'a different passphrase')
        expect(r.ok).toBe(false)
        if (!r.ok) {
          expect(r.message.toLowerCase()).not.toContain('corrupt')
          expect(r.message.toLowerCase()).not.toMatch(/database|reach|connect/)
          expect(r.message).not.toContain('unrelated failure')
        }
      } finally {
        spy.mockRestore()
      }
    })

    it('reports a corrupt configuration, not something to retry, when the stored KDF params are unusable', async () => {
      await createVaultAction('right passphrase')
      await prisma.vaultConfig.updateMany({ data: { kdfParams: '{}' } })
      const r = await changePassphraseAction('right passphrase', 'a different passphrase')
      expect(r.ok).toBe(false)
      if (!r.ok) {
        expect(r.message.toLowerCase()).toMatch(/corrupt|unreadable/)
        expect(r.message.toLowerCase()).toContain('recovery key')
      }
    })

    it('never throws to the client, whatever the failure', async () => {
      // Every failing shape above returns a plain object; this asserts the
      // property directly on the one that reaches deepest into vault.ts.
      await createVaultAction('right passphrase')
      await prisma.vaultConfig.updateMany({ data: { kdfParams: 'not-json-at-all' } })
      await expect(changePassphraseAction('right passphrase', 'a different passphrase')).resolves.toMatchObject({
        ok: false,
      })
    })
  })

  // --- Task 10 round 2: the recovery key is displayed once and persisted
  // nowhere, so an unacknowledged vault looked identical to a healthy one and
  // stayed that way until a forgotten passphrase made every credential
  // unrecoverable. ---

  describe('acknowledgeRecoveryKeyAction', () => {
    it('records the acknowledgement', async () => {
      await createVaultAction('right passphrase')
      expect((await acknowledgeRecoveryKeyAction()).ok).toBe(true)
      const row = await prisma.vaultConfig.findFirstOrThrow()
      expect(row.recoveryKeyAcknowledgedAt).not.toBeNull()
    })

    it('reports a failure, not a silent success, when there is no vault to acknowledge', async () => {
      const r = await acknowledgeRecoveryKeyAction()
      expect(r.ok).toBe(false)
    })

    // The panel only clears the key from the screen on ok. If a failed write
    // ever reported success, the key would be dismissed and the vault left
    // marked unacknowledged for good -- the exact silent absence this whole
    // mechanism exists to prevent.
    it('reports a database problem, not a success, when the write itself fails', async () => {
      await createVaultAction('right passphrase')
      const spy = vi.spyOn(prisma.vaultConfig, 'updateMany').mockRejectedValueOnce(
        new Prisma.PrismaClientKnownRequestError("Can't reach database server", { code: 'P1001', clientVersion: 'test' }),
      )
      try {
        const r = await acknowledgeRecoveryKeyAction()
        expect(r.ok).toBe(false)
        if (!r.ok) expect(r.message.toLowerCase()).toMatch(/database|reach|connect/)
      } finally {
        spy.mockRestore()
      }
      expect((await prisma.vaultConfig.findFirstOrThrow()).recoveryKeyAcknowledgedAt).toBeNull()
    })

    it('never throws to the client, and never echoes the caught error', async () => {
      await createVaultAction('right passphrase')
      const spy = vi
        .spyOn(prisma.vaultConfig, 'updateMany')
        .mockRejectedValueOnce(new Error('connection refused'))
      try {
        const r = await acknowledgeRecoveryKeyAction()
        expect(r.ok).toBe(false)
        if (!r.ok) expect(r.message).not.toContain('connection refused')
      } finally {
        spy.mockRestore()
      }
    })
  })

  describe('recreateVaultAction', () => {
    it('issues a new, working recovery key and leaves the vault unlocked', async () => {
      const first = await createVaultAction('right passphrase')
      expect(first.ok).toBe(true)
      if (!first.ok) return
      const r = await recreateVaultAction('a different passphrase')
      expect(r.ok).toBe(true)
      if (!r.ok) return
      expect(r.recoveryKey).not.toBe(first.recoveryKey)
      expect(r.sessionRemainingMs).toBeGreaterThan(DEFAULT_TTL_MS - 5000)

      lockSession()
      expect((await unlockWithRecoveryAction(r.recoveryKey)).ok).toBe(true)
      lockSession()
      expect((await unlockWithRecoveryAction(first.recoveryKey)).ok).toBe(false)
    })

    it('leaves the new vault unacknowledged -- its key has been shown and not yet stored', async () => {
      await createVaultAction('right passphrase')
      await acknowledgeRecoveryKeyAction()
      expect((await recreateVaultAction('a different passphrase')).ok).toBe(true)
      expect((await prisma.vaultConfig.findFirstOrThrow()).recoveryKeyAcknowledgedAt).toBeNull()
    })

    // THE denial the coordinator asked to be proven at this layer: the
    // refusal must come from the CODE, not from the UI having hidden the
    // control. Nothing here touches the UI -- this calls the server action
    // directly, exactly as a network caller could.
    it('REFUSES to recreate a vault that holds a credential, and destroys nothing', async () => {
      await createVaultAction('right passphrase')
      await acknowledgeRecoveryKeyAction()
      const add = await addCredentialAction({ label: 'a', username: 'u', secret: 'hunter2' })
      expect(add.ok).toBe(true)
      if (!add.ok) return

      const r = await recreateVaultAction('a different passphrase')
      expect(r.ok).toBe(false)
      if (!r.ok) {
        expect(r.message.toLowerCase()).toContain('would destroy them')
        // Not a "try again" failure: retrying will never help, and must not
        // read as though it might.
        expect(r.message.toLowerCase()).not.toContain('try again')
      }

      // And the credential is not merely still present -- it is still
      // READABLE, which is the property recreation would have destroyed.
      expect(await prisma.credential.count()).toBe(1)
      const revealed = await revealAction(add.id)
      expect(revealed.ok).toBe(true)
      if (revealed.ok) expect(revealed.secret).toBe('hunter2')
    })

    it('REFUSES a passphrase shorter than 12 characters, and changes nothing', async () => {
      const first = await createVaultAction('right passphrase')
      expect(first.ok).toBe(true)
      if (!first.ok) return
      const r = await recreateVaultAction('eleven-char')
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.message.toLowerCase()).toContain('12')
      lockSession()
      expect((await unlockWithRecoveryAction(first.recoveryKey)).ok).toBe(true)
    })

    it('reports a database problem distinctly from the not-empty refusal', async () => {
      await createVaultAction('right passphrase')
      // Injected at `$transaction`, not at a model method: every destructive
      // step lives INSIDE the interactive transaction and runs against its
      // own `tx` client, which a spy on `prisma.vaultConfig` never sees. A
      // connectivity failure opening or committing the transaction rejects
      // here, which is the real shape of this failure.
      const spy = vi.spyOn(prisma, '$transaction').mockRejectedValueOnce(
        new Prisma.PrismaClientKnownRequestError("Can't reach database server", { code: 'P1001', clientVersion: 'test' }),
      )
      try {
        const r = await recreateVaultAction('a different passphrase')
        expect(r.ok).toBe(false)
        if (!r.ok) {
          expect(r.message.toLowerCase()).toMatch(/database|reach|connect/)
          expect(r.message.toLowerCase()).not.toContain('would destroy them')
        }
      } finally {
        spy.mockRestore()
      }
    })

    it('reports a neutral failure, naming no cause, for an error it cannot positively identify', async () => {
      await createVaultAction('right passphrase')
      const spy = vi.spyOn(prisma, '$transaction').mockRejectedValueOnce(
        new Prisma.PrismaClientKnownRequestError('unrelated failure', { code: 'P2025', clientVersion: 'test' }),
      )
      try {
        const r = await recreateVaultAction('a different passphrase')
        expect(r.ok).toBe(false)
        if (!r.ok) {
          expect(r.message.toLowerCase()).not.toContain('would destroy them')
          expect(r.message.toLowerCase()).not.toMatch(/database|reach|connect/)
          expect(r.message).not.toContain('unrelated failure')
        }
      } finally {
        spy.mockRestore()
      }
    })

    // --- Round 3: emptiness alone was not authorization. Full rule: zero
    // credentials AND (unacknowledged OR unlocked). All three cases at the
    // ACTION layer, since that is the callable HTTP endpoint -- nothing here
    // renders a component, so nothing here can be satisfied by a hidden
    // button. ---

    it('ALLOWS recreation while the recovery key was never acknowledged, even with the vault locked', async () => {
      await createVaultAction('right passphrase')
      lockSession()
      expect((await recreateVaultAction('a different passphrase')).ok).toBe(true)
    })

    it('ALLOWS recreation when the key is acknowledged but the session is unlocked', async () => {
      await createVaultAction('right passphrase')
      expect((await acknowledgeRecoveryKeyAction()).ok).toBe(true)
      expect((await recreateVaultAction('a different passphrase')).ok).toBe(true)
    })

    it('REFUSES when the key is acknowledged and the vault is locked, and the printed key still works', async () => {
      const created = await createVaultAction('right passphrase')
      expect(created.ok).toBe(true)
      if (!created.ok) return
      await acknowledgeRecoveryKeyAction()
      lockSession()

      const r = await recreateVaultAction('a different passphrase')
      expect(r.ok).toBe(false)
      if (!r.ok) {
        // Names the remedy: this is the one refusal of the three the
        // operator can clear themselves.
        expect(r.message.toLowerCase()).toContain('unlock the vault first')
        // ...and is not confused with the not-empty refusal, which has no
        // way around it at all.
        expect(r.message.toLowerCase()).not.toContain('holds stored credentials')
      }

      // The whole point of the guard: the key in the drawer is still good.
      expect((await unlockWithRecoveryAction(created.recoveryKey)).ok).toBe(true)
    })

    // REWRITTEN because the first version could not fail. It asserted that
    // no recovery key appeared in the message -- but every branch of
    // `recreateVaultAction` returns a module constant, so the assertion only
    // ever inspected hardcoded text it could see for itself. The realistic
    // mutation, `failed(VAULT_NOT_EMPTY_MESSAGE + ' ' + (err as Error).message)`,
    // survived the entire suite: the appended text is "vault holds
    // credentials", which contains no key and no key-shaped substring.
    //
    // These two check the property that was actually claimed -- that a caught
    // error's OWN text never reaches the caller -- against text the caught
    // errors really carry.
    it('never lets the internal refusal text out of the not-empty branch', async () => {
      await createVaultAction('right passphrase')
      await acknowledgeRecoveryKeyAction()
      await addCredentialAction({ label: 'a', username: 'u', secret: 'hunter2' })
      const r = await recreateVaultAction('a different passphrase')
      expect(r.ok).toBe(false)
      // The message `VaultNotEmptyError` is genuinely constructed with. If
      // any branch appends the caught error, this is what appears.
      if (!r.ok) expect(r.message).not.toContain('vault holds credentials')
    })

    it('never lets a caught error carry its own text to the caller', async () => {
      await createVaultAction('right passphrase')
      // A marker the action cannot have invented, on the path that catches
      // an error it cannot classify -- the branch most likely to be "helpful"
      // by including the cause.
      const spy = vi
        .spyOn(prisma, '$transaction')
        .mockRejectedValueOnce(new Error('wrapped-vault-key-fragment-QUJDRA'))
      try {
        const r = await recreateVaultAction('a different passphrase')
        expect(r.ok).toBe(false)
        if (!r.ok) expect(r.message).not.toContain('wrapped-vault-key-fragment-QUJDRA')
      } finally {
        spy.mockRestore()
      }
    })
  })

  // --- Fix round 1: unlockAction / unlockWithRecoveryAction / createVaultAction
  // must never throw, and a corrupt-or-missing VaultConfig must not be
  // reported as "wrong passphrase" (design spec section 9). ---

  it('unlockAction against a corrupt VaultConfig returns a plain failure, not a thrown error, and does not say "wrong passphrase"', async () => {
    const created = await createVaultAction('right passphrase')
    expect(created.ok).toBe(true)
    lockSession()
    // Same reproduction as the coordinator's probe: a VaultConfig row exists,
    // but its kdfParams column is not valid JSON. unlockWithPassphrase()
    // JSON.parses this column directly and previously let that SyntaxError
    // escape uncaught.
    await prisma.vaultConfig.updateMany({ data: { kdfParams: 'not-json-at-all' } })
    const r = await unlockAction('right passphrase')
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.message.toLowerCase()).not.toContain('wrong')
      expect(r.message.toLowerCase()).toMatch(/corrupt|unreadable/)
      // The caught SyntaxError's own text can carry a fragment of the
      // corrupt value — must never reach the caller.
      expect(r.message).not.toContain('not-json-at-all')
    }
  })

  // --- Task 10 / finding I5: a kdfParams column that is VALID JSON but not
  // usable KDF parameters is just as permanent as one that will not parse,
  // and must report the same fact. Before the fix, validateParams threw a
  // plain Error, classifyVaultConfigFailure could not identify it, and all
  // three of these reported UNLOCK_FAILED_MESSAGE -- "try again in a
  // moment" -- for damage that no amount of waiting repairs, never steering
  // the operator to the recovery key that is the only way back in. ---

  const permanentlyUnusableParams: ReadonlyArray<readonly [string, string]> = [
    ['an empty object', '{}'],
    ['a literal null', 'null'],
    // The worst of the three: structurally valid, so nothing looks broken,
    // but the work factor is below kdf.ts's floor -- the exact
    // tampering/downgrade case those floors were added to catch.
    ['a downgraded work factor', JSON.stringify({ N: 1024, r: 8, p: 1, saltB64: Buffer.alloc(16).toString('base64') })],
  ]

  for (const [description, stored] of permanentlyUnusableParams) {
    it(`unlockAction reports ${description} in kdfParams as corrupt configuration, not as something to retry`, async () => {
      const created = await createVaultAction('right passphrase')
      expect(created.ok).toBe(true)
      lockSession()
      await prisma.vaultConfig.updateMany({ data: { kdfParams: stored } })
      const r = await unlockAction('right passphrase')
      expect(r.ok).toBe(false)
      if (!r.ok) {
        expect(r.message.toLowerCase()).toMatch(/corrupt|unreadable/)
        // The specific misreport this fix removes: transient-sounding advice
        // for permanent damage.
        expect(r.message.toLowerCase()).not.toContain('try again in a moment')
        // ...and it must point at the one route that still works.
        expect(r.message.toLowerCase()).toContain('recovery key')
        // The rejected value must never come back out in the message.
        expect(r.message).not.toContain(stored)
      }
    })
  }

  it('unlockWithRecoveryAction is unaffected by the same corrupt kdfParams, and never throws', async () => {
    const created = await createVaultAction('right passphrase')
    expect(created.ok).toBe(true)
    if (!created.ok) return
    lockSession()
    // unlockWithRecoveryKey never reads kdfParams, so this corruption does
    // not break it — the real recovery key still works. This proves the
    // action-level guard added for consistency does not change correct
    // behaviour, and that nothing throws along the way.
    await prisma.vaultConfig.updateMany({ data: { kdfParams: 'not-json-at-all' } })
    const r = await unlockWithRecoveryAction(created.recoveryKey)
    expect(r.ok).toBe(true)
  })

  it('unlockAction when no vault has ever been created returns a plain failure distinct from "wrong passphrase"', async () => {
    const r = await unlockAction('whatever passphrase')
    expect(r.ok).toBe(false)
    // The old wording ("That passphrase did not unlock the vault.") happens
    // to contain the substring "vault" and even "not...vault", so a loose
    // regex on those words alone would pass against either message — the
    // one thing that actually distinguishes them is that the old wording
    // talks about a passphrase being wrong at all, and the new one never
    // mentions "passphrase".
    if (!r.ok) expect(r.message.toLowerCase()).not.toContain('passphrase')
  })

  it('createVaultAction returns a plain failure, not a thrown error, when the underlying create fails on a real singleton conflict', async () => {
    // Simulates the TOCTOU window between this action's own isInitialised()
    // check and createVault()'s write: two concurrent calls can both pass
    // the check, and the database's singleton constraint then rejects the
    // second insert. Reproduced deterministically here with the REAL Prisma
    // error type and code (P2002 — confirmed empirically against this
    // installed client to be what a genuine VaultConfig.id collision raises;
    // see task-7-report.md "Fix round 4"), not a plain Error, so this proves
    // the type/code check itself works rather than merely that some catch
    // fired.
    const spy = vi.spyOn(prisma.vaultConfig, 'create').mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed on the fields: (`id`)', {
        code: 'P2002',
        clientVersion: 'test',
      }),
    )
    try {
      const r = await createVaultAction('right passphrase')
      expect(r.ok).toBe(false)
      if (!r.ok) {
        expect(r.message.toLowerCase()).toContain('already exists')
        // The rejected insert's own message must not leak through.
        expect(r.message).not.toContain('Unique constraint')
      }
    } finally {
      spy.mockRestore()
    }
  })

  it('createVaultAction reports a database problem, not "already exists", when createVault() itself hits a real Prisma connectivity error', async () => {
    // Distinct from the round-2 test above that injects the connectivity
    // failure into isInitialised() itself — this one gets PAST that check
    // (isInitialised() must resolve false first) and fails inside
    // createVault()'s own write instead, which is the exact scenario this
    // round's finding described: a transient database hiccup during the
    // FIRST-ever setup, previously misreported as "a vault already exists".
    const spy = vi.spyOn(prisma.vaultConfig, 'create').mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError("Can't reach database server", { code: 'P1001', clientVersion: 'test' }),
    )
    try {
      const r = await createVaultAction('right passphrase')
      expect(r.ok).toBe(false)
      if (!r.ok) {
        expect(r.message.toLowerCase()).toMatch(/database|reach|connect/)
        expect(r.message.toLowerCase()).not.toContain('already exists')
      }
    } finally {
      spy.mockRestore()
    }
    expect(await prisma.vaultConfig.count()).toBe(0)
  })

  it('createVaultAction reports a neutral failure, not "already exists" or a database claim, for an error it cannot positively identify', async () => {
    // A REAL PrismaClientKnownRequestError, but with a code that is neither
    // the singleton-conflict code (P2002) nor a recognised connectivity code
    // — this proves the classifier checks the SPECIFIC code in both
    // directions, not just "any PrismaClientKnownRequestError is a conflict"
    // or "any PrismaClientKnownRequestError is connectivity".
    const spy = vi.spyOn(prisma.vaultConfig, 'create').mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('unrelated failure', { code: 'P2025', clientVersion: 'test' }),
    )
    try {
      const r = await createVaultAction('right passphrase')
      expect(r.ok).toBe(false)
      if (!r.ok) {
        expect(r.message.toLowerCase()).not.toContain('already exists')
        expect(r.message.toLowerCase()).not.toMatch(/database|reach|connect/)
        expect(r.message).not.toContain('unrelated failure')
      }
    } finally {
      spy.mockRestore()
    }
  })

  // --- Fix round 2: isInitialised() itself must not be able to throw past
  // the action boundary, and it must be reported as its own fact (a
  // database problem), never folded into "no vault exists" or "wrong
  // passphrase" — see task-7-report.md "Fix round 2". ---

  it('createVaultAction reports a database problem, not a thrown rejection, when isInitialised() itself rejects', async () => {
    const spy = vi.spyOn(prisma.vaultConfig, 'findUnique').mockRejectedValueOnce(new Error('connection refused'))
    try {
      const r = await createVaultAction('right passphrase')
      expect(r.ok).toBe(false)
      if (!r.ok) {
        expect(r.message.toLowerCase()).toMatch(/database|reach|connect/)
        // Must not read as "no vault exists" (which would invite creating a
        // second one once the database comes back) or leak the raw error.
        expect(r.message.toLowerCase()).not.toContain('already exists')
        expect(r.message).not.toContain('connection refused')
      }
    } finally {
      spy.mockRestore()
    }
    expect(await prisma.vaultConfig.count()).toBe(0)
  })

  it('unlockAction reports a database problem, not a thrown rejection, when isInitialised() itself rejects', async () => {
    const spy = vi.spyOn(prisma.vaultConfig, 'findUnique').mockRejectedValueOnce(new Error('connection refused'))
    try {
      const r = await unlockAction('right passphrase')
      expect(r.ok).toBe(false)
      if (!r.ok) {
        expect(r.message.toLowerCase()).toMatch(/database|reach|connect/)
        // Must not read as "no vault has been created" or "wrong passphrase".
        expect(r.message.toLowerCase()).not.toContain('passphrase')
        expect(r.message).not.toContain('connection refused')
      }
    } finally {
      spy.mockRestore()
    }
  })

  it('unlockWithRecoveryAction reports a database problem, not a thrown rejection, when isInitialised() itself rejects', async () => {
    const spy = vi.spyOn(prisma.vaultConfig, 'findUnique').mockRejectedValueOnce(new Error('connection refused'))
    try {
      const r = await unlockWithRecoveryAction('irrelevant recovery key')
      expect(r.ok).toBe(false)
      if (!r.ok) {
        expect(r.message.toLowerCase()).toMatch(/database|reach|connect/)
        expect(r.message).not.toContain('connection refused')
      }
    } finally {
      spy.mockRestore()
    }
  })

  // --- Fix round 2: addCredentialAction's locked-vault branch had no test ---

  it('addCredentialAction reports a locked vault distinctly from a generic save failure', async () => {
    await createVaultAction('right passphrase')
    await acknowledgeRecoveryKeyAction()
    lockSession()
    const r = await addCredentialAction({ label: 'a', username: 'u', secret: 'hunter2' })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.message.toLowerCase()).toContain('locked')
      expect(r.message).not.toContain('hunter2')
    }
  })

  // --- Task 10 round 4, finding 3 ---

  it('addCredentialAction REFUSES to store into a vault whose recovery key was never acknowledged', async () => {
    await createVaultAction('right passphrase')
    // Deliberately NOT acknowledged: the state an operator reaches by
    // creating the vault and being called away before clicking through the
    // one-time gate.
    const r = await addCredentialAction({ label: 'a', username: 'u', secret: 'hunter2' })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.message.toLowerCase()).toContain('recovery key')
      // Not a locked vault: unlocking would not help, and saying so would
      // send the operator to the wrong control.
      expect(r.message.toLowerCase()).not.toContain('the vault is locked')
      expect(r.message).not.toContain('hunter2')
    }
    expect(await prisma.credential.count()).toBe(0)
  })

  it('addCredentialAction accepts the credential once the acknowledgement exists', async () => {
    await createVaultAction('right passphrase')
    expect((await addCredentialAction({ label: 'a', username: 'u', secret: 'hunter2' })).ok).toBe(false)
    await acknowledgeRecoveryKeyAction()
    const r = await addCredentialAction({ label: 'a', username: 'u', secret: 'hunter2' })
    expect(r.ok).toBe(true)
  })

  // --- Fix round 2: removeCredentialAction's catch was untested; "already
  // gone" (Prisma P2025) and any other delete failure are deliberately
  // distinguished rather than sharing a message, matching how the reveal
  // and add paths distinguish their own failure facts. ---

  it('removeCredentialAction reports an already-gone credential distinctly from a generic delete failure', async () => {
    await createVaultAction('right passphrase')
    const r = await removeCredentialAction(randomUUID())
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.message.toLowerCase()).toMatch(/no longer exists|already/)
  })

  it('removeCredentialAction reports a generic delete failure distinctly from an already-gone credential', async () => {
    await createVaultAction('right passphrase')
    await acknowledgeRecoveryKeyAction()
    const add = await addCredentialAction({ label: 'a', username: 'u', secret: 'hunter2' })
    expect(add.ok).toBe(true)
    if (!add.ok) return
    const spy = vi.spyOn(prisma.credential, 'delete').mockRejectedValueOnce(new Error('connection lost'))
    try {
      const r = await removeCredentialAction(add.id)
      expect(r.ok).toBe(false)
      if (!r.ok) {
        expect(r.message.toLowerCase()).not.toMatch(/no longer exists/)
        expect(r.message).not.toContain('connection lost')
      }
    } finally {
      spy.mockRestore()
    }
  })

  // --- Fix round 3: unlockAction/unlockWithRecoveryAction's own catch must
  // not attribute EVERY failure to corrupt configuration — only a positively
  // identified parse failure earns that message. A recognised database
  // connectivity error gets DATABASE_UNAVAILABLE_MESSAGE, and anything else
  // gets a neutral message that names no cause. See task-7-report.md
  // "Fix round 3". ---

  it('unlockAction reports a database problem, not "corrupt configuration", when unlockWithPassphrase itself hits a real Prisma connectivity error', async () => {
    const created = await createVaultAction('right passphrase')
    expect(created.ok).toBe(true)
    lockSession()
    const row = await prisma.vaultConfig.findFirstOrThrow()
    // First findUnique call is this action's own isInitialised() guard (must
    // succeed, so execution reaches unlockWithPassphrase); the second is
    // unlockWithPassphrase's OWN internal config() read, which is where the
    // connectivity failure is injected. Using the real Prisma error type
    // (not a plain Error) is what proves the type-based classification
    // itself works, rather than merely that some catch fired.
    const spy = vi.spyOn(prisma.vaultConfig, 'findUnique')
      .mockResolvedValueOnce(row)
      .mockRejectedValueOnce(
        new Prisma.PrismaClientKnownRequestError("Can't reach database server", { code: 'P1001', clientVersion: 'test' }),
      )
    try {
      const r = await unlockAction('right passphrase')
      expect(r.ok).toBe(false)
      if (!r.ok) {
        expect(r.message.toLowerCase()).toMatch(/database|reach|connect/)
        expect(r.message.toLowerCase()).not.toContain('corrupt')
        expect(r.message.toLowerCase()).not.toContain('passphrase')
      }
    } finally {
      spy.mockRestore()
    }
  })

  it('unlockAction reports a neutral failure, not "corrupt configuration" or a database claim, for an error it cannot positively identify', async () => {
    const created = await createVaultAction('right passphrase')
    expect(created.ok).toBe(true)
    lockSession()
    const row = await prisma.vaultConfig.findFirstOrThrow()
    // A REAL PrismaClientKnownRequestError, but with a code that is not one
    // of the recognised connectivity codes (P2025 is "record not found",
    // unrelated here) — this is what proves the classifier checks the
    // SPECIFIC code, not just "any PrismaClientKnownRequestError".
    const spy = vi.spyOn(prisma.vaultConfig, 'findUnique')
      .mockResolvedValueOnce(row)
      .mockRejectedValueOnce(
        new Prisma.PrismaClientKnownRequestError('unrelated failure', { code: 'P2025', clientVersion: 'test' }),
      )
    try {
      const r = await unlockAction('right passphrase')
      expect(r.ok).toBe(false)
      if (!r.ok) {
        expect(r.message.toLowerCase()).not.toContain('corrupt')
        expect(r.message.toLowerCase()).not.toMatch(/database|reach|connect/)
        expect(r.message).not.toContain('unrelated failure')
      }
    } finally {
      spy.mockRestore()
    }
  })

  it('unlockWithRecoveryAction reports a database problem, not "corrupt configuration", when unlockWithRecoveryKey itself hits a real Prisma connectivity error', async () => {
    const created = await createVaultAction('right passphrase')
    expect(created.ok).toBe(true)
    if (!created.ok) return
    lockSession()
    const row = await prisma.vaultConfig.findFirstOrThrow()
    const spy = vi.spyOn(prisma.vaultConfig, 'findUnique')
      .mockResolvedValueOnce(row)
      .mockRejectedValueOnce(
        new Prisma.PrismaClientKnownRequestError('server has closed the connection', { code: 'P1017', clientVersion: 'test' }),
      )
    try {
      const r = await unlockWithRecoveryAction(created.recoveryKey)
      expect(r.ok).toBe(false)
      if (!r.ok) {
        expect(r.message.toLowerCase()).toMatch(/database|reach|connect/)
        expect(r.message.toLowerCase()).not.toContain('corrupt')
      }
    } finally {
      spy.mockRestore()
    }
  })

  it('unlockWithRecoveryAction reports a neutral failure for an error it cannot positively identify', async () => {
    const created = await createVaultAction('right passphrase')
    expect(created.ok).toBe(true)
    if (!created.ok) return
    lockSession()
    const row = await prisma.vaultConfig.findFirstOrThrow()
    const spy = vi.spyOn(prisma.vaultConfig, 'findUnique')
      .mockResolvedValueOnce(row)
      .mockRejectedValueOnce(
        new Prisma.PrismaClientKnownRequestError('unrelated failure', { code: 'P2025', clientVersion: 'test' }),
      )
    try {
      const r = await unlockWithRecoveryAction(created.recoveryKey)
      expect(r.ok).toBe(false)
      if (!r.ok) {
        expect(r.message.toLowerCase()).not.toContain('corrupt')
        expect(r.message.toLowerCase()).not.toMatch(/database|reach|connect/)
        expect(r.message).not.toContain('unrelated failure')
      }
    } finally {
      spy.mockRestore()
    }
  })

  // --- Fix round 5: revealAction must not turn a database outage into a
  // tampering claim. revealCredential() touches the database at three
  // separate points (the initial lookup, the locked-path audit write, and
  // the decrypt-failure audit write) plus a fourth (the success audit
  // write); a connectivity failure at ANY of them must be reported as a
  // database problem or (where a fact was already established before that
  // point) as that established fact — never as "may indicate the stored
  // data was altered or corrupted", which is reserved for an ACTUAL
  // CredentialDecryptError from open(). See task-7-report.md "Fix round 5". ---

  it('revealAction reports a database problem, not tampering, when the initial credential lookup itself hits a real Prisma connectivity error', async () => {
    await createVaultAction('right passphrase')
    await acknowledgeRecoveryKeyAction()
    const add = await addCredentialAction({ label: 'a', username: 'u', secret: 'hunter2' })
    expect(add.ok).toBe(true)
    if (!add.ok) return
    const spy = vi.spyOn(prisma.credential, 'findUnique').mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError("Can't reach database server", { code: 'P1001', clientVersion: 'test' }),
    )
    try {
      const r = await revealAction(add.id)
      expect(r.ok).toBe(false)
      if (!r.ok) {
        expect(r.message.toLowerCase()).toMatch(/database|reach|connect/)
        expect(r.message.toLowerCase()).not.toMatch(/corrupt|altered|unreadable/)
      }
    } finally {
      spy.mockRestore()
    }
  })

  it('revealAction still reports the vault as locked when the reveal-denied audit write itself hits a real Prisma connectivity error', async () => {
    await createVaultAction('right passphrase')
    await acknowledgeRecoveryKeyAction()
    const add = await addCredentialAction({ label: 'a', username: 'u', secret: 'hunter2' })
    expect(add.ok).toBe(true)
    if (!add.ok) return
    lockSession()
    // credentials.ts swallows a failure of THIS specific audit write and
    // still reports the already-established fact ("the vault is locked")
    // rather than letting an unrelated database error replace or hide it.
    const spy = vi.spyOn(prisma.credentialAccess, 'create').mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError("Can't reach database server", { code: 'P1001', clientVersion: 'test' }),
    )
    try {
      const r = await revealAction(add.id)
      expect(r.ok).toBe(false)
      if (!r.ok) {
        expect(r.message.toLowerCase()).toContain('locked')
        expect(r.message.toLowerCase()).not.toMatch(/database|reach|connect/)
      }
    } finally {
      spy.mockRestore()
    }
  })

  it('revealAction still reports a tampered credential as unreadable when the reveal-failed audit write itself hits a real Prisma connectivity error', async () => {
    await createVaultAction('right passphrase')
    await acknowledgeRecoveryKeyAction()
    const a = await addCredentialAction({ label: 'a', username: 'u', secret: 'secret-a' })
    const b = await addCredentialAction({ label: 'b', username: 'u', secret: 'secret-b' })
    expect(a.ok).toBe(true)
    expect(b.ok).toBe(true)
    if (!a.ok || !b.ok) return
    const rowA = await prisma.credential.findUniqueOrThrow({ where: { id: a.id } })
    await prisma.credential.update({ where: { id: b.id }, data: { secretSealed: rowA.secretSealed } })
    // A GENUINE decrypt failure (moved ciphertext, AAD mismatch) is set up
    // above; the audit write that records it is then ALSO made to fail with
    // a real connectivity error. The already-established fact (open() just
    // failed) must survive that — this is the same swallow verified above,
    // but on the path where masking it would hide a real security event
    // rather than a merely inconvenient one.
    const spy = vi.spyOn(prisma.credentialAccess, 'create').mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError("Can't reach database server", { code: 'P1001', clientVersion: 'test' }),
    )
    try {
      const r = await revealAction(b.id)
      expect(r.ok).toBe(false)
      if (!r.ok) {
        expect(r.message.toLowerCase()).toContain('unreadable')
        expect(r.message.toLowerCase()).not.toMatch(/database|reach|connect/)
        expect(r.message).not.toContain('secret-a')
        expect(r.message).not.toContain('secret-b')
      }
    } finally {
      spy.mockRestore()
    }
  })

  it('revealAction reports a database problem, not tampering, when the final success audit write hits a real Prisma connectivity error despite a genuinely successful decrypt', async () => {
    await createVaultAction('right passphrase')
    await acknowledgeRecoveryKeyAction()
    const add = await addCredentialAction({ label: 'a', username: 'u', secret: 'hunter2' })
    expect(add.ok).toBe(true)
    if (!add.ok) return
    // This is the exact case the finding described: the ciphertext is fine,
    // open() would succeed, and the ONLY thing that fails is the final
    // audit write recording the success -- yet the old code would have
    // reported this as possible tampering, since the error reaching
    // revealAction's catch was neither VaultLockedError nor
    // CredentialNotFoundError.
    const spy = vi.spyOn(prisma.credentialAccess, 'create').mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('server has closed the connection', { code: 'P1017', clientVersion: 'test' }),
    )
    try {
      const r = await revealAction(add.id)
      expect(r.ok).toBe(false)
      if (!r.ok) {
        expect(r.message.toLowerCase()).toMatch(/database|reach|connect/)
        expect(r.message.toLowerCase()).not.toMatch(/corrupt|altered|unreadable/)
        expect(r.message).not.toContain('hunter2')
      }
    } finally {
      spy.mockRestore()
    }
  })

  it('revealAction reports a neutral failure, not tampering or a database claim, for an error it cannot positively identify', async () => {
    await createVaultAction('right passphrase')
    await acknowledgeRecoveryKeyAction()
    const add = await addCredentialAction({ label: 'a', username: 'u', secret: 'hunter2' })
    expect(add.ok).toBe(true)
    if (!add.ok) return
    // A REAL PrismaClientKnownRequestError, but with a code that is neither
    // a recognised connectivity code nor anything decrypt-related -- proves
    // the classifier does not treat "any Prisma error" as either database
    // or tampering.
    const spy = vi.spyOn(prisma.credentialAccess, 'create').mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('unrelated failure', { code: 'P2025', clientVersion: 'test' }),
    )
    try {
      const r = await revealAction(add.id)
      expect(r.ok).toBe(false)
      if (!r.ok) {
        expect(r.message.toLowerCase()).not.toMatch(/corrupt|altered|unreadable/)
        expect(r.message.toLowerCase()).not.toMatch(/database|reach|connect/)
        expect(r.message).not.toContain('unrelated failure')
      }
    } finally {
      spy.mockRestore()
    }
  })

  // --- Fix round 5 (minor): createVaultAction must also recognise
  // vault.ts's own internal singleton guard (VaultAlreadyExistsError), not
  // just the database's P2002 -- this is the MORE likely outcome of the
  // real concurrent-create race in practice. ---

  it('createVaultAction reports "already exists" when vault.ts\'s own internal singleton guard fires, not the neutral message', async () => {
    // Simulates the interleaving where the slower of two racing calls
    // observes (via its OWN internal isInitialised() re-check inside
    // createVault()) that the vault now exists, before ever reaching the
    // database insert that would otherwise raise P2002. The two
    // findUnique() calls below are: (1) this action's own isInitialised()
    // check, which must see "not yet initialised", and (2) createVault()'s
    // internal re-check, which must see "now initialised".
    const fakeRow = {
      id: 'singleton',
      kdfParams: '{}',
      verifier: 'v',
      wrappedByPassphrase: 'a',
      wrappedByRecovery: 'b',
      recoveryKeyAcknowledgedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    }
    const spy = vi.spyOn(prisma.vaultConfig, 'findUnique')
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(fakeRow)
    try {
      const r = await createVaultAction('right passphrase')
      expect(r.ok).toBe(false)
      if (!r.ok) {
        expect(r.message.toLowerCase()).toContain('already exists')
      }
    } finally {
      spy.mockRestore()
    }
    expect(await prisma.vaultConfig.count()).toBe(0)
  })

  // --- Fix round 2 (task-8): every action that leaves the vault unlocked
  // hands the client a DURATION ("N ms remain"), not the absolute epoch
  // instant `session.ts`'s `sessionExpiresAt()` returns -- so a client whose
  // clock disagrees with the server's cannot misjudge the deadline, and a
  // client-driven unlock has an authoritative deadline to schedule against
  // immediately, without waiting on the next server render of `page.tsx`.
  // See VaultPanel's use of this value and task-8-report.md "Fix round 2".
  describe('sessionRemainingMs (fix round 2)', () => {
    it('createVaultAction returns a session duration close to the full TTL', async () => {
      const r = await createVaultAction('right passphrase')
      expect(r.ok).toBe(true)
      if (!r.ok) return
      // "Close to", not exactly equal: real wall-clock time elapses between
      // unlockSession() (inside createVault()) and this action reading it
      // back via remainingSessionMs() a few lines later. A 5-second window
      // is generous for a single in-process function call and nowhere near
      // enough to hide a bug that returned e.g. 0, a negative number, or the
      // raw absolute instant instead.
      expect(r.sessionRemainingMs).toBeGreaterThan(DEFAULT_TTL_MS - 5000)
      expect(r.sessionRemainingMs).toBeLessThanOrEqual(DEFAULT_TTL_MS)
    })

    it('unlockAction returns a session duration close to the full TTL', async () => {
      await createVaultAction('right passphrase')
      lockSession()
      const r = await unlockAction('right passphrase')
      expect(r.ok).toBe(true)
      if (!r.ok) return
      expect(r.sessionRemainingMs).toBeGreaterThan(DEFAULT_TTL_MS - 5000)
      expect(r.sessionRemainingMs).toBeLessThanOrEqual(DEFAULT_TTL_MS)
    })

    it('unlockWithRecoveryAction returns a session duration close to the full TTL', async () => {
      const created = await createVaultAction('right passphrase')
      expect(created.ok).toBe(true)
      if (!created.ok) return
      lockSession()
      const r = await unlockWithRecoveryAction(created.recoveryKey)
      expect(r.ok).toBe(true)
      if (!r.ok) return
      expect(r.sessionRemainingMs).toBeGreaterThan(DEFAULT_TTL_MS - 5000)
      expect(r.sessionRemainingMs).toBeLessThanOrEqual(DEFAULT_TTL_MS)
    })

  })
})
