import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

const ALG = 'aes-256-gcm'
const VERSION = 'v1'
// GCM's full tag size, and the only length this envelope accepts. Node's GCM
// implementation will happily accept truncated tags (4/8/12/13/14/15 bytes),
// which drops forgery cost from 2^-128 to as low as 2^-32 — an attacker who
// can rewrite a stored envelope could swap in a short tag to make forgery
// tractable. Rejecting anything but 16 bytes closes that off.
const TAG_LENGTH = 16
// AES-256 key size. unwrapDek must not hand back an arbitrary-length buffer —
// anything ever sealed under the KEK with the wrapping AAD would otherwise be
// silently accepted as a usable DEK.
const DEK_LENGTH = 32

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
//
// The checks below raise distinct messages (shape / version / tag length / GCM
// auth failure) rather than one opaque error. That is acceptable here because
// sealed values are read out of our own database at rest — there is no
// network-facing decryption oracle an attacker can probe with crafted
// envelopes to learn which check failed, so the extra granularity only helps
// our own debugging, not an attacker.
export function open(sealed: string, aad: string, dek: Buffer): string {
  const parts = sealed.split(':')
  if (parts.length !== 4) throw new Error('malformed envelope: expected 4 parts')
  const [version, iv, tag, ct] = parts as [string, string, string, string]
  // Fixed message: `version` is attacker-controlled bytes from a stored value,
  // and interpolating it into an error string that might get logged is a
  // log-injection vector.
  if (version !== VERSION) throw new Error('unsupported envelope version')
  const tagBuf = Buffer.from(tag, 'base64')
  if (tagBuf.length !== TAG_LENGTH) throw new Error('invalid envelope: auth tag must be 16 bytes')
  const d = createDecipheriv(ALG, dek, Buffer.from(iv, 'base64'))
  d.setAAD(Buffer.from(aad, 'utf8'))
  d.setAuthTag(tagBuf)
  // Throws on any mismatch of key, AAD or ciphertext — that is the point.
  return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8')
}

export function unwrapDek(wrapped: string, kek: Buffer): Buffer {
  const dek = Buffer.from(open(wrapped, 'dek:0:wrapped', kek), 'base64')
  if (dek.length !== DEK_LENGTH) throw new Error('invalid unwrapped key: expected a 32-byte DEK')
  return dek
}
