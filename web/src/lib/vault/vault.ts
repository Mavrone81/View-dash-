import { prisma } from '../db.js'
import { newKdfParams, deriveWrappingKey, makeVerifier, checkVerifier, type KdfParams } from './kdf.js'
import { newVaultKey, newRecoveryKey, wrapVaultKey, unwrapVaultKey, recoveryKeyFromDisplay } from './keyring.js'
import { unlockSession } from './session.js'

const SINGLETON = 'singleton'

async function config() {
  return prisma.vaultConfig.findUnique({ where: { id: SINGLETON } })
}

export async function isInitialised(): Promise<boolean> {
  return (await config()) !== null
}

export async function createVault(passphrase: string): Promise<{ recoveryKey: string }> {
  if (await isInitialised()) throw new Error('vault already exists')

  const params = newKdfParams()
  const wrappingKey = deriveWrappingKey(passphrase, params)
  const vaultKey = newVaultKey()
  const recovery = newRecoveryKey()

  await prisma.vaultConfig.create({
    data: {
      id: SINGLETON,
      kdfParams: JSON.stringify(params),
      verifier: makeVerifier(wrappingKey),
      wrappedByPassphrase: wrapVaultKey(vaultKey, wrappingKey, 'passphrase'),
      wrappedByRecovery: wrapVaultKey(vaultKey, recovery.key, 'recovery'),
    },
  })

  unlockSession(vaultKey)
  // Returned once. Nothing stores the printable form; only the wrapping it
  // produced is persisted, and that cannot be reversed without the key.
  return { recoveryKey: recovery.display }
}

export async function unlockWithPassphrase(passphrase: string): Promise<boolean> {
  const c = await config()
  if (!c) return false
  const params = JSON.parse(c.kdfParams) as KdfParams
  const wrappingKey = deriveWrappingKey(passphrase, params)
  if (!checkVerifier(wrappingKey, c.verifier)) return false
  try {
    unlockSession(unwrapVaultKey(c.wrappedByPassphrase, wrappingKey, 'passphrase'))
    return true
  } catch {
    return false
  }
}

export async function unlockWithRecoveryKey(display: string): Promise<boolean> {
  const c = await config()
  if (!c) return false
  try {
    const key = recoveryKeyFromDisplay(display)
    unlockSession(unwrapVaultKey(c.wrappedByRecovery, key, 'recovery'))
    return true
  } catch {
    return false
  }
}

export async function changePassphrase(current: string, next: string): Promise<boolean> {
  const c = await config()
  if (!c) return false
  const oldParams = JSON.parse(c.kdfParams) as KdfParams
  const oldWrapping = deriveWrappingKey(current, oldParams)
  if (!checkVerifier(oldWrapping, c.verifier)) return false

  let vaultKey: Buffer
  try {
    vaultKey = unwrapVaultKey(c.wrappedByPassphrase, oldWrapping, 'passphrase')
  } catch {
    return false
  }

  // Re-wrap the SAME vault key under a new passphrase. Nothing else is
  // touched: every sealed secret stays exactly as it is, so this costs the
  // same whether the vault holds one credential or ten thousand — and the
  // recovery wrapping is untouched, so the printed key keeps working.
  const params = newKdfParams()
  const wrappingKey = deriveWrappingKey(next, params)
  await prisma.vaultConfig.update({
    where: { id: SINGLETON },
    data: {
      kdfParams: JSON.stringify(params),
      verifier: makeVerifier(wrappingKey),
      wrappedByPassphrase: wrapVaultKey(vaultKey, wrappingKey, 'passphrase'),
    },
  })
  return true
}
