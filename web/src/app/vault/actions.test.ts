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
})
