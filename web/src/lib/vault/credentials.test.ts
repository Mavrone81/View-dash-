import { describe, it, expect, beforeEach } from 'vitest'
import { prisma } from '../db.js'

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
