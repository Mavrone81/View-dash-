import { randomUUID } from 'node:crypto'
import { describe, it, expect, beforeEach } from 'vitest'
import { prisma } from '../db.js'
import { lockSession } from './session.js'
import { createVault, unlockWithPassphrase } from './vault.js'
import {
  addCredential,
  listCredentials,
  revealCredential,
  credentialsForSystem,
  removeCredential,
} from './credentials.js'

// Host.name is @unique and nothing in this suite truncates the Host table, so
// a fixture host created with a shared name survives the run and collides on
// the next one — this file failed on its own second consecutive run for
// exactly that reason. The fix is ownership: this file uses a name no other
// spec file uses, and deletes that one row before each test. deleteMany on a
// name that isn't there is a no-op, so it is safe on a clean database, and
// scoping the delete by name leaves every other file's fixtures untouched.
const FIXTURE_HOST = 'vault-fixture-host'

beforeEach(async () => {
  await prisma.credentialAccess.deleteMany()
  await prisma.credential.deleteMany()
  await prisma.vaultConfig.deleteMany()
  // Cascades to the fixture host's systems, so a test that dies midway cannot
  // leave a (hostId, key) row behind to break the next run.
  await prisma.host.deleteMany({ where: { name: FIXTURE_HOST } })
})

describe('vault schema', () => {
  it('stores a credential with a sealed secret and no plaintext column', async () => {
    const c = await prisma.credential.create({
      data: { label: 'admin', username: 'operator', secretSealed: 'v1:x:y:z' },
    })
    expect(c.secretSealed).toBe('v1:x:y:z')
    expect(Object.keys(c)).not.toContain('secret')
  })

  it('keeps a credential when its linked system disappears', async () => {
    const host = await prisma.host.create({ data: { name: FIXTURE_HOST } })
    const sys = await prisma.system.create({ data: { hostId: host.id, key: 'alpha', displayName: 'alpha' } })
    await prisma.credential.create({
      data: { label: 'admin', username: 'operator', secretSealed: 'v1:x:y:z', hostId: host.id, systemKey: 'alpha' },
    })
    await prisma.system.delete({ where: { id: sys.id } })
    expect(await prisma.credential.count()).toBe(1)
  })

  it('refuses a second VaultConfig row', async () => {
    await prisma.vaultConfig.create({
      data: { kdfParams: '{}', verifier: 'v', wrappedByPassphrase: 'a', wrappedByRecovery: 'b' },
    })
    await expect(
      prisma.vaultConfig.create({
        data: { kdfParams: '{}', verifier: 'v', wrappedByPassphrase: 'a', wrappedByRecovery: 'b' },
      }),
    ).rejects.toThrow()
  })

  it('refuses a VaultConfig row with an explicit non-singleton id', async () => {
    await expect(
      prisma.vaultConfig.create({
        data: {
          id: 'not-singleton',
          kdfParams: '{}',
          verifier: 'v',
          wrappedByPassphrase: 'a',
          wrappedByRecovery: 'b',
        },
      }),
    ).rejects.toThrow()
  })
})

