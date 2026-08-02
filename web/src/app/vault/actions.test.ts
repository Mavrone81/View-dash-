import { describe, it, expect, beforeEach, vi } from 'vitest'
import { prisma } from '../../lib/db.js'
import { lockSession } from '../../lib/vault/session.js'

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
    const add = await addCredentialAction({ label: 'a', username: 'u', secret: 'hunter2' })
    expect(add.ok).toBe(true)
    if (!add.ok) return
    const removed = await removeCredentialAction(add.id)
    expect(removed.ok).toBe(true)
    expect(await prisma.credential.count()).toBe(0)
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

  it('createVaultAction returns a plain failure, not a thrown error, when the underlying create fails', async () => {
    // Simulates the TOCTOU window between this action's own isInitialised()
    // check and createVault()'s write: two concurrent calls can both pass
    // the check, and the database's singleton constraint then rejects the
    // second insert. Reproduced deterministically here by making the
    // underlying prisma insert fail once, exactly as a lost race would.
    const spy = vi.spyOn(prisma.vaultConfig, 'create').mockRejectedValueOnce(
      new Error('Unique constraint failed on the fields: (`id`)'),
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
})
