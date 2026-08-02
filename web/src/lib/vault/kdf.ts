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

// Throws naming which parameter was rejected, but never includes the salt
// value or the passphrase in the message — the salt is attacker-adjacent
// data from the same row, and an error message is a plausible place for it
// to leak into logs.
function validateParams(params: KdfParams): void {
  if (!Number.isInteger(params.N) || params.N < MIN_N || (params.N & (params.N - 1)) !== 0) {
    throw new Error(`invalid kdf params: N must be an integer power of two >= ${MIN_N}`)
  }
  if (!Number.isInteger(params.r) || params.r < MIN_R) {
    throw new Error(`invalid kdf params: r must be an integer >= ${MIN_R}`)
  }
  if (!Number.isInteger(params.p) || params.p < MIN_P) {
    throw new Error(`invalid kdf params: p must be an integer >= ${MIN_P}`)
  }
  let salt: Buffer
  try {
    salt = Buffer.from(params.saltB64, 'base64')
  } catch {
    throw new Error(`invalid kdf params: salt is not valid base64`)
  }
  if (salt.length < MIN_SALT_BYTES) {
    throw new Error(`invalid kdf params: salt must decode to at least ${MIN_SALT_BYTES} bytes`)
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
