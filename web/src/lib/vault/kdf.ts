import { randomBytes, scryptSync } from 'node:crypto'
import { seal, open } from '../crypto/envelope.js'

export type KdfParams = { N: number; r: number; p: number; saltB64: string }

// scrypt rather than Argon2id: every Node Argon2 is a native module, and a
// binary dependency in the most security-sensitive path here costs more than
// the margin between two good memory-hard KDFs. N=65536 is ~64MB per
// derivation — deliberately expensive, which is the point.
const N = 65536
const R = 8
const P = 1
const KEY_BYTES = 32

// Floors matching what newKdfParams actually produces (N=65536, r=8, p=1,
// 16-byte salt). These params are read back out of a database row, so a
// corrupted row, a bad migration, or write access to that table must not be
// able to silently weaken every future derivation — the only visible symptom
// of a downgraded N would otherwise be that unlocking gets suspiciously fast.
const MIN_SALT_BYTES = 16
const MIN_N = 16384
const MIN_R = 8
const MIN_P = 1

/**
 * Rejected stored KDF parameters — a NAMED type, in keeping with
 * `VaultLockedError`, `CredentialNotFoundError`, `CredentialDecryptError`
 * and `VaultAlreadyExistsError`, so the server-action layer can classify
 * this by `instanceof` rather than by matching message text.
 *
 * Why it matters that this is distinguishable: these params come out of a
 * database row and are read back through an unchecked cast, so the three
 * realistic shapes reaching `validateParams` are `{}` (a truncated or
 * hand-written row), `null` (the literal JSON `null`), and a STRUCTURALLY
 * VALID object carrying a downgraded work factor — the tampering case the
 * floors below exist to catch. All three are permanent: no amount of
 * retrying makes them unlock. Thrown as a plain `Error`, they were reported
 * to the operator as "try again in a moment", which is advice that can never
 * come true and which never steers them to the recovery key that would
 * actually work.
 */
export class KdfParamsError extends Error {}

// Throws naming which parameter was rejected, but never includes the salt
// value or the passphrase in the message — the salt is attacker-adjacent
// data from the same row, and an error message is a plausible place for it
// to leak into logs.
//
// Takes `unknown` rather than `KdfParams` on purpose. Every caller that
// matters (`unlockWithPassphrase`, `changePassphrase`) reaches here through
// `JSON.parse(...) as KdfParams` — a cast, not a check — so the static type
// is a claim, not a fact. Narrowing here is what makes the cast safe, and
// what stops a `null` row from dying on a bare TypeError ("cannot read
// properties of null") that carries no usable meaning to the caller.
function validateParams(params: unknown): asserts params is KdfParams {
  if (typeof params !== 'object' || params === null) {
    throw new KdfParamsError('invalid kdf params: not an object')
  }
  const { N, r, p, saltB64 } = params as Partial<Record<'N' | 'r' | 'p' | 'saltB64', unknown>>
  if (typeof N !== 'number' || !Number.isInteger(N) || N < MIN_N || (N & (N - 1)) !== 0) {
    throw new KdfParamsError(`invalid kdf params: N must be an integer power of two >= ${MIN_N}`)
  }
  if (typeof r !== 'number' || !Number.isInteger(r) || r < MIN_R) {
    throw new KdfParamsError(`invalid kdf params: r must be an integer >= ${MIN_R}`)
  }
  if (typeof p !== 'number' || !Number.isInteger(p) || p < MIN_P) {
    throw new KdfParamsError(`invalid kdf params: p must be an integer >= ${MIN_P}`)
  }
  if (typeof saltB64 !== 'string') {
    throw new KdfParamsError('invalid kdf params: salt must be a string')
  }
  if (Buffer.from(saltB64, 'base64').length < MIN_SALT_BYTES) {
    throw new KdfParamsError(`invalid kdf params: salt must decode to at least ${MIN_SALT_BYTES} bytes`)
  }
}

export function newKdfParams(): KdfParams {
  return { N, r: R, p: P, saltB64: randomBytes(16).toString('base64') }
}

export function deriveWrappingKey(passphrase: string, params: KdfParams): Buffer {
  validateParams(params)
  // scryptSync refuses to allocate past its default maxmem (32MB) at these
  // parameters and throws — maxmem must be derived from the actual params
  // (128 * N * r, with headroom) rather than hardcoded, so a future params
  // bump can't silently reintroduce the failure.
  const maxmem = 256 * params.N * params.r * params.p
  return scryptSync(passphrase, Buffer.from(params.saltB64, 'base64'), KEY_BYTES, {
    N: params.N,
    r: params.r,
    p: params.p,
    maxmem,
  })
}

// The verifier proves a passphrase is right WITHOUT revealing the vault key:
// a known constant sealed under the wrapping key. A wrong key fails the AEAD
// tag, so the answer is a clean false rather than garbage plaintext.
const VERIFIER_PLAINTEXT = 'bevora-ops-vault-verifier-v1'
const VERIFIER_AAD = 'vault:verifier:v1'

export function makeVerifier(wrappingKey: Buffer): string {
  return seal(VERIFIER_PLAINTEXT, VERIFIER_AAD, wrappingKey)
}

export function checkVerifier(wrappingKey: Buffer, verifier: string): boolean {
  // A corrupt/malformed verifier string comes straight out of the database —
  // it must never crash an unlock attempt, so any failure (bad shape, wrong
  // key, wrong AAD, tampered ciphertext) collapses to a clean false.
  try {
    return open(verifier, VERIFIER_AAD, wrappingKey) === VERIFIER_PLAINTEXT
  } catch {
    return false
  }
}
