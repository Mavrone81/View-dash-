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

export function newKdfParams(): KdfParams {
  return { N, r: R, p: P, saltB64: randomBytes(16).toString('base64') }
}

export function deriveWrappingKey(passphrase: string, params: KdfParams): Buffer {
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
