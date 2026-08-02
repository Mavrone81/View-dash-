# Credential Vault Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An encrypted credential store inside the dashboard, so clicking a system answers "what do I log into this with" — locked by its own passphrase, revealed one credential at a time, every reveal audited.

**Architecture:** A random vault key is generated once and never stored raw. It is wrapped twice — by a key derived from the operator's passphrase, and by a printed recovery key — so a forgotten passphrase does not destroy the vault and a passphrase change re-wraps one key rather than re-encrypting every secret. Each credential's secret is sealed with the existing AAD-bound envelope. The unwrapped vault key lives only in process memory and expires.

**Tech Stack:** Node 22, TypeScript strict, Next.js 16 (App Router, server actions), Prisma 6 + Postgres 16, Vitest. Cryptography from `node:crypto` only.

## Global Constraints

- **Node 22.** `export PATH="/opt/homebrew/opt/node@22/bin:$PATH"` in every shell. Default `node` is v26 and breaks jsdom.
- **TypeScript strict, pinned 5.9.3, `noUncheckedIndexedAccess`.** No `any`; no `@ts-ignore` without a reason comment.
- **This repository is PUBLIC.** No IP addresses, hostnames, domains, or names of monitored systems — in code, tests, fixtures, comments or docs. A CI gate blocks this. Use `alpha`, `beta`, `host-a`.
- **No literal NUL bytes in source files.** One shipped earlier and git classified the file binary, making the tests unreviewable.
- **Dependencies pinned to exact versions, no caret ranges.**
- Test Postgres is on **port 5434** (`bevops-testpg`, already running). `vitest.config.ts` sets `fileParallelism: false` deliberately — do not change it.
- **Every rule gets a test asserting the DENIAL**, and a denial test must be **verified to fail without its fix**, not reasoned about. Break the line, run, confirm the failure names the right thing, restore, report what you saw.
- **Never log a secret, a passphrase, a derived key, or the vault key** — including in error messages, which is where they usually escape.

### ⚠️ One documented deviation from the spec

The spec says **Argon2id**. This plan uses **scrypt** from `node:crypto` instead, and the reason should be weighed rather than assumed:

Argon2id is the better KDF on paper. Every Node implementation of it is a **native module**, which means a compiler in the image build and a binary dependency in the most security-sensitive path in the product. scrypt is memory-hard, in Node core, has no supply chain, and needs no build tooling. For a vault protecting one operator's credentials on a 1 GB droplet, removing a native dependency from the trust path is worth more than the margin between two good KDFs.

Parameters: `N = 65536, r = 8, p = 1` — roughly 64 MB per derivation, which is deliberate (it is what makes guessing expensive) and comfortable on a 1 GB host that is otherwise idle during an unlock.

If the product owner prefers Argon2id, it is a one-file change in Task 2 and nothing else moves.

### ⚠️ Single-process assumption

The unlocked vault key is held in module memory. This is correct only while `web` runs as **one Node process** — which it does (`next start`, one container). If the deployment ever runs multiple workers, an unlock in one worker will not unlock another, and the symptom is a vault that appears to re-lock at random. Task 4 documents this in the code.

## File Structure

| Path | Responsibility |
|---|---|
| `web/prisma/schema.prisma` | `Credential`, `VaultConfig`, `CredentialAccess` |
| `web/src/lib/vault/kdf.ts` | passphrase → wrapping key; KDF params; verifier |
| `web/src/lib/vault/keyring.ts` | create/wrap/unwrap the vault key; recovery key |
| `web/src/lib/vault/session.ts` | in-memory lock state and expiry |
| `web/src/lib/vault/credentials.ts` | credential CRUD, reveal, audit |
| `web/src/app/vault/actions.ts` | server actions — the app's first write path |
| `web/src/app/vault/page.tsx`, `web/src/components/Vault*.tsx` | interface |

---

### Task 1: Schema and migration

**Files:**
- Modify: `web/prisma/schema.prisma`
- Create: `web/src/lib/vault/credentials.test.ts` (schema assertions only in this task)

**Interfaces:**
- Produces: models `Credential`, `VaultConfig`, `CredentialAccess`.

- [ ] **Step 1: Write the failing test**

```ts
// web/src/lib/vault/credentials.test.ts
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
})
```

The second test is the point of the whole model: a credential must outlive the system it describes. Deleting a password because a container went away would be indefensible.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/lib/vault/credentials.test.ts`
Expected: FAIL — `prisma.credential` is undefined.

- [ ] **Step 3: Write minimal implementation**

```prisma
// append to web/prisma/schema.prisma

model Credential {
  id        String   @id @default(uuid())
  label     String
  username  String
  // AES-256-GCM envelope, AAD-bound to `credential:<id>:secret`.
  // There is deliberately no plaintext column anywhere in this model.
  secretSealed String
  notes     String?

  // A LOOSE link, not a foreign key. Systems are discovered and can vanish
  // when a container stops; a credential must survive that and re-attach if
  // the system returns. A relation with a cascade would delete passwords
  // because a container went away.
  hostId    String?
  systemKey String?

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  rotatedAt DateTime?

  accesses  CredentialAccess[]

  @@index([hostId, systemKey])
}

