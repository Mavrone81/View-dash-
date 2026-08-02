import { describe, it, expect, beforeEach } from 'vitest'
import { prisma } from '../db.js'
import { lockSession } from './session.js'
import { createVault } from './vault.js'
import {
  addCredential,
  listCredentials,
  revealCredential,
  credentialsForSystem,
  removeCredential,
} from './credentials.js'

beforeEach(async () => {
  await prisma.credentialAccess.deleteMany()
  await prisma.credential.deleteMany()
  await prisma.vaultConfig.deleteMany()
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
    const host = await prisma.host.create({ data: { name: 'host-a' } })
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
    await expect(revealCredential(id)).rejects.toThrow()
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
    const audit = await prisma.credentialAccess.findMany()
    expect(JSON.stringify(audit)).not.toContain('hunter2')
  })

  it('finds the credentials attached to a system', async () => {
    // 'vault-fixture-host' rather than 'host-a': Host.name is @unique, this
    // file's own 'vault schema' describe above already creates 'host-a' and
    // never cleans up the Host table, and several other spec files in this
    // repo create 'host-a' too. upsert makes this safe to re-run regardless
    // of file/test ordering.
    const host = await prisma.host.upsert({
      where: { name: 'vault-fixture-host' },
      update: {},
      create: { name: 'vault-fixture-host' },
    })
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
