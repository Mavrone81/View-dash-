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

// The single source of truth for the DEK-wrapping AAD. wrapDek and unwrapDek
// both derive it from this one expression so they can never drift apart — if
// they ever disagreed, every wrapped key would become permanently
// undecryptable. Binding the generation into the AAD (rather than a constant
// like `dek:0:wrapped`) means a DEK wrapped under generation N cannot be
// mistaken for generation N-1's: without this, an attacker or a bad restore
// could silently roll the system back to a retired key generation, and
// nothing would signal it because the ciphertext would authenticate
// perfectly against the wrong generation.
// Validated here, once, so wrapDek and unwrapDek both inherit the check
// from their one shared AAD-building expression. Without it, a negative,
// fractional, NaN, or Infinity generation would still stringify into a
// syntactically fine AAD (e.g. `dek:-1:wrapped`) and be silently accepted —
// not a forgery risk by itself (the number is never attacker-controlled),
// but this is the single place a real generation counter gets persisted and
// compared, so a caller's bug here (an off-by-something producing -1, or a
// NaN from a bad parse) should fail loudly instead of quietly minting a
// well-formed-looking but meaningless key generation.
function dekAad(generation: number): string {
  if (!Number.isInteger(generation) || generation < 0) {
    throw new Error('invalid key generation: expected a non-negative integer')
  }
  return `dek:${generation}:wrapped`
}

/** Wraps a 32-byte DEK under the KEK, binding it to its key generation. */
export function wrapDek(dek: Buffer, generation: number, kek: Buffer): string {
  if (dek.length !== DEK_LENGTH) throw new Error('invalid DEK: expected 32 bytes')
  return seal(dek.toString('base64'), dekAad(generation), kek)
}

/**
 * Unwraps a DEK sealed under `generation`. Throws if the wrapped value was
 * sealed under a different generation, the wrong KEK, or is not 32 bytes once
 * unwrapped — see the rollback-protection note on `dekAad` above.
 */
export function unwrapDek(wrapped: string, generation: number, kek: Buffer): Buffer {
  const dek = Buffer.from(open(wrapped, dekAad(generation), kek), 'base64')
  if (dek.length !== DEK_LENGTH) throw new Error('invalid unwrapped key: expected a 32-byte DEK')
  return dek
}