describe('credentials', () => {
  beforeEach(async () => {
    lockSession()
    await prisma.credentialAccess.deleteMany()
    await prisma.credential.deleteMany()
    await prisma.vaultConfig.deleteMany()
    await createVault('right')
  })

  it('stores a secret and reveals it again', async () => {
    const id = await addCredential({ label: 'admin', username: 'operator', secret: 'hunter2' })
    expect(await revealCredential(id)).toBe('hunter2')
  })

  it('NEVER returns a secret from the list', async () => {
    await addCredential({ label: 'admin', username: 'operator', secret: 'hunter2' })
    const rows = await listCredentials()
    expect(JSON.stringify(rows)).not.toContain('hunter2')
    expect(Object.keys(rows[0]!)).not.toContain('secretSealed')
  })

  it('does not store the secret in plaintext anywhere', async () => {
    await addCredential({ label: 'admin', username: 'operator', secret: 'hunter2' })
    const raw = await prisma.credential.findMany()
    expect(JSON.stringify(raw)).not.toContain('hunter2')
  })

  it('REFUSES to reveal while the vault is locked', async () => {
    const id = await addCredential({ label: 'admin', username: 'operator', secret: 'hunter2' })
    lockSession()
    await expect(revealCredential(id)).rejects.toThrow('vault is locked')
  })

  it('writes an audit row for every reveal', async () => {
    const id = await addCredential({ label: 'admin', username: 'operator', secret: 'hunter2' })
    await revealCredential(id)
    await revealCredential(id)
    const audit = await prisma.credentialAccess.findMany({ where: { credentialId: id, action: 'reveal' } })
    expect(audit).toHaveLength(2)
  })

  it('never records the secret in the audit row', async () => {
    const id = await addCredential({ label: 'admin', username: 'operator', secret: 'hunter2' })
    await revealCredential(id)

    // Also exercise the denied and failed paths: 'reveal-denied' and
    // 'reveal-failed' rows must be just as clean as a successful 'reveal'
    // row — an id and an action string, never the ciphertext or the secret.
    lockSession()
    await expect(revealCredential(id)).rejects.toThrow()
    await unlockWithPassphrase('right')

    const other = await addCredential({ label: 'other', username: 'u', secret: 'other-secret' })
    const otherRow = await prisma.credential.findUniqueOrThrow({ where: { id: other } })
    await prisma.credential.update({ where: { id }, data: { secretSealed: otherRow.secretSealed } })
    await expect(revealCredential(id)).rejects.toThrow()

    const audit = await prisma.credentialAccess.findMany()
    expect(JSON.stringify(audit)).not.toContain('hunter2')
    expect(JSON.stringify(audit)).not.toContain('other-secret')
  })

  it('a reveal attempted while locked writes exactly one reveal-denied row and still throws', async () => {
    const id = await addCredential({ label: 'admin', username: 'operator', secret: 'hunter2' })
    lockSession()
    await expect(revealCredential(id)).rejects.toThrow('vault is locked')
    const denied = await prisma.credentialAccess.findMany({ where: { credentialId: id, action: 'reveal-denied' } })
    expect(denied).toHaveLength(1)
  })

  it('a reveal of a ciphertext moved from another row writes exactly one reveal-failed row and still throws', async () => {
    const a = await addCredential({ label: 'a', username: 'u', secret: 'secret-a' })
    const b = await addCredential({ label: 'b', username: 'u', secret: 'secret-b' })
    const rowA = await prisma.credential.findUniqueOrThrow({ where: { id: a } })
    await prisma.credential.update({ where: { id: b }, data: { secretSealed: rowA.secretSealed } })
    await expect(revealCredential(b)).rejects.toThrow()
    const failed = await prisma.credentialAccess.findMany({ where: { credentialId: b, action: 'reveal-failed' } })
    expect(failed).toHaveLength(1)
  })

  it('a reveal of an id that does not exist writes no audit row at all', async () => {
    // Locking the session here is what actually exercises the FK-ordering
    // fix. In an unlocked vault, ANY ordering (lock check first or row
    // lookup first) throws before ever reaching an audit write, so a
    // missing id writes zero rows either way — that alone would not prove
    // anything. Locking first is what would make a "check the lock before
    // looking up the row" implementation report 'vault is locked' for an id
    // that was never going to exist regardless of lock state — masking the
    // real problem exactly as the finding describes. The fixed
    // implementation must still say 'credential not found', not that.
    lockSession()
    const missingId = randomUUID()
    await expect(revealCredential(missingId)).rejects.toThrow('credential not found')
    const audit = await prisma.credentialAccess.findMany({ where: { credentialId: missingId } })
    expect(audit).toHaveLength(0)
  })

  it('finds the credentials attached to a system', async () => {
    const host = await prisma.host.create({ data: { name: FIXTURE_HOST } })
    await addCredential({ label: 'admin', username: 'operator', secret: 's', hostId: host.id, systemKey: 'alpha' })
    await addCredential({ label: 'other', username: 'operator', secret: 's' })
    expect(await credentialsForSystem(host.id, 'alpha')).toHaveLength(1)
  })

  it('REFUSES to open a ciphertext moved to another credential row', async () => {
    const a = await addCredential({ label: 'a', username: 'u', secret: 'secret-a' })
    const b = await addCredential({ label: 'b', username: 'u', secret: 'secret-b' })
    const rowA = await prisma.credential.findUniqueOrThrow({ where: { id: a } })
    await prisma.credential.update({ where: { id: b }, data: { secretSealed: rowA.secretSealed } })
    await expect(revealCredential(b)).rejects.toThrow()
  })

  it('deletes a credential and its audit trail together', async () => {
    const id = await addCredential({ label: 'admin', username: 'operator', secret: 's' })
    await revealCredential(id)
    await removeCredential(id)
    expect(await prisma.credential.count()).toBe(0)
    expect(await prisma.credentialAccess.count()).toBe(0)
  })

  it('never persists a credential row without its sealed secret', async () => {
    // This alone cannot observe an intermediate state between a create and a
    // follow-up update — it only re-reads the row after addCredential has
    // already returned. What it does catch is a regression that leaves the
    // 'pending' sentinel behind, e.g. if a future edit reintroduces a
    // create-then-update split and the second write is ever skipped.
    const id = await addCredential({ label: 'admin', username: 'operator', secret: 'hunter2' })
    const row = await prisma.credential.findUniqueOrThrow({ where: { id } })
    expect(row.secretSealed).not.toBe('pending')
    expect(await revealCredential(id)).toBe('hunter2')
  })
})
