import { randomBytes } from 'node:crypto'
import { seal, open } from '../crypto/envelope.js'

const KEY_BYTES = 32

export function newVaultKey(): Buffer {
  return randomBytes(KEY_BYTES)
}

// Printed in groups so a human can copy it off paper without losing their
// place. The groups are cosmetic and stripped on the way back in.
//
// The group separator is a SPACE, not a dash. base64url's own alphabet
// includes '-' (and '_'), so a base64url payload can legitimately contain a
// dash — grouping with '-' and later stripping every '-' would strip payload
// characters along with the separators, silently corrupting some fraction of
// generated keys into the wrong bytes while still "parsing". A space never
// appears in base64url output, so stripping it can only ever remove
// separators we added ourselves.
export function newRecoveryKey(): { display: string; key: Buffer } {
  const key = randomBytes(KEY_BYTES)
  const raw = key.toString('base64url')
  const display = (raw.match(/.{1,8}/g) ?? []).join(' ')
  return { display, key }
}

export function recoveryKeyFromDisplay(display: string): Buffer {
  const key = Buffer.from(display.replace(/\s+/g, ''), 'base64url')
  if (key.length !== KEY_BYTES) throw new Error('recovery key is not valid')
  return key
}

// The two wrappings carry DIFFERENT AADs, so a blob wrapped by the passphrase
// cannot be presented as the recovery wrapping or vice versa. Without this
// they would be interchangeable ciphertexts under different keys.
const AAD = {
  passphrase: 'vault:key:passphrase',
  recovery: 'vault:key:recovery',
} as const

export function wrapVaultKey(
  vaultKey: Buffer,
  wrappingKey: Buffer,
  kind: keyof typeof AAD,
): string {
  return seal(vaultKey.toString('base64'), AAD[kind], wrappingKey)
}

export function unwrapVaultKey(
  wrapped: string,
  wrappingKey: Buffer,
  kind: keyof typeof AAD,
): Buffer {
  const key = Buffer.from(open(wrapped, AAD[kind], wrappingKey), 'base64')
  if (key.length !== KEY_BYTES) throw new Error('unwrapped vault key has the wrong length')
  return key
}