model VaultConfig {
  id                  String @id @default("singleton")
  kdfParams           String
  verifier            String
  wrappedByPassphrase String
  wrappedByRecovery   String
  createdAt           DateTime @default(now())
  updatedAt           DateTime @updatedAt
}

model CredentialAccess {
  id           String   @id @default(uuid())
  credentialId String
  credential   Credential @relation(fields: [credentialId], references: [id], onDelete: Cascade)
  action       String
  at           DateTime @default(now())

  @@index([credentialId, at])
}
```

`VaultConfig.id` defaults to the literal `"singleton"` and is the primary key, so a second row collides on the primary key. That is the single-row guarantee — no partial index needed, and it cannot be bypassed by a caller supplying a different id, because the application never supplies one.

- [ ] **Step 4: Run test to verify it passes**

```bash
cd web
export DATABASE_URL="postgresql://postgres:devpass@127.0.0.1:5434/bevops?schema=public"
npx prisma migrate dev --name credential_vault
npx vitest run src/lib/vault/credentials.test.ts
```
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add web/prisma web/src/lib/vault/credentials.test.ts
git commit -m "feat(vault): credentials that outlive the systems they describe"
```

---

### Task 2: Key derivation and verifier

**Files:**
- Create: `web/src/lib/vault/kdf.ts`, `web/src/lib/vault/kdf.test.ts`

**Interfaces:**
- Consumes: `seal`, `open` from `../crypto/envelope.js`.
- Produces:
  - `type KdfParams = { N: number; r: number; p: number; saltB64: string }`
  - `newKdfParams(): KdfParams`
  - `deriveWrappingKey(passphrase: string, params: KdfParams): Buffer` — 32 bytes
  - `makeVerifier(wrappingKey: Buffer): string`
  - `checkVerifier(wrappingKey: Buffer, verifier: string): boolean`

- [ ] **Step 1: Write the failing test**

```ts
// web/src/lib/vault/kdf.test.ts
import { describe, it, expect } from 'vitest'
import { newKdfParams, deriveWrappingKey, makeVerifier, checkVerifier } from './kdf.js'

describe('kdf', () => {
  it('derives a stable 32-byte key for the same passphrase and params', () => {
    const p = newKdfParams()
    const a = deriveWrappingKey('correct horse battery staple', p)
    const b = deriveWrappingKey('correct horse battery staple', p)
    expect(a.length).toBe(32)
    expect(a.equals(b)).toBe(true)
  })

  it('derives a different key for a different passphrase', () => {
    const p = newKdfParams()
    expect(deriveWrappingKey('one', p).equals(deriveWrappingKey('two', p))).toBe(false)
  })

  it('derives a different key for the same passphrase under a fresh salt', () => {
    const a = deriveWrappingKey('same', newKdfParams())
    const b = deriveWrappingKey('same', newKdfParams())
    expect(a.equals(b)).toBe(false)
  })

  it('accepts the correct passphrase via the verifier', () => {
    const p = newKdfParams()
    const k = deriveWrappingKey('right', p)
    expect(checkVerifier(k, makeVerifier(k))).toBe(true)
  })

  it('REJECTS a wrong passphrase rather than returning garbage', () => {
    const p = newKdfParams()
    const verifier = makeVerifier(deriveWrappingKey('right', p))
    expect(checkVerifier(deriveWrappingKey('wrong', p), verifier)).toBe(false)
  })

  it('does not throw on a malformed verifier', () => {
    const k = deriveWrappingKey('x', newKdfParams())
    expect(checkVerifier(k, 'not-a-verifier')).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/lib/vault/kdf.test.ts`
Expected: FAIL — cannot resolve `./kdf.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// web/src/lib/vault/kdf.ts
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
// scrypt refuses to allocate beyond its default maxmem at these parameters,
// so it must be raised explicitly: 128 * N * r * p, with headroom.
const MAXMEM = 256 * N * R * P

export function newKdfParams(): KdfParams {
  return { N, r: R, p: P, saltB64: randomBytes(16).toString('base64') }
}

export function deriveWrappingKey(passphrase: string, params: KdfParams): Buffer {
  return scryptSync(passphrase, Buffer.from(params.saltB64, 'base64'), KEY_BYTES, {
    N: params.N,
    r: params.r,
    p: params.p,
    maxmem: 256 * params.N * params.r * params.p,
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
  try {
    return open(verifier, VERIFIER_AAD, wrappingKey) === VERIFIER_PLAINTEXT
  } catch {
    return false
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run src/lib/vault/kdf.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/vault/kdf.ts web/src/lib/vault/kdf.test.ts
git commit -m "feat(vault): scrypt key derivation with a clean wrong-passphrase answer"
```

