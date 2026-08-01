import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

const ALG = 'aes-256-gcm'
const VERSION = 'v1'

/** AAD binds ciphertext to its location: `<table>:<rowId>:<column>`. */
export function seal(plaintext: string, aad: string, dek: Buffer): string {
  const iv = randomBytes(12)
  const c = createCipheriv(ALG, dek, iv)
  c.setAAD(Buffer.from(aad, 'utf8'))
  const ct = Buffer.concat([c.update(plaintext, 'utf8'), c.final()])
  return [VERSION, iv.toString('base64'), c.getAuthTag().toString('base64'), ct.toString('base64')].join(':')
}

// Throws on any mismatch of key, AAD, ciphertext, or malformed envelope shape —
// never caught and turned into null/undefined. A caller that cannot tell "wrong
// key" from "empty value" will eventually treat a decryption failure as valid data.
export function open(sealed: string, aad: string, dek: Buffer): string {
  const parts = sealed.split(':')
  if (parts.length !== 4) throw new Error('malformed envelope: expected 4 parts')
  const [version, iv, tag, ct] = parts as [string, string, string, string]
  if (version !== VERSION) throw new Error(`unsupported envelope version: ${version}`)
  const d = createDecipheriv(ALG, dek, Buffer.from(iv, 'base64'))
  d.setAAD(Buffer.from(aad, 'utf8'))
  d.setAuthTag(Buffer.from(tag, 'base64'))
  // Throws on any mismatch of key, AAD or ciphertext — that is the point.
  return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8')
}

export function unwrapDek(wrapped: string, kek: Buffer): Buffer {
  return Buffer.from(open(wrapped, 'dek:0:wrapped', kek), 'base64')
}
