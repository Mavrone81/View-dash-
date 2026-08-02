import { randomUUID } from 'node:crypto'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { Prisma } from '@prisma/client'
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
    lockSession()
    const r = await addCredentialAction({ label: 'a', username: 'u', secret: 'hunter2' })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.message.toLowerCase()).toContain('locked')
      expect(r.message).not.toContain('hunter2')
    }
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
})