---

### Task 3: Keyring — the vault key and its two wrappings

**Files:**
- Create: `web/src/lib/vault/keyring.ts`, `web/src/lib/vault/keyring.test.ts`

**Interfaces:**
- Consumes: `seal`, `open`; `KdfParams`, `deriveWrappingKey`, `makeVerifier`.
- Produces:
  - `newVaultKey(): Buffer` — 32 random bytes
  - `newRecoveryKey(): { display: string; key: Buffer }`
  - `wrapVaultKey(vaultKey: Buffer, wrappingKey: Buffer, kind: 'passphrase' | 'recovery'): string`
  - `unwrapVaultKey(wrapped: string, wrappingKey: Buffer, kind: 'passphrase' | 'recovery'): Buffer`
  - `recoveryKeyFromDisplay(display: string): Buffer`

- [ ] **Step 1: Write the failing test**

```ts
// web/src/lib/vault/keyring.test.ts
import { describe, it, expect } from 'vitest'
import { randomBytes } from 'node:crypto'
import { newVaultKey, newRecoveryKey, wrapVaultKey, unwrapVaultKey, recoveryKeyFromDisplay } from './keyring.js'

describe('keyring', () => {
  it('round-trips the vault key through the passphrase wrapping', () => {
    const vk = newVaultKey(); const wk = randomBytes(32)
    expect(unwrapVaultKey(wrapVaultKey(vk, wk, 'passphrase'), wk, 'passphrase').equals(vk)).toBe(true)
  })

  it('round-trips the vault key through the recovery wrapping', () => {
    const vk = newVaultKey(); const rk = newRecoveryKey()
    expect(unwrapVaultKey(wrapVaultKey(vk, rk.key, 'recovery'), rk.key, 'recovery').equals(vk)).toBe(true)
  })

  it('REFUSES to open a passphrase wrapping as a recovery wrapping', () => {
    const vk = newVaultKey(); const wk = randomBytes(32)
    const wrapped = wrapVaultKey(vk, wk, 'passphrase')
    expect(() => unwrapVaultKey(wrapped, wk, 'recovery')).toThrow()
  })

  it('REFUSES the wrong wrapping key', () => {
    const vk = newVaultKey()
    const wrapped = wrapVaultKey(vk, randomBytes(32), 'passphrase')
    expect(() => unwrapVaultKey(wrapped, randomBytes(32), 'passphrase')).toThrow()
  })

  it('recovers the same key bytes from its printed form', () => {
    const rk = newRecoveryKey()
    expect(recoveryKeyFromDisplay(rk.display).equals(rk.key)).toBe(true)
  })

  it('REJECTS a malformed printed recovery key rather than deriving something', () => {
    expect(() => recoveryKeyFromDisplay('not a recovery key')).toThrow()
  })

  it('produces a different vault key every time', () => {
    expect(newVaultKey().equals(newVaultKey())).toBe(false)
  })
})
```

The third test is the one that matters most: distinct AADs are what stop a wrapping being replayed as the other kind.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/lib/vault/keyring.test.ts`
Expected: FAIL — cannot resolve `./keyring.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// web/src/lib/vault/keyring.ts
import { randomBytes } from 'node:crypto'
import { seal, open } from '../crypto/envelope.js'

const KEY_BYTES = 32

export function newVaultKey(): Buffer {
  return randomBytes(KEY_BYTES)
}

// Printed in groups so a human can copy it off paper without losing their
// place. The groups are cosmetic and stripped on the way back in.
export function newRecoveryKey(): { display: string; key: Buffer } {
  const key = randomBytes(KEY_BYTES)
  const raw = key.toString('base64url')
  const display = (raw.match(/.{1,8}/g) ?? []).join('-')
  return { display, key }
}

export function recoveryKeyFromDisplay(display: string): Buffer {
  const key = Buffer.from(display.replace(/-/g, '').trim(), 'base64url')
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run src/lib/vault/keyring.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/vault/keyring.ts web/src/lib/vault/keyring.test.ts
git commit -m "feat(vault): vault key wrapped by passphrase and recovery key"
```

---

### Task 4: The lock

**Files:**
- Create: `web/src/lib/vault/session.ts`, `web/src/lib/vault/session.test.ts`

**Interfaces:**
- Produces:
  - `unlockSession(vaultKey: Buffer, now?: () => Date, ttlMs?: number): void`
  - `currentVaultKey(now?: () => Date): Buffer | null`
  - `lockSession(): void`
  - `isUnlocked(now?: () => Date): boolean`
  - `DEFAULT_TTL_MS = 900_000`

- [ ] **Step 1: Write the failing test**

```ts
// web/src/lib/vault/session.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { randomBytes } from 'node:crypto'
import { unlockSession, currentVaultKey, lockSession, isUnlocked, DEFAULT_TTL_MS } from './session.js'

const at = (ms: number) => () => new Date(ms)

beforeEach(() => lockSession())

describe('vault session', () => {
  it('starts locked', () => {
    expect(isUnlocked()).toBe(false)
    expect(currentVaultKey()).toBeNull()
  })

  it('returns the key while unlocked', () => {
    const vk = randomBytes(32)
    unlockSession(vk, at(1000))
    expect(currentVaultKey(at(1000))?.equals(vk)).toBe(true)
  })

  it('LOCKS ITSELF once the window expires', () => {
    unlockSession(randomBytes(32), at(1000))
    expect(currentVaultKey(at(1000 + DEFAULT_TTL_MS + 1))).toBeNull()
    expect(isUnlocked(at(1000 + DEFAULT_TTL_MS + 1))).toBe(false)
  })

  it('is still unlocked exactly AT the boundary, not past it', () => {
    unlockSession(randomBytes(32), at(1000))
    expect(currentVaultKey(at(1000 + DEFAULT_TTL_MS))).not.toBeNull()
  })

  it('locks on demand', () => {
    unlockSession(randomBytes(32), at(1000))
    lockSession()
    expect(currentVaultKey(at(1000))).toBeNull()
  })

  it('forgets the key on lock rather than merely flagging it locked', () => {
    const vk = randomBytes(32)
    unlockSession(vk, at(1000))
    lockSession()
    unlockSession(randomBytes(32), at(2000))
    expect(currentVaultKey(at(2000))?.equals(vk)).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/lib/vault/session.test.ts`
Expected: FAIL — cannot resolve `./session.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// web/src/lib/vault/session.ts

// The unwrapped vault key lives HERE and nowhere else: not in the database,
// not in a file, not in an environment variable, not in a cookie.
//
// This is correct only while `web` runs as a SINGLE Node process, which it
// does (`next start`, one container). If the deployment ever runs multiple
// workers, an unlock in one worker will not unlock another, and the symptom
// is a vault that appears to re-lock at random. Move this to a shared store
// before scaling out — and note that a shared store means the key leaves
// process memory, which is the property this design is built on.

export const DEFAULT_TTL_MS = 900_000 // 15 minutes

let state: { vaultKey: Buffer; expiresAtMs: number } | null = null

export function unlockSession(
  vaultKey: Buffer,
  now: () => Date = () => new Date(),
  ttlMs: number = DEFAULT_TTL_MS,
): void {
  state = { vaultKey, expiresAtMs: now().getTime() + ttlMs }
}

export function currentVaultKey(now: () => Date = () => new Date()): Buffer | null {
  if (!state) return null
  if (now().getTime() > state.expiresAtMs) {
    lockSession()
    return null
  }
  return state.vaultKey
}

export function isUnlocked(now: () => Date = () => new Date()): boolean {
  return currentVaultKey(now) !== null
}

export function lockSession(): void {
  // Drop the reference outright rather than setting a flag, so nothing can
  // read the key back out of a "locked" object.
  state = null
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run src/lib/vault/session.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/vault/session.ts web/src/lib/vault/session.test.ts
git commit -m "feat(vault): in-memory lock that expires and forgets"
```

---

### Task 5: Vault lifecycle — create, unlock, change passphrase

**Files:**
- Create: `web/src/lib/vault/vault.ts`, `web/src/lib/vault/vault.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–4, plus `prisma`.
- Produces:
  - `createVault(passphrase: string): Promise<{ recoveryKey: string }>`
  - `isInitialised(): Promise<boolean>`
  - `unlockWithPassphrase(passphrase: string): Promise<boolean>`
  - `unlockWithRecoveryKey(display: string): Promise<boolean>`
  - `changePassphrase(current: string, next: string): Promise<boolean>`

- [ ] **Step 1: Write the failing test**

```ts
// web/src/lib/vault/vault.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { prisma } from '../db.js'
import { lockSession, isUnlocked, currentVaultKey } from './session.js'
import { createVault, isInitialised, unlockWithPassphrase, unlockWithRecoveryKey, changePassphrase } from './vault.js'

beforeEach(async () => {
  lockSession()
  await prisma.credentialAccess.deleteMany()
  await prisma.credential.deleteMany()
  await prisma.vaultConfig.deleteMany()
})

describe('vault lifecycle', () => {
  it('reports uninitialised before creation', async () => {
    expect(await isInitialised()).toBe(false)
  })

  it('creates a vault and returns a recovery key exactly once', async () => {
    const { recoveryKey } = await createVault('right passphrase')
    expect(recoveryKey.length).toBeGreaterThan(20)
    expect(await isInitialised()).toBe(true)
  })

  it('REFUSES to create a second vault over an existing one', async () => {
    await createVault('first')
    await expect(createVault('second')).rejects.toThrow()
  })

  it('unlocks with the right passphrase', async () => {
    await createVault('right'); lockSession()
    expect(await unlockWithPassphrase('right')).toBe(true)
    expect(isUnlocked()).toBe(true)
  })

  it('REFUSES the wrong passphrase and stays locked', async () => {
    await createVault('right'); lockSession()
    expect(await unlockWithPassphrase('wrong')).toBe(false)
    expect(isUnlocked()).toBe(false)
  })

  it('unlocks with the recovery key', async () => {
    const { recoveryKey } = await createVault('right'); lockSession()
    expect(await unlockWithRecoveryKey(recoveryKey)).toBe(true)
  })

  it('REFUSES a wrong recovery key and stays locked', async () => {
    await createVault('right'); lockSession()
    expect(await unlockWithRecoveryKey('AAAAAAAA-BBBBBBBB-CCCCCCCC-DDDDDDDD-EEEEEEEE-FFFFFFFF')).toBe(false)
    expect(isUnlocked()).toBe(false)
  })

  it('changes the passphrase and yields the SAME vault key', async () => {
    await createVault('old')
    await unlockWithPassphrase('old')
    const before = currentVaultKey()?.toString('base64')
    expect(await changePassphrase('old', 'new')).toBe(true)
    lockSession()
    expect(await unlockWithPassphrase('new')).toBe(true)
    expect(currentVaultKey()?.toString('base64')).toBe(before)
  })

  it('REFUSES to change the passphrase with the wrong current one', async () => {
    await createVault('old')
    expect(await changePassphrase('not-old', 'new')).toBe(false)
    lockSession()
    expect(await unlockWithPassphrase('old')).toBe(true)
  })

  it('leaves the RECOVERY key working after a passphrase change', async () => {
    const { recoveryKey } = await createVault('old')
    await changePassphrase('old', 'new')
    lockSession()
    expect(await unlockWithRecoveryKey(recoveryKey)).toBe(true)
  })
})
```

The last test guards the property that makes a printed recovery key worth having: it must survive a passphrase change, or the paper in the drawer silently becomes wrong.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/lib/vault/vault.test.ts`
Expected: FAIL — cannot resolve `./vault.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// web/src/lib/vault/vault.ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run src/lib/vault/vault.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/vault/vault.ts web/src/lib/vault/vault.test.ts
git commit -m "feat(vault): create, unlock, and re-wrap on passphrase change"
```

---

### Task 6: Credentials — store, list, reveal, audit

**Files:**
- Create: `web/src/lib/vault/credentials.ts`
- Modify: `web/src/lib/vault/credentials.test.ts` (extend the schema tests from Task 1)

**Interfaces:**
- Produces:
  - `type CredentialSummary = { id: string; label: string; username: string; notes: string | null; hostId: string | null; systemKey: string | null; rotatedAt: Date | null }` — **contains no secret field of any kind**
  - `addCredential(input: { label: string; username: string; secret: string; notes?: string; hostId?: string; systemKey?: string }): Promise<string>`
  - `listCredentials(): Promise<CredentialSummary[]>`
  - `credentialsForSystem(hostId: string, systemKey: string): Promise<CredentialSummary[]>`
  - `revealCredential(id: string): Promise<string>`
  - `removeCredential(id: string): Promise<void>`

- [ ] **Step 1: Write the failing test**

```ts
// append to web/src/lib/vault/credentials.test.ts
import { lockSession } from './session.js'
import { createVault, unlockWithPassphrase } from './vault.js'
import { addCredential, listCredentials, revealCredential, credentialsForSystem, removeCredential } from './credentials.js'

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
    const host = await prisma.host.create({ data: { name: 'host-a' } })
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
})
```

The moved-ciphertext test is the one proving AAD binding actually works end to end, not just in the envelope's own unit tests.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/lib/vault/credentials.test.ts`
Expected: FAIL — cannot resolve `./credentials.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// web/src/lib/vault/credentials.ts
import { prisma } from '../db.js'
import { seal, open } from '../crypto/envelope.js'
import { currentVaultKey } from './session.js'

export type CredentialSummary = {
  id: string
  label: string
  username: string
  notes: string | null
  hostId: string | null
  systemKey: string | null
  rotatedAt: Date | null
}

const SUMMARY = {
  id: true, label: true, username: true, notes: true,
  hostId: true, systemKey: true, rotatedAt: true,
} as const

const aadFor = (id: string): string => `credential:${id}:secret`

function requireKey(): Buffer {
  const key = currentVaultKey()
  // A locked vault must fail loudly. Returning an empty string here would let
  // a caller render a blank field, which reads as "no credential stored" —
  // a different and false fact.
  if (!key) throw new Error('vault is locked')
  return key
}

export async function addCredential(input: {
  label: string; username: string; secret: string
  notes?: string; hostId?: string; systemKey?: string
}): Promise<string> {
  const key = requireKey()
  // The id must exist before sealing, because it is part of the AAD.
  const row = await prisma.credential.create({
    data: {
      label: input.label, username: input.username, secretSealed: 'pending',
      notes: input.notes ?? null, hostId: input.hostId ?? null, systemKey: input.systemKey ?? null,
    },
    select: { id: true },
  })
  await prisma.credential.update({
    where: { id: row.id },
    data: { secretSealed: seal(input.secret, aadFor(row.id), key) },
  })
  await prisma.credentialAccess.create({ data: { credentialId: row.id, action: 'create' } })
  return row.id
}

export async function listCredentials(): Promise<CredentialSummary[]> {
  // `select` is exhaustive on purpose: it is what guarantees no sealed secret
  // can reach a caller by someone later adding a field to the model.
  return prisma.credential.findMany({ select: SUMMARY, orderBy: { label: 'asc' } })
}

export async function credentialsForSystem(hostId: string, systemKey: string): Promise<CredentialSummary[]> {
  return prisma.credential.findMany({ where: { hostId, systemKey }, select: SUMMARY, orderBy: { label: 'asc' } })
}

export async function revealCredential(id: string): Promise<string> {
  const key = requireKey()
  const row = await prisma.credential.findUniqueOrThrow({ where: { id }, select: { id: true, secretSealed: true } })
  const secret = open(row.secretSealed, aadFor(row.id), key)
  await prisma.credentialAccess.create({ data: { credentialId: id, action: 'reveal' } })
  return secret
}

export async function removeCredential(id: string): Promise<void> {
  await prisma.credential.delete({ where: { id } })
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run src/lib/vault/credentials.test.ts`
Expected: PASS, 12 tests (3 from Task 1, 9 new).

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/vault/credentials.ts web/src/lib/vault/credentials.test.ts
git commit -m "feat(vault): store, reveal and audit credentials"
```

---

### Task 7: Server actions — the app's first write path

**Files:**
- Create: `web/src/app/vault/actions.ts`, `web/src/app/vault/actions.test.ts`

**Interfaces:**
- Produces server actions: `createVaultAction`, `unlockAction`, `lockAction`, `addCredentialAction`, `revealAction`, `removeCredentialAction`, each returning a plain result object, never throwing to the client.

- [ ] **Step 1: Write the failing test**

```ts
// web/src/app/vault/actions.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { prisma } from '../../lib/db.js'
import { lockSession } from '../../lib/vault/session.js'
import { createVaultAction, unlockAction, addCredentialAction, revealAction } from './actions.js'

beforeEach(async () => {
  lockSession()
  await prisma.credentialAccess.deleteMany()
  await prisma.credential.deleteMany()
  await prisma.vaultConfig.deleteMany()
})

describe('vault actions', () => {
  it('creates a vault and returns the recovery key once', async () => {
    const r = await createVaultAction('right passphrase')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.recoveryKey.length).toBeGreaterThan(20)
  })

  it('returns a plain failure for a wrong passphrase, never a thrown error', async () => {
    await createVaultAction('right'); lockSession()
    const r = await unlockAction('wrong')
    expect(r.ok).toBe(false)
  })

  it('does not leak the passphrase or secret in a failure message', async () => {
    await createVaultAction('right'); lockSession()
    const r = await unlockAction('my-secret-passphrase')
    expect(JSON.stringify(r)).not.toContain('my-secret-passphrase')
  })

  it('refuses to reveal while locked, without throwing at the client', async () => {
    await createVaultAction('right')
    const add = await addCredentialAction({ label: 'a', username: 'u', secret: 'hunter2' })
    expect(add.ok).toBe(true)
    lockSession()
    const r = await revealAction(add.ok ? add.id : '')
    expect(r.ok).toBe(false)
    expect(JSON.stringify(r)).not.toContain('hunter2')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/app/vault/actions.test.ts`
Expected: FAIL — cannot resolve `./actions.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// web/src/app/vault/actions.ts
'use server'

import { createVault, unlockWithPassphrase, unlockWithRecoveryKey, isInitialised } from '../../lib/vault/vault.js'
import { lockSession } from '../../lib/vault/session.js'
import { addCredential, revealCredential, removeCredential } from '../../lib/vault/credentials.js'
import { revalidatePath } from 'next/cache'

// Every action returns a plain result. Nothing throws to the client, and no
// failure message ever carries the value that failed — error strings are
// where secrets escape.
type Ok<T> = { ok: true } & T
type Err = { ok: false; message: string }

const failed = (message: string): Err => ({ ok: false, message })

export async function createVaultAction(passphrase: string): Promise<Ok<{ recoveryKey: string }> | Err> {
  if (passphrase.length < 12) return failed('Passphrase must be at least 12 characters.')
  if (await isInitialised()) return failed('A vault already exists on this dashboard.')
  const { recoveryKey } = await createVault(passphrase)
  revalidatePath('/vault')
  return { ok: true, recoveryKey }
}

export async function unlockAction(passphrase: string): Promise<Ok<Record<string, never>> | Err> {
  const ok = await unlockWithPassphrase(passphrase)
  if (!ok) return failed('That passphrase did not unlock the vault.')
  revalidatePath('/vault')
  return { ok: true }
}

export async function unlockWithRecoveryAction(display: string): Promise<Ok<Record<string, never>> | Err> {
  const ok = await unlockWithRecoveryKey(display)
  if (!ok) return failed('That recovery key did not unlock the vault.')
  revalidatePath('/vault')
  return { ok: true }
}

export async function lockAction(): Promise<Ok<Record<string, never>>> {
  lockSession()
  revalidatePath('/vault')
  return { ok: true }
}

export async function addCredentialAction(input: {
  label: string; username: string; secret: string
  notes?: string; hostId?: string; systemKey?: string
}): Promise<Ok<{ id: string }> | Err> {
  try {
    const id = await addCredential(input)
    revalidatePath('/vault')
    return { ok: true, id }
  } catch {
    return failed('Could not save the credential. The vault may be locked.')
  }
}

export async function revealAction(id: string): Promise<Ok<{ secret: string }> | Err> {
  try {
    return { ok: true, secret: await revealCredential(id) }
  } catch {
    return failed('Could not reveal this credential. Unlock the vault and try again.')
  }
}

export async function removeCredentialAction(id: string): Promise<Ok<Record<string, never>> | Err> {
  try {
    await removeCredential(id)
    revalidatePath('/vault')
    return { ok: true }
  } catch {
    return failed('Could not delete this credential.')
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run src/app/vault/actions.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add web/src/app/vault
git commit -m "feat(vault): server actions that never throw a secret at the client"
```

---

### Task 8: The vault interface

**Files:**
- Create: `web/src/app/vault/page.tsx`, `web/src/components/VaultPanel.tsx`, `web/src/components/VaultPanel.test.tsx`
- Modify: `web/src/components/FleetTable.tsx` (link a system row to its credentials)

**Interfaces:**
- Consumes: `listCredentials`, `isInitialised`, `isUnlocked`, the actions from Task 7.

- [ ] **Step 1: Write the failing test**

```tsx
// web/src/components/VaultPanel.test.tsx
// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { VaultPanel } from './VaultPanel.js'

const cred = (over = {}) => ({
  id: 'c1', label: 'admin', username: 'operator', notes: null,
  hostId: 'h1', systemKey: 'alpha', rotatedAt: null, ...over,
})

describe('VaultPanel', () => {
  it('says the vault is not set up when it is uninitialised', () => {
    render(<VaultPanel initialised={false} unlocked={false} credentials={[]} />)
    expect(screen.getByText(/set up the vault/i)).toBeTruthy()
  })

  it('says LOCKED rather than showing empty fields', () => {
    render(<VaultPanel initialised unlocked={false} credentials={[cred()]} />)
    expect(screen.getByText(/locked/i)).toBeTruthy()
    // An empty field would read as "no credential stored", a different fact.
    expect(screen.queryByText('—')).toBeNull()
  })

  it('never renders a secret into the page before it is asked for', () => {
    const { container } = render(<VaultPanel initialised unlocked credentials={[cred()]} />)
    expect(container.innerHTML).not.toContain('hunter2')
  })

  it('shows unattached credentials, clearly labelled, rather than hiding them', () => {
    render(<VaultPanel initialised unlocked credentials={[cred({ hostId: null, systemKey: null })]} />)
    expect(screen.getByText(/not attached to a system/i)).toBeTruthy()
  })

  it('renders an empty state rather than an empty list', () => {
    render(<VaultPanel initialised unlocked credentials={[]} />)
    expect(screen.getByText(/no credentials stored yet/i)).toBeTruthy()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/components/VaultPanel.test.tsx`
Expected: FAIL — cannot resolve `./VaultPanel.js`.

- [ ] **Step 3: Write minimal implementation**

Build `VaultPanel` as a client component taking `{ initialised: boolean; unlocked: boolean; credentials: CredentialSummary[] }`. Required behaviour:

- **Uninitialised:** a single call to action — "Set up the vault" — with a passphrase field, and after creation the recovery key shown **once**, with copy-to-clipboard and the explicit instruction to store it off this machine.
- **Locked:** the word *Locked*, an unlock field, and an option to unlock with the recovery key instead. Credential labels may be listed; **no fields, no dashes** — a dash reads as "not known", which is not what locked means.
- **Unlocked:** credentials grouped by system, unattached ones last under a heading saying so. Each row has a **Reveal** control; the secret is fetched by the action on click and shown transiently with copy-to-clipboard. Nothing renders a secret until asked.
- A **Lock now** control, always available when unlocked.

Style through the existing custom properties in `web/src/app/globals.css` — no hardcoded colours, and it must read correctly in both themes.

In `FleetTable.tsx`, add a link on each system row to `/vault?host=<hostId>&system=<systemKey>`. A system with no credentials must still link, landing on a page that offers to add one — never a dead control.

`web/src/app/vault/page.tsx` is a server component: `export const dynamic = 'force-dynamic'`, reads `isInitialised()`, `isUnlocked()` and `listCredentials()`, and passes them down.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run src/components/VaultPanel.test.tsx`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add web/src/app/vault web/src/components/VaultPanel.tsx web/src/components/VaultPanel.test.tsx web/src/components/FleetTable.tsx
git commit -m "feat(vault): the vault interface, and a way in from the board"
```

---

### Task 9: Deploy and verify live

**Files:**
- Modify: `deploy/README.md` (vault section)
- Test: live verification, recorded below

- [ ] **Step 1: Write the failing check**

```bash
# deploy/verify-vault.sh — every line must PASS before this task is done.
set -u
fail=0
check() { if eval "$2"; then echo "PASS  $1"; else echo "FAIL  $1"; fi; }

check "vault page answers on loopback"      '[ "$(curl -s -o /dev/null -w %{http_code} http://127.0.0.1:3000/vault)" = 200 ]'
check "no secret in the page while locked"  '! curl -s http://127.0.0.1:3000/vault | grep -qiE "secretSealed|v1:[A-Za-z0-9+/=]+:"'
check "vault page is NOT publicly reachable" '! curl -s -m 5 -o /dev/null "http://$(curl -s ifconfig.me):3000/vault"'
exit $fail
```

- [ ] **Step 2: Run it to verify it fails**

Run on the dashboard host before deploying: `bash deploy/verify-vault.sh`
Expected: the first check FAILs — `/vault` does not exist yet.

- [ ] **Step 3: Deploy**

Migrations run as their own step, never in an entrypoint — `web` and `ingest` share one image and would otherwise race:

> **This block was wrong and is corrected below. `deploy/README.md` is the
> runbook of record — prefer it to this plan.** The original ordering ran
> `migrate deploy` *before* `docker compose pull`. Migrations are baked into
> the image, and compose's `run` pull policy is `missing` with `TAG=latest`
> already cached, so the migrate step executed inside the **old** image,
> printed "No pending migrations", exited 0 — and the pull then landed new
> code on an old schema. The vault page selects a column that would not
> exist, and being `force-dynamic` with no error boundary, it 500s on every
> request while the verify script blames the application rather than the
> schema. Pull first.

```bash
cd /opt/bevora-ops && git fetch origin && git reset --hard origin/main
export GHCR_OWNER=<owner> TAG=latest INGEST_BIND_ADDR=<this host's private address>
docker compose pull web ingest
docker compose run --rm --pull always web /deploy/with-database-url.sh \
  npx prisma migrate deploy --schema web/prisma/schema.prisma
docker compose up -d web ingest
```

Then document in `deploy/README.md`: creating the vault, and — stated plainly — that the recovery key must be **printed and stored off the machine**. Saving it to a synced folder puts a copy of the key next to nothing it protects and quietly undoes the encryption.

- [ ] **Step 4: Run it to verify it passes**

```bash
bash deploy/verify-vault.sh          # expect PASS on all three
```

Then prove the lock actually locks, on the live deployment: unlock the vault, reveal one credential, restart the `web` container, and confirm the vault reports **Locked** again and refuses to reveal without the passphrase. A lock that survives a restart is not a lock.

- [ ] **Step 5: Commit**

```bash
git add deploy/verify-vault.sh deploy/README.md
git commit -m "feat(deploy): vault verification and runbook"
```

---

## Self-Review

**Spec coverage.** §4.1 recovery key — Tasks 3, 5. §4.2 one model for any credential type — Task 1. §4.3 credentials outlive systems — Task 1 (loose link, tested). §4.4 reveal is the audited event — Task 6. §5 key handling, double wrapping, verifier, AAD binding — Tasks 2, 3, 5, 6. §6 locking, restart, 15-minute expiry — Tasks 4, 9. §7 data model incl. single-row `VaultConfig` — Task 1. §8 interface, locked ≠ empty, unattached shown — Task 8. §9 failure modes — Tasks 2 (wrong passphrase), 5 (uninitialised), 6 (per-credential failure), 7 (no secrets in errors). §10 testing — throughout.

**Known gaps, deliberate:** automated reset into applications is out of scope per spec §11. Per-credential decryption failure degrading only that entry is implemented by `revealCredential` throwing per call, but has no dedicated test — the moved-ciphertext test in Task 6 covers the same path.

**Type consistency.** `KdfParams` is defined in Task 2 and consumed in Task 5. `wrapVaultKey`/`unwrapVaultKey` take `kind: 'passphrase' | 'recovery'` in Task 3 and are called with those literals in Task 5. `CredentialSummary` is defined in Task 6 and consumed in Task 8. `currentVaultKey()` returns `Buffer | null` in Task 4 and is null-checked in Task 6's `requireKey`.
