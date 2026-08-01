# Slice 1 — Read-Only Fleet Board Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A page listing every system on the monitored host with its live health, deployed version, deploy time, latest change description, and drift — fed by an agent that discovers systems rather than being told about them.

**Architecture:** Three workspaces. `shared/` holds Zod schemas describing the agent↔dashboard wire format, so both sides validate against one definition. `agent/` runs as a systemd service on the monitored host, discovers systems from the container runtime, reads deploy logs and git checkouts, and **dials out** over a WebSocket to the dashboard. `web/` is a Next.js 15 app on the new droplet that authenticates agents, persists snapshots to Postgres, and renders the board.

**Tech Stack:** Node 22, TypeScript (strict), npm workspaces, Zod, dockerode, `ws`, Next.js 15 (App Router) + React 19, Prisma 6 + Postgres 16, Vitest, Playwright.

## Global Constraints

Every task's requirements implicitly include this section.

- **Node 22.** Not 26 — jsdom and esbuild break there. Use `/opt/homebrew/opt/node@22/bin` on the Mac.
- **TypeScript strict.** No `any` in committed code; no `@ts-ignore` without a comment naming the reason.
- **No environment data in the repo, from commit #1.** No IP addresses, no hostnames or domains, no names of monitored systems — in code, tests, fixtures, comments, or docs. Git history is permanent; this cannot be cleaned up later. Task 1 makes it a blocking CI gate.
- **Discovery, not enumeration.** No hand-maintained list of systems anywhere. If a design needs one, it is the wrong design.
- **`unknown` is never rendered as healthy.** Missing, stale, or unparseable data renders as its own state.
- **Slice 1 is loopback-only.** The dashboard binds `127.0.0.1`, has no nginx vhost and no DNS. Access is over an SSH tunnel. Authentication ships in slice 3; nothing is publicly exposed before it.
- **Secrets are file-mounted**, never env vars, never logged.
- **Every authz/validation rule gets a test asserting the denial**, not just the happy path.
- **No fake may be more permissive than the real thing it stands in for.**

## File Structure

| Path | Responsibility |
|---|---|
| `package.json`, `tsconfig.base.json` | npm workspaces root, shared compiler options |
| `.github/workflows/ci.yml` | typecheck · lint · test · build · leakage gate · secret scan |
| `scripts/ci/assert-no-environment-leakage.mjs` | blocking disclosure gate |
| `shared/src/wire.ts` | Zod schemas for the agent↔dashboard protocol |
| `agent/src/deploy-log.ts` | deploy-log dialect parsing, with unknown fallback |
| `agent/src/git.ts` | deployed sha, commit subject, drift count |
| `agent/src/docker.ts` | system discovery + container health from the runtime |
| `agent/src/collect.ts` | assembles one `FleetSnapshot` |
| `agent/src/transport.ts` | outbound WebSocket client with backoff |
| `agent/src/main.ts` | entrypoint loop |
| `web/prisma/schema.prisma` | `Host`, `System`, `SystemObservation`, `AgentEnrolment` |
| `web/src/lib/crypto/envelope.ts` | KEK/DEK envelope encryption, AAD-bound |
| `web/src/server/ingest.ts` | WS server: agent auth + snapshot persistence |
| `web/src/lib/staleness.ts` | derives display state incl. stale/unknown |
| `web/src/app/page.tsx`, `web/src/components/FleetTable.tsx` | the board |

---

### Task 1: Repo skeleton and the disclosure gate

The gate comes first because the constraint binds from commit #1 — a leak in the commit that adds the gate is still a leak.

**Files:**
- Create: `package.json`, `tsconfig.base.json`, `.gitignore`, `vitest.config.ts`
- Create: `scripts/ci/assert-no-environment-leakage.mjs`
- Create: `.github/workflows/ci.yml`
- Test: `scripts/ci/leakage.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `scanForLeakage(files: {path: string, content: string}[], patterns: string[]): {path: string, line: number, match: string}[]` — exported from the gate script for testing.

- [ ] **Step 1: Write the failing test**

```ts
// scripts/ci/leakage.test.ts
import { describe, it, expect } from 'vitest'
import { scanForLeakage } from './assert-no-environment-leakage.mjs'

describe('scanForLeakage', () => {
  it('flags a real IPv4 literal', () => { // leak-gate:allow
    const hits = scanForLeakage([{ path: 'a.ts', content: 'const h = "203.0.113.9"\nconst r = "8.8.4.4"' }], []) // leak-gate:allow
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({ path: 'a.ts', line: 2, match: '8.8.4.4' }) // leak-gate:allow
  })

  it('honours an explicit per-line opt-out marker', () => {
    const content = 'const doc = "8.8.4.4" // leak-gate:allow'
    expect(scanForLeakage([{ path: 'a.ts', content }], [])).toEqual([])
  })

  it('allows loopback, unspecified and RFC-5737 documentation ranges', () => {
    const content = '127.0.0.1 0.0.0.0 192.0.2.1 198.51.100.7 203.0.113.4'
    expect(scanForLeakage([{ path: 'a.ts', content }], [])).toEqual([])
  })

  it('does not flag version strings or semver', () => {
    expect(scanForLeakage([{ path: 'a.ts', content: 'v1.2.3 and 10.0.0 alpha' }], [])).toEqual([])
  })

  it('flags a caller-supplied secret pattern', () => {
    const hits = scanForLeakage([{ path: 'doc.md', content: 'runs on widgetco.example' }], ['widgetco\\.example'])
    expect(hits).toHaveLength(1)
    expect(hits[0].match).toBe('widgetco.example')
  })

  it('returns nothing for clean content', () => {
    expect(scanForLeakage([{ path: 'a.ts', content: 'const host = process.env.HOST' }], ['nope'])).toEqual([])
  })
})
```

Note the third case: `10.0.0` inside a version string must not trip the gate, or the gate gets disabled within a week for crying wolf.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run scripts/ci/leakage.test.ts`
Expected: FAIL — `Failed to resolve import "./assert-no-environment-leakage.mjs"`

- [ ] **Step 3: Write minimal implementation**

```js
// scripts/ci/assert-no-environment-leakage.mjs
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

// Only loopback, unspecified, and the RFC-5737 documentation ranges may appear.
const ALLOWED_IP = /^(127\.0\.0\.1|0\.0\.0\.0|192\.0\.2\.\d{1,3}|198\.51\.100\.\d{1,3}|203\.0\.113\.\d{1,3})$/
// Require a non-dot, non-digit boundary so "v1.2.3.4" and "10.0.0" are not IPs.
const IPV4 = /(?<![\w.])(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})(?![\w.])/g

// Documentation and the gate's own tests must be able to show a bad address
// without tripping it. The opt-out is per LINE and greppable, so every use is
// visible in review — never a whole-directory exemption, because docs are
// exactly where environment data tends to leak.
const OPT_OUT = /leak-gate:allow/

export function scanForLeakage(files, patterns) {
  const extra = patterns.filter(Boolean).map((p) => new RegExp(p, 'gi'))
  const hits = []
  for (const { path, content } of files) {
    content.split('\n').forEach((text, i) => {
      if (OPT_OUT.test(text)) return
      for (const m of text.matchAll(IPV4)) {
        const ip = m[1]
        if (ip.split('.').every((o) => Number(o) <= 255) && !ALLOWED_IP.test(ip)) {
          hits.push({ path, line: i + 1, match: ip })
        }
      }
      for (const re of extra) {
        re.lastIndex = 0
        for (const m of text.matchAll(re)) hits.push({ path, line: i + 1, match: m[0] })
      }
    })
  }
  return hits
}

// The denylist of our own domains and system names is supplied by CI secret,
// never committed — otherwise the gate would itself disclose what it protects.
if (import.meta.url === `file://${process.argv[1]}`) {
  const files = execFileSync('git', ['ls-files'], { encoding: 'utf8' })
    .split('\n')
    .filter((f) => f && !f.startsWith('scripts/ci/leakage.test.'))
    .map((path) => ({ path, content: readFileSync(path, 'utf8') }))
  const patterns = (process.env.LEAKAGE_PATTERNS ?? '').split('\n')
  const hits = scanForLeakage(files, patterns)
  if (hits.length) {
    for (const h of hits) console.error(`LEAK ${h.path}:${h.line}  ${h.match}`)
    console.error(`\n${hits.length} disclosure violation(s). This repo is public.`)
    process.exit(1)
  }
  console.log('no environment data disclosed')
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run scripts/ci/leakage.test.ts`
Expected: PASS, 5 tests.

Then prove it trips end-to-end, using an address from the RFC-2544 benchmark range: <!-- leak-gate:allow -->

```bash
printf 'const x = "198.18.0.1"\n' > leak-probe.ts   # leak-gate:allow
git add leak-probe.ts
node scripts/ci/assert-no-environment-leakage.mjs; echo "exit=$?"   # expect exit=1 and a LEAK line
git rm -f --cached leak-probe.ts && rm leak-probe.ts
```

A gate that has never been observed failing is not known to work.

- [ ] **Step 5: Commit**

```bash
git add package.json tsconfig.base.json .gitignore vitest.config.ts scripts/ .github/
git commit -m "ci: block environment disclosure from the first commit"
```

---

### Task 2: Wire schema

**Files:**
- Create: `shared/package.json`, `shared/src/wire.ts`, `shared/src/index.ts`
- Test: `shared/src/wire.test.ts`

**Interfaces:**
- Produces: `HealthState` = `'healthy' | 'degraded' | 'down' | 'unknown'`; `SystemStateSchema`; `FleetSnapshotSchema`; types `SystemState`, `FleetSnapshot`.

- [ ] **Step 1: Write the failing test**

```ts
// shared/src/wire.test.ts
import { describe, it, expect } from 'vitest'
import { FleetSnapshotSchema } from './wire.js'

const system = {
  key: 'proj-a',
  displayName: 'proj-a',
  health: 'healthy',
  containers: { total: 3, running: 3 },
  deployedSha: 'a'.repeat(40),
  deployedSubject: 'fix: something',
  deployedAt: '2026-08-01T10:00:00.000Z',
  driftCommits: 0,
}

describe('FleetSnapshotSchema', () => {
  it('accepts a complete snapshot', () => {
    const r = FleetSnapshotSchema.safeParse({ collectedAt: '2026-08-01T10:00:00.000Z', systems: [system] })
    expect(r.success).toBe(true)
  })

  it('accepts a system with everything unknown', () => {
    const r = FleetSnapshotSchema.safeParse({
      collectedAt: '2026-08-01T10:00:00.000Z',
      systems: [{ key: 'p', displayName: 'p', health: 'unknown', containers: { total: 0, running: 0 },
                  deployedSha: null, deployedSubject: null, deployedAt: null, driftCommits: null }],
    })
    expect(r.success).toBe(true)
  })

  it('rejects an unknown health value', () => {
    const r = FleetSnapshotSchema.safeParse({ collectedAt: '2026-08-01T10:00:00.000Z',
      systems: [{ ...system, health: 'green' }] })
    expect(r.success).toBe(false)
  })

  it('rejects a short sha', () => {
    const r = FleetSnapshotSchema.safeParse({ collectedAt: '2026-08-01T10:00:00.000Z',
      systems: [{ ...system, deployedSha: 'abc' }] })
    expect(r.success).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run shared/src/wire.test.ts`
Expected: FAIL — cannot resolve `./wire.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// shared/src/wire.ts
import { z } from 'zod'

export const HealthStateSchema = z.enum(['healthy', 'degraded', 'down', 'unknown'])
export type HealthState = z.infer<typeof HealthStateSchema>

export const SystemStateSchema = z.object({
  key: z.string().min(1),
  displayName: z.string().min(1),
  health: HealthStateSchema,
  containers: z.object({ total: z.number().int().min(0), running: z.number().int().min(0) }),
  // Null means "not determined", which is distinct from "nothing deployed".
  deployedSha: z.string().regex(/^[0-9a-f]{40}$/).nullable(),
  deployedSubject: z.string().nullable(),
  deployedAt: z.string().datetime().nullable(),
  driftCommits: z.number().int().min(0).nullable(),
})
export type SystemState = z.infer<typeof SystemStateSchema>

export const FleetSnapshotSchema = z.object({
  collectedAt: z.string().datetime(),
  systems: z.array(SystemStateSchema),
})
export type FleetSnapshot = z.infer<typeof FleetSnapshotSchema>
```

```ts
// shared/src/index.ts
export * from './wire.js'
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run shared/src/wire.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add shared/
git commit -m "feat(shared): wire schema for agent snapshots"
```

---

### Task 3: Envelope encryption

**Files:**
- Create: `web/src/lib/crypto/envelope.ts`
- Test: `web/src/lib/crypto/envelope.test.ts`

**Interfaces:**
- Produces: `seal(plaintext: string, aad: string, dek: Buffer): string` returning `v1:<iv b64>:<tag b64>:<ct b64>`; `open(sealed: string, aad: string, dek: Buffer): string`; `unwrapDek(wrapped: string, kek: Buffer): Buffer`.

- [ ] **Step 1: Write the failing test**

```ts
// web/src/lib/crypto/envelope.test.ts
import { describe, it, expect } from 'vitest'
import { randomBytes } from 'node:crypto'
import { seal, open } from './envelope.js'

const dek = randomBytes(32)

describe('envelope', () => {
  it('round-trips under the same AAD', () => {
    const s = seal('super-secret', 'agent_enrolment:7:secret', dek)
    expect(open(s, 'agent_enrolment:7:secret', dek)).toBe('super-secret')
  })

  it('produces a different ciphertext each time (random IV)', () => {
    expect(seal('x', 'a:1:b', dek)).not.toBe(seal('x', 'a:1:b', dek))
  })

  it('refuses a ciphertext moved to a different row', () => {
    const s = seal('super-secret', 'agent_enrolment:7:secret', dek)
    expect(() => open(s, 'agent_enrolment:8:secret', dek)).toThrow()
  })

  it('refuses a tampered ciphertext', () => {
    const s = seal('super-secret', 'a:1:b', dek)
    const parts = s.split(':')
    const ct = Buffer.from(parts[3], 'base64')
    ct[0] ^= 0xff
    parts[3] = ct.toString('base64')
    expect(() => open(parts.join(':'), 'a:1:b', dek)).toThrow()
  })

  it('refuses the wrong key', () => {
    const s = seal('super-secret', 'a:1:b', dek)
    expect(() => open(s, 'a:1:b', randomBytes(32))).toThrow()
  })
})
```

The third case is the one that matters: without AAD binding, a stolen ciphertext can be pasted into another row and silently decrypt.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run web/src/lib/crypto/envelope.test.ts`
Expected: FAIL — cannot resolve `./envelope.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// web/src/lib/crypto/envelope.ts
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

export function open(sealed: string, aad: string, dek: Buffer): string {
  const [version, iv, tag, ct] = sealed.split(':')
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run web/src/lib/crypto/envelope.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/crypto/
git commit -m "feat(crypto): AAD-bound envelope encryption"
```

---

### Task 4: Database schema

**Files:**
- Create: `web/prisma/schema.prisma`, `web/src/lib/db.ts`
- Test: `web/src/lib/db.test.ts`

**Interfaces:**
- Produces: models `Host`, `System`, `SystemObservation`, `AgentEnrolment`; `prisma` client singleton from `web/src/lib/db.ts`.

- [ ] **Step 1: Write the failing test**

```ts
// web/src/lib/db.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { prisma } from './db.js'

beforeEach(async () => {
  await prisma.systemObservation.deleteMany()
  await prisma.system.deleteMany()
  await prisma.agentEnrolment.deleteMany()
  await prisma.host.deleteMany()
})

describe('schema', () => {
  it('stores an observation against a system on a host', async () => {
    const host = await prisma.host.create({ data: { name: 'host-a' } })
    const system = await prisma.system.create({ data: { hostId: host.id, key: 'proj-a', displayName: 'proj-a' } })
    await prisma.systemObservation.create({
      data: { systemId: system.id, health: 'healthy', containersTotal: 3, containersRunning: 3,
              deployedSha: 'a'.repeat(40), deployedSubject: 'fix: x', deployedAt: new Date(), driftCommits: 0 },
    })
    const found = await prisma.system.findFirstOrThrow({
      where: { key: 'proj-a' }, include: { observations: true },
    })
    expect(found.observations[0].health).toBe('healthy')
  })

  it('refuses two systems with the same key on one host', async () => {
    const host = await prisma.host.create({ data: { name: 'host-b' } })
    await prisma.system.create({ data: { hostId: host.id, key: 'dup', displayName: 'dup' } })
    await expect(
      prisma.system.create({ data: { hostId: host.id, key: 'dup', displayName: 'dup' } }),
    ).rejects.toThrow()
  })

  it('allows the same key on two different hosts', async () => {
    const h1 = await prisma.host.create({ data: { name: 'host-c' } })
    const h2 = await prisma.host.create({ data: { name: 'host-d' } })
    await prisma.system.create({ data: { hostId: h1.id, key: 'same', displayName: 'same' } })
    await expect(
      prisma.system.create({ data: { hostId: h2.id, key: 'same', displayName: 'same' } }),
    ).resolves.toBeTruthy()
  })
})
```

The third case pins the expandability rule: system keys are only unique *within* a host, so enrolling a second host never collides.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/lib/db.test.ts`
Expected: FAIL — `@prisma/client` has no `host` model / client not generated.

- [ ] **Step 3: Write minimal implementation**

```prisma
// web/prisma/schema.prisma
generator client { provider = "prisma-client-js" }
datasource db { provider = "postgresql", url = env("DATABASE_URL") }

model Host {
  id         String   @id @default(uuid())
  name       String   @unique
  lastSeenAt DateTime?
  createdAt  DateTime @default(now())
  systems    System[]
  enrolments AgentEnrolment[]
}

model System {
  id           String   @id @default(uuid())
  hostId       String
  host         Host     @relation(fields: [hostId], references: [id], onDelete: Cascade)
  key          String
  displayName  String
  firstSeenAt  DateTime @default(now())
  observations SystemObservation[]

  // Unique per host, not globally: two hosts may each run a system of the
  // same name, and enrolling the second must not collide with the first.
  @@unique([hostId, key])
}

model SystemObservation {
  id                String   @id @default(uuid())
  systemId          String
  system            System   @relation(fields: [systemId], references: [id], onDelete: Cascade)
  observedAt        DateTime @default(now())
  health            String
  containersTotal   Int
  containersRunning Int
  deployedSha       String?
  deployedSubject   String?
  deployedAt        DateTime?
  driftCommits      Int?

  @@index([systemId, observedAt])
}

model AgentEnrolment {
  id           String   @id @default(uuid())
  hostId       String
  host         Host     @relation(fields: [hostId], references: [id], onDelete: Cascade)
  tokenHash    String   @unique
  secretSealed String
  createdAt    DateTime @default(now())
  revokedAt    DateTime?
}
```

```ts
// web/src/lib/db.ts
import { PrismaClient } from '@prisma/client'

const g = globalThis as unknown as { prisma?: PrismaClient }
export const prisma = g.prisma ?? new PrismaClient()
if (process.env.NODE_ENV !== 'production') g.prisma = prisma
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd web
docker run -d --name bevops-testpg -e POSTGRES_PASSWORD=devpass -e POSTGRES_DB=bevops -p 5433:5432 postgres:16
export DATABASE_URL="postgresql://postgres:devpass@127.0.0.1:5433/bevops?schema=public"
npx prisma migrate dev --name init
npx vitest run src/lib/db.test.ts
```
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add web/prisma web/src/lib/db.ts web/src/lib/db.test.ts
git commit -m "feat(db): hosts, systems, observations, agent enrolments"
```

---

### Task 5: Deploy-log parser

The highest-value pure function in the slice. 18 deployers were written by different hands, so this must degrade honestly rather than guess.

**Files:**
- Create: `agent/src/deploy-log.ts`
- Test: `agent/src/deploy-log.test.ts`

**Interfaces:**
- Produces: `parseDeployLog(text: string): DeployOutcome | null` where `DeployOutcome = { status: 'ok' | 'failed' | 'unknown', sha: string | null, at: Date | null }`.

- [ ] **Step 1: Write the failing test**

```ts
// agent/src/deploy-log.test.ts
import { describe, it, expect } from 'vitest'
import { parseDeployLog } from './deploy-log.js'

describe('parseDeployLog', () => {
  it('reads the canonical success line', () => {
    const r = parseDeployLog('2026-08-01T15:42:54Z  === Deploy OK: abc1234 ===')
    expect(r).toMatchObject({ status: 'ok', sha: 'abc1234' })
    expect(r!.at!.toISOString()).toBe('2026-08-01T15:42:54.000Z')
  })

  it('takes the LAST outcome, not the first', () => {
    const text = [
      '2026-08-01T10:00:00Z  === Deploy OK: aaaaaaa ===',
      '2026-08-01T11:00:00Z  BUILD FAILED for bbbbbbb; retry next tick',
    ].join('\n')
    expect(parseDeployLog(text)).toMatchObject({ status: 'failed', sha: 'bbbbbbb' })
  })

  it('recognises a health-check failure as failed', () => {
    const r = parseDeployLog('2026-08-01T11:00:00Z  HEALTH CHECK FAILED for ccccccc after 10 attempts')
    expect(r).toMatchObject({ status: 'failed', sha: 'ccccccc' })
  })

  it('returns unknown for a log in a dialect it does not recognise', () => {
    expect(parseDeployLog('finished ok\nall good')).toMatchObject({ status: 'unknown', sha: null })
  })

  it('returns null for an empty log', () => {
    expect(parseDeployLog('   \n  ')).toBeNull()
  })

  it('does not treat the word "ok" in prose as a successful deploy', () => {
    expect(parseDeployLog('2026-08-01T10:00:00Z  everything looks ok to me')).toMatchObject({ status: 'unknown' })
  })
})
```

The last case is the whole design: a confident wrong answer is worse than an admitted gap.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run agent/src/deploy-log.test.ts`
Expected: FAIL — cannot resolve `./deploy-log.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// agent/src/deploy-log.ts
export type DeployOutcome = {
  status: 'ok' | 'failed' | 'unknown'
  sha: string | null
  at: Date | null
}

const TS = /(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)/
// Deliberately narrow: only the explicit success banner counts as success.
const OK = /===\s*Deploy OK:\s*([0-9a-f]{7,40})\s*===/i
const FAILED = /(?:BUILD FAILED|HEALTH CHECK FAILED)\s+for\s+([0-9a-f]{7,40})/i

export function parseDeployLog(text: string): DeployOutcome | null {
  const lines = text.split('\n').filter((l) => l.trim())
  if (lines.length === 0) return null

  // Scan backwards: the newest outcome wins.
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    const at = TS.exec(line)?.[1] ? new Date(TS.exec(line)![1]) : null
    const ok = OK.exec(line)
    if (ok) return { status: 'ok', sha: ok[1], at }
    const failed = FAILED.exec(line)
    if (failed) return { status: 'failed', sha: failed[1], at }
  }
  // Non-empty but in no dialect we know. Say so rather than assume health.
  return { status: 'unknown', sha: null, at: null }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run agent/src/deploy-log.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add agent/src/deploy-log.ts agent/src/deploy-log.test.ts
git commit -m "feat(agent): deploy-log parsing that admits when it cannot tell"
```

---

### Task 6: Git state reader

**Files:**
- Create: `agent/src/git.ts`
- Test: `agent/src/git.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `readGitState(repoDir: string, deployedSha: string | null): Promise<GitState>` where `GitState = { deployedSha: string | null, subject: string | null, deployedAt: Date | null, driftCommits: number | null }`.

- [ ] **Step 1: Write the failing test**

```ts
// agent/src/git.test.ts
import { describe, it, expect, beforeAll } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { readGitState } from './git.js'

let repo: string
let firstSha: string

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'gitstate-'))
  const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' }).trim()
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 't@example.com')
  git('config', 'user.name', 'T')
  writeFileSync(join(repo, 'a.txt'), '1')
  git('add', '-A'); git('commit', '-q', '-m', 'feat: the first thing')
  firstSha = git('rev-parse', 'HEAD')
  writeFileSync(join(repo, 'a.txt'), '2')
  git('add', '-A'); git('commit', '-q', '-m', 'feat: the second thing')
})

describe('readGitState', () => {
  it('resolves the subject and timestamp of the deployed sha', async () => {
    const s = await readGitState(repo, firstSha)
    expect(s.subject).toBe('feat: the first thing')
    expect(s.deployedSha).toBe(firstSha)
    expect(s.deployedAt).toBeInstanceOf(Date)
  })

  it('counts drift between the deployed sha and HEAD', async () => {
    const s = await readGitState(repo, firstSha)
    expect(s.driftCommits).toBe(1)
  })

  it('reports zero drift when the deployed sha is HEAD', async () => {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim()
    expect((await readGitState(repo, head)).driftCommits).toBe(0)
  })

  it('returns nulls rather than throwing for an unknown sha', async () => {
    const s = await readGitState(repo, 'f'.repeat(40))
    expect(s).toMatchObject({ subject: null, driftCommits: null })
  })

  it('returns nulls rather than throwing for a directory that is not a repo', async () => {
    const s = await readGitState(tmpdir(), 'a'.repeat(40))
    expect(s).toMatchObject({ subject: null, driftCommits: null })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run agent/src/git.test.ts`
Expected: FAIL — cannot resolve `./git.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// agent/src/git.ts
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile)

export type GitState = {
  deployedSha: string | null
  subject: string | null
  deployedAt: Date | null
  driftCommits: number | null
}

async function git(repoDir: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await exec('git', args, { cwd: repoDir, timeout: 10_000 })
    return stdout.trim()
  } catch {
    // A missing repo, an unknown sha or a git that is simply absent all mean
    // the same thing to a caller: we could not determine this. Never throw —
    // one unreadable repo must not take down collection for every system.
    return null
  }
}

export async function readGitState(repoDir: string, deployedSha: string | null): Promise<GitState> {
  if (!deployedSha) return { deployedSha: null, subject: null, deployedAt: null, driftCommits: null }

  const full = await git(repoDir, ['rev-parse', '--verify', `${deployedSha}^{commit}`])
  if (!full) return { deployedSha, subject: null, deployedAt: null, driftCommits: null }

  const subject = await git(repoDir, ['log', '-1', '--format=%s', full])
  const iso = await git(repoDir, ['log', '-1', '--format=%cI', full])
  const count = await git(repoDir, ['rev-list', '--count', `${full}..HEAD`])

  return {
    deployedSha: full,
    subject: subject || null,
    deployedAt: iso ? new Date(iso) : null,
    driftCommits: count === null ? null : Number(count),
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run agent/src/git.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add agent/src/git.ts agent/src/git.test.ts
git commit -m "feat(agent): resolve deployed sha to subject, time and drift"
```

---

### Task 7: System discovery from the container runtime

**Files:**
- Create: `agent/src/docker.ts`
- Test: `agent/src/docker.test.ts`

**Interfaces:**
- Consumes: `HealthState` from `shared`.
- Produces: `discoverSystems(list: ContainerSummary[]): DiscoveredSystem[]` where `ContainerSummary = { names: string[], project: string | null, state: string, health: string | null }` and `DiscoveredSystem = { key: string, displayName: string, health: HealthState, containers: { total: number, running: number } }`.

Discovery takes an already-fetched container list so it is a pure function and testable without a Docker daemon.

- [ ] **Step 1: Write the failing test**

```ts
// agent/src/docker.test.ts
import { describe, it, expect } from 'vitest'
import { discoverSystems } from './docker.js'

const c = (project: string | null, state: string, health: string | null = null) =>
  ({ names: ['/x'], project, state, health })

describe('discoverSystems', () => {
  it('groups containers by compose project', () => {
    const out = discoverSystems([c('alpha', 'running'), c('alpha', 'running'), c('beta', 'running')])
    expect(out.map((s) => s.key).sort()).toEqual(['alpha', 'beta'])
    expect(out.find((s) => s.key === 'alpha')!.containers).toEqual({ total: 2, running: 2 })
  })

  it('is healthy only when every container runs and none is unhealthy', () => {
    expect(discoverSystems([c('a', 'running', 'healthy'), c('a', 'running')])[0].health).toBe('healthy')
  })

  it('is degraded when some containers are down', () => {
    expect(discoverSystems([c('a', 'running'), c('a', 'exited')])[0].health).toBe('degraded')
  })

  it('is down when no container runs', () => {
    expect(discoverSystems([c('a', 'exited'), c('a', 'exited')])[0].health).toBe('down')
  })

  it('is degraded when a container reports unhealthy even though it runs', () => {
    expect(discoverSystems([c('a', 'running', 'unhealthy')])[0].health).toBe('degraded')
  })

  it('ignores containers with no compose project rather than inventing one', () => {
    expect(discoverSystems([c(null, 'running')])).toEqual([])
  })
})
```

The last case keeps discovery honest: a stray container is not a system.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run agent/src/docker.test.ts`
Expected: FAIL — cannot resolve `./docker.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// agent/src/docker.ts
import type { HealthState } from '@bevora-ops/shared'

export type ContainerSummary = {
  names: string[]
  project: string | null
  state: string
  health: string | null
}

export type DiscoveredSystem = {
  key: string
  displayName: string
  health: HealthState
  containers: { total: number; running: number }
}

/** Pure: takes an already-fetched container list so no daemon is needed to test. */
export function discoverSystems(list: ContainerSummary[]): DiscoveredSystem[] {
  const byProject = new Map<string, ContainerSummary[]>()
  for (const c of list) {
    if (!c.project) continue // not part of a system; do not invent one
    const arr = byProject.get(c.project) ?? []
    arr.push(c)
    byProject.set(c.project, arr)
  }

  return [...byProject.entries()].map(([key, cs]) => {
    const running = cs.filter((c) => c.state === 'running').length
    const anyUnhealthy = cs.some((c) => c.health === 'unhealthy')
    const health: HealthState =
      running === 0 ? 'down' : running < cs.length || anyUnhealthy ? 'degraded' : 'healthy'
    return { key, displayName: key, health, containers: { total: cs.length, running } }
  })
}

/** Maps the Docker API shape onto ContainerSummary. */
export function toSummary(raw: {
  Names: string[]
  State: string
  Labels?: Record<string, string>
  Status?: string
}): ContainerSummary {
  return {
    names: raw.Names,
    project: raw.Labels?.['com.docker.compose.project'] ?? null,
    state: raw.State,
    health: /\(healthy\)/.test(raw.Status ?? '')
      ? 'healthy'
      : /\(unhealthy\)/.test(raw.Status ?? '')
        ? 'unhealthy'
        : null,
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run agent/src/docker.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add agent/src/docker.ts agent/src/docker.test.ts
git commit -m "feat(agent): discover systems from compose project labels"
```

---

### Task 8: Snapshot assembly

**Files:**
- Create: `agent/src/collect.ts`, `agent/src/config.ts`
- Test: `agent/src/collect.test.ts`

**Interfaces:**
- Consumes: `discoverSystems`, `parseDeployLog`, `readGitState`, `FleetSnapshotSchema`.
- Produces: `collectSnapshot(deps: CollectDeps): Promise<FleetSnapshot>` where `CollectDeps = { listContainers: () => Promise<ContainerSummary[]>, readDeployLog: (key: string) => Promise<string | null>, repoDirFor: (key: string) => string, now: () => Date }`.

- [ ] **Step 1: Write the failing test**

```ts
// agent/src/collect.test.ts
import { describe, it, expect } from 'vitest'
import { collectSnapshot } from './collect.js'
import { FleetSnapshotSchema } from '@bevora-ops/shared'

const deps = (over: Partial<Parameters<typeof collectSnapshot>[0]> = {}) => ({
  listContainers: async () => [{ names: ['/a'], project: 'alpha', state: 'running', health: null }],
  readDeployLog: async () => '2026-08-01T10:00:00Z  === Deploy OK: abc1234 ===',
  repoDirFor: () => '/nonexistent',
  now: () => new Date('2026-08-01T12:00:00Z'),
  ...over,
})

describe('collectSnapshot', () => {
  it('produces a snapshot that satisfies the wire schema', async () => {
    const snap = await collectSnapshot(deps())
    expect(FleetSnapshotSchema.safeParse(snap).success).toBe(true)
  })

  it('reports the system even when its git repo cannot be read', async () => {
    const snap = await collectSnapshot(deps())
    expect(snap.systems).toHaveLength(1)
    expect(snap.systems[0]).toMatchObject({ key: 'alpha', health: 'healthy', deployedSubject: null })
  })

  it('survives a deploy log that cannot be read', async () => {
    const snap = await collectSnapshot(deps({ readDeployLog: async () => null }))
    expect(snap.systems[0]).toMatchObject({ key: 'alpha', deployedSha: null })
  })

  it('does not let one failing system remove the others', async () => {
    const snap = await collectSnapshot(
      deps({
        listContainers: async () => [
          { names: ['/a'], project: 'alpha', state: 'running', health: null },
          { names: ['/b'], project: 'beta', state: 'running', health: null },
        ],
        readDeployLog: async (key: string) => {
          if (key === 'alpha') throw new Error('permission denied')
          return '2026-08-01T10:00:00Z  === Deploy OK: def5678 ==='
        },
      }),
    )
    expect(snap.systems).toHaveLength(2)
    expect(snap.systems.find((s) => s.key === 'alpha')!.deployedSha).toBeNull()
    expect(snap.systems.find((s) => s.key === 'beta')!.deployedSha).not.toBeNull()
  })
})
```

The fourth case is the containment rule from the spec, tested rather than hoped for.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run agent/src/collect.test.ts`
Expected: FAIL — cannot resolve `./collect.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// agent/src/collect.ts
import type { FleetSnapshot, SystemState } from '@bevora-ops/shared'
import { discoverSystems, type ContainerSummary } from './docker.js'
import { parseDeployLog } from './deploy-log.js'
import { readGitState } from './git.js'

export type CollectDeps = {
  listContainers: () => Promise<ContainerSummary[]>
  readDeployLog: (systemKey: string) => Promise<string | null>
  repoDirFor: (systemKey: string) => string
  now: () => Date
}

export async function collectSnapshot(deps: CollectDeps): Promise<FleetSnapshot> {
  const discovered = discoverSystems(await deps.listContainers())

  const systems: SystemState[] = await Promise.all(
    discovered.map(async (d): Promise<SystemState> => {
      // Every per-system failure is contained here: one bad log or repo
      // degrades that row only, and never removes it from the board.
      let sha: string | null = null
      try {
        const text = await deps.readDeployLog(d.key)
        sha = text ? (parseDeployLog(text)?.sha ?? null) : null
      } catch {
        sha = null
      }

      let git = { deployedSha: sha, subject: null as string | null, deployedAt: null as Date | null, driftCommits: null as number | null }
      try {
        git = await readGitState(deps.repoDirFor(d.key), sha)
      } catch {
        /* keep the nulls */
      }

      return {
        key: d.key,
        displayName: d.displayName,
        health: d.health,
        containers: d.containers,
        // A 7-char sha from a log is not a valid 40-char wire sha; only the
        // git-resolved full sha is reported.
        deployedSha: git.deployedSha && /^[0-9a-f]{40}$/.test(git.deployedSha) ? git.deployedSha : null,
        deployedSubject: git.subject,
        deployedAt: git.deployedAt ? git.deployedAt.toISOString() : null,
        driftCommits: git.driftCommits,
      }
    }),
  )

  return { collectedAt: deps.now().toISOString(), systems }
}
```

```ts
// agent/src/config.ts
import { readFileSync } from 'node:fs'

/** All environment-specific values arrive here at runtime. None are literals. */
export type AgentConfig = {
  hostName: string
  dashboardUrl: string
  token: string
  deployLogGlob: string
  repoRoot: string
  intervalMs: number
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AgentConfig {
  const need = (k: string): string => {
    const v = env[k]
    if (!v) throw new Error(`missing required config: ${k}`)
    return v
  }
  return {
    hostName: need('AGENT_HOST_NAME'),
    dashboardUrl: need('AGENT_DASHBOARD_URL'),
    // File-mounted, never an env value: the token must not appear in `ps` or logs.
    token: readFileSync(need('AGENT_TOKEN_FILE'), 'utf8').trim(),
    deployLogGlob: need('AGENT_DEPLOY_LOG_GLOB'),
    repoRoot: need('AGENT_REPO_ROOT'),
    intervalMs: Number(env.AGENT_INTERVAL_MS ?? 30_000),
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run agent/src/collect.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add agent/src/collect.ts agent/src/config.ts agent/src/collect.test.ts
git commit -m "feat(agent): assemble a fleet snapshot with per-system failure containment"
```

---

### Task 9: Agent authentication on the ingest server

**Files:**
- Create: `web/src/server/auth-agent.ts`
- Test: `web/src/server/auth-agent.test.ts`

**Interfaces:**
- Consumes: `prisma`, `seal`/`open`.
- Produces: `enrolAgent(hostName: string, dek: Buffer): Promise<{ token: string, hostId: string }>`; `authenticateAgent(token: string): Promise<{ hostId: string } | null>`.

- [ ] **Step 1: Write the failing test**

```ts
// web/src/server/auth-agent.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { randomBytes } from 'node:crypto'
import { prisma } from '../lib/db.js'
import { enrolAgent, authenticateAgent } from './auth-agent.js'

const dek = randomBytes(32)

beforeEach(async () => {
  await prisma.agentEnrolment.deleteMany()
  await prisma.system.deleteMany()
  await prisma.host.deleteMany()
})

describe('agent auth', () => {
  it('accepts the token it issued', async () => {
    const { token, hostId } = await enrolAgent('host-a', dek)
    expect(await authenticateAgent(token)).toEqual({ hostId })
  })

  it('rejects a token it never issued', async () => {
    await enrolAgent('host-b', dek)
    expect(await authenticateAgent('not-a-real-token')).toBeNull()
  })

  it('rejects a revoked token', async () => {
    const { token } = await enrolAgent('host-c', dek)
    await prisma.agentEnrolment.updateMany({ data: { revokedAt: new Date() } })
    expect(await authenticateAgent(token)).toBeNull()
  })

  it('never stores the token in plaintext', async () => {
    const { token } = await enrolAgent('host-d', dek)
    const rows = await prisma.agentEnrolment.findMany()
    const dump = JSON.stringify(rows)
    expect(dump).not.toContain(token)
  })

  it('rejects an empty token without touching the database', async () => {
    expect(await authenticateAgent('')).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/server/auth-agent.test.ts`
Expected: FAIL — cannot resolve `./auth-agent.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// web/src/server/auth-agent.ts
import { createHash, randomBytes } from 'node:crypto'
import { prisma } from '../lib/db.js'
import { seal } from '../lib/crypto/envelope.js'

const hash = (token: string): string => createHash('sha256').update(token, 'utf8').digest('hex')

export async function enrolAgent(hostName: string, dek: Buffer): Promise<{ token: string; hostId: string }> {
  const token = randomBytes(32).toString('base64url')
  const host = await prisma.host.upsert({
    where: { name: hostName },
    create: { name: hostName },
    update: {},
  })
  // tokenHash is the lookup key; secretSealed keeps a recoverable copy for
  // re-display, encrypted and bound to its own row.
  const row = await prisma.agentEnrolment.create({
    data: { hostId: host.id, tokenHash: hash(token), secretSealed: 'pending' },
  })
  await prisma.agentEnrolment.update({
    where: { id: row.id },
    data: { secretSealed: seal(token, `agent_enrolment:${row.id}:secret`, dek) },
  })
  return { token, hostId: host.id }
}

export async function authenticateAgent(token: string): Promise<{ hostId: string } | null> {
  if (!token) return null
  const row = await prisma.agentEnrolment.findUnique({ where: { tokenHash: hash(token) } })
  if (!row || row.revokedAt) return null
  return { hostId: row.hostId }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npx prisma migrate dev --name agent_enrolment && npx vitest run src/server/auth-agent.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add web/src/server/auth-agent.ts web/src/server/auth-agent.test.ts web/prisma/migrations
git commit -m "feat(server): agent enrolment with hashed, sealed tokens"
```

---

### Task 10: Snapshot ingestion

**Files:**
- Create: `web/src/server/ingest.ts`
- Test: `web/src/server/ingest.test.ts`

**Interfaces:**
- Consumes: `authenticateAgent`, `FleetSnapshotSchema`, `prisma`.
- Produces: `ingestSnapshot(hostId: string, raw: unknown): Promise<{ accepted: number }>`.

- [ ] **Step 1: Write the failing test**

```ts
// web/src/server/ingest.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { randomBytes } from 'node:crypto'
import { prisma } from '../lib/db.js'
import { enrolAgent } from './auth-agent.js'
import { ingestSnapshot } from './ingest.js'

const dek = randomBytes(32)
let hostId: string

const snap = (systems: unknown[]) => ({ collectedAt: '2026-08-01T12:00:00.000Z', systems })
const sys = (key: string, over: Record<string, unknown> = {}) => ({
  key, displayName: key, health: 'healthy', containers: { total: 1, running: 1 },
  deployedSha: 'a'.repeat(40), deployedSubject: 'feat: x', deployedAt: '2026-08-01T10:00:00.000Z',
  driftCommits: 0, ...over,
})

beforeEach(async () => {
  await prisma.systemObservation.deleteMany()
  await prisma.system.deleteMany()
  await prisma.agentEnrolment.deleteMany()
  await prisma.host.deleteMany()
  hostId = (await enrolAgent('host-a', dek)).hostId
})

describe('ingestSnapshot', () => {
  it('creates systems it has not seen before', async () => {
    const r = await ingestSnapshot(hostId, snap([sys('alpha'), sys('beta')]))
    expect(r.accepted).toBe(2)
    expect(await prisma.system.count()).toBe(2)
  })

  it('reuses the existing system on a second snapshot', async () => {
    await ingestSnapshot(hostId, snap([sys('alpha')]))
    await ingestSnapshot(hostId, snap([sys('alpha', { health: 'degraded' })]))
    expect(await prisma.system.count()).toBe(1)
    expect(await prisma.systemObservation.count()).toBe(2)
  })

  it('rejects a snapshot that does not match the wire schema', async () => {
    await expect(ingestSnapshot(hostId, snap([sys('alpha', { health: 'green' })]))).rejects.toThrow()
    expect(await prisma.system.count()).toBe(0)
  })

  it('updates the host lastSeenAt', async () => {
    await ingestSnapshot(hostId, snap([sys('alpha')]))
    const host = await prisma.host.findUniqueOrThrow({ where: { id: hostId } })
    expect(host.lastSeenAt).not.toBeNull()
  })

  it('writes nothing at all when one system in the batch is invalid', async () => {
    await expect(ingestSnapshot(hostId, snap([sys('good'), sys('bad', { containers: null })]))).rejects.toThrow()
    expect(await prisma.system.count()).toBe(0)
    expect(await prisma.systemObservation.count()).toBe(0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/server/ingest.test.ts`
Expected: FAIL — cannot resolve `./ingest.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// web/src/server/ingest.ts
import { FleetSnapshotSchema } from '@bevora-ops/shared'
import { prisma } from '../lib/db.js'

export async function ingestSnapshot(hostId: string, raw: unknown): Promise<{ accepted: number }> {
  // Validate the whole batch before writing anything: a partially-applied
  // snapshot would leave the board describing a state that never existed.
  const snapshot = FleetSnapshotSchema.parse(raw)

  await prisma.$transaction(async (tx) => {
    for (const s of snapshot.systems) {
      const system = await tx.system.upsert({
        where: { hostId_key: { hostId, key: s.key } },
        create: { hostId, key: s.key, displayName: s.displayName },
        update: { displayName: s.displayName },
      })
      await tx.systemObservation.create({
        data: {
          systemId: system.id,
          observedAt: new Date(snapshot.collectedAt),
          health: s.health,
          containersTotal: s.containers.total,
          containersRunning: s.containers.running,
          deployedSha: s.deployedSha,
          deployedSubject: s.deployedSubject,
          deployedAt: s.deployedAt ? new Date(s.deployedAt) : null,
          driftCommits: s.driftCommits,
        },
      })
    }
    await tx.host.update({ where: { id: hostId }, data: { lastSeenAt: new Date() } })
  })

  return { accepted: snapshot.systems.length }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run src/server/ingest.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add web/src/server/ingest.ts web/src/server/ingest.test.ts
git commit -m "feat(server): all-or-nothing snapshot ingestion"
```

---

### Task 11: Staleness rules

**Files:**
- Create: `web/src/lib/staleness.ts`
- Test: `web/src/lib/staleness.test.ts`

**Interfaces:**
- Produces: `displayState(observedAt: Date | null, health: string, now: Date, staleAfterMs?: number): 'healthy' | 'degraded' | 'down' | 'unknown' | 'stale'`.

- [ ] **Step 1: Write the failing test**

```ts
// web/src/lib/staleness.test.ts
import { describe, it, expect } from 'vitest'
import { displayState } from './staleness.js'

const now = new Date('2026-08-01T12:00:00Z')
const ago = (ms: number) => new Date(now.getTime() - ms)

describe('displayState', () => {
  it('passes a fresh healthy observation through', () => {
    expect(displayState(ago(10_000), 'healthy', now)).toBe('healthy')
  })

  it('reports stale for an observation older than the threshold', () => {
    expect(displayState(ago(10 * 60_000), 'healthy', now)).toBe('stale')
  })

  it('NEVER reports healthy for a stale observation', () => {
    expect(displayState(ago(60 * 60_000), 'healthy', now)).not.toBe('healthy')
  })

  it('reports unknown when there is no observation at all', () => {
    expect(displayState(null, 'healthy', now)).toBe('unknown')
  })

  it('reports stale rather than down for an old failing observation', () => {
    expect(displayState(ago(10 * 60_000), 'down', now)).toBe('stale')
  })

  it('passes an unrecognised health value through as unknown', () => {
    expect(displayState(ago(1000), 'banana', now)).toBe('unknown')
  })
})
```

The third case is the single most important assertion in the slice: it encodes "a stale dashboard must never look healthy". The fifth is deliberate — once data is stale we no longer know the system is down either, and claiming otherwise would be the same error in the opposite direction.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/lib/staleness.test.ts`
Expected: FAIL — cannot resolve `./staleness.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// web/src/lib/staleness.ts
export type DisplayState = 'healthy' | 'degraded' | 'down' | 'unknown' | 'stale'

const KNOWN = new Set(['healthy', 'degraded', 'down', 'unknown'])

/** Default: three missed 30s collections. */
export function displayState(
  observedAt: Date | null,
  health: string,
  now: Date,
  staleAfterMs = 90_000,
): DisplayState {
  if (!observedAt) return 'unknown'
  // Staleness outranks the reported health in BOTH directions: once the data
  // is old we no longer know the system is healthy, nor that it is down.
  if (now.getTime() - observedAt.getTime() > staleAfterMs) return 'stale'
  return KNOWN.has(health) ? (health as DisplayState) : 'unknown'
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run src/lib/staleness.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/staleness.ts web/src/lib/staleness.test.ts
git commit -m "feat(web): stale data never renders as healthy"
```

---

### Task 12: Agent transport

**Files:**
- Create: `agent/src/transport.ts`, `agent/src/main.ts`
- Test: `agent/src/transport.test.ts`

**Interfaces:**
- Consumes: `AgentConfig`, `FleetSnapshot`.
- Produces: `nextBackoffMs(attempt: number, base?: number, cap?: number): number`; `class AgentTransport { constructor(cfg: AgentConfig); send(snapshot: FleetSnapshot): Promise<void> }`.

- [ ] **Step 1: Write the failing test**

```ts
// agent/src/transport.test.ts
import { describe, it, expect } from 'vitest'
import { nextBackoffMs } from './transport.js'

describe('nextBackoffMs', () => {
  it('grows exponentially', () => {
    expect(nextBackoffMs(0, 1000, 60_000)).toBe(1000)
    expect(nextBackoffMs(1, 1000, 60_000)).toBe(2000)
    expect(nextBackoffMs(2, 1000, 60_000)).toBe(4000)
  })

  it('never exceeds the cap', () => {
    expect(nextBackoffMs(50, 1000, 60_000)).toBe(60_000)
  })

  it('never returns a negative or zero delay', () => {
    expect(nextBackoffMs(0, 1000, 60_000)).toBeGreaterThan(0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run agent/src/transport.test.ts`
Expected: FAIL — cannot resolve `./transport.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// agent/src/transport.ts
import WebSocket from 'ws'
import type { FleetSnapshot } from '@bevora-ops/shared'
import type { AgentConfig } from './config.js'

export function nextBackoffMs(attempt: number, base = 1000, cap = 60_000): number {
  return Math.min(cap, base * 2 ** attempt)
}

export class AgentTransport {
  private ws: WebSocket | null = null
  private attempt = 0

  constructor(private cfg: AgentConfig) {}

  private async connect(): Promise<WebSocket> {
    if (this.ws?.readyState === WebSocket.OPEN) return this.ws
    return new Promise((resolve, reject) => {
      // The agent dials OUT: nothing new listens on the monitored host.
      const ws = new WebSocket(this.cfg.dashboardUrl, {
        headers: { authorization: `Bearer ${this.cfg.token}` },
      })
      ws.once('open', () => { this.ws = ws; this.attempt = 0; resolve(ws) })
      ws.once('error', (e) => { this.ws = null; reject(e) })
      ws.once('close', () => { this.ws = null })
    })
  }

  async send(snapshot: FleetSnapshot): Promise<void> {
    try {
      const ws = await this.connect()
      ws.send(JSON.stringify({ type: 'snapshot', payload: snapshot }))
    } catch (err) {
      // Losing the dashboard must never kill the agent: back off and retry.
      // The dashboard shows this host as stale in the meantime, which is the
      // correct thing for an operator to see.
      const wait = nextBackoffMs(this.attempt++)
      console.error(`[agent] send failed, retrying in ${wait}ms:`, (err as Error).message)
      await new Promise((r) => setTimeout(r, wait))
    }
  }
}
```

```ts
// agent/src/main.ts
import Docker from 'dockerode'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { loadConfig } from './config.js'
import { collectSnapshot } from './collect.js'
import { toSummary } from './docker.js'
import { AgentTransport } from './transport.js'

const cfg = loadConfig()
const docker = new Docker()
const transport = new AgentTransport(cfg)

async function tick(): Promise<void> {
  const snapshot = await collectSnapshot({
    listContainers: async () => (await docker.listContainers({ all: true })).map(toSummary),
    readDeployLog: async (key) =>
      readFile(cfg.deployLogGlob.replace('*', key), 'utf8').catch(() => null),
    repoDirFor: (key) => join(cfg.repoRoot, key),
    now: () => new Date(),
  })
  await transport.send(snapshot)
}

setInterval(() => { void tick() }, cfg.intervalMs)
void tick()
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run agent/src/transport.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add agent/src/transport.ts agent/src/main.ts agent/src/transport.test.ts
git commit -m "feat(agent): outbound transport with capped backoff"
```

---

### Task 13: The fleet board

**Files:**
- Create: `web/src/app/page.tsx`, `web/src/components/FleetTable.tsx`, `web/src/lib/fleet-query.ts`
- Test: `web/src/components/FleetTable.test.tsx`

**Interfaces:**
- Consumes: `displayState`, `prisma`.
- Produces: `latestPerSystem(now: Date): Promise<FleetRow[]>` where `FleetRow = { key, displayName, state, containersRunning, containersTotal, deployedSha, deployedSubject, deployedAt, driftCommits, observedAt }`; `<FleetTable rows={FleetRow[]} />`.

- [ ] **Step 1: Write the failing test**

```tsx
// web/src/components/FleetTable.test.tsx
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { FleetTable } from './FleetTable.js'

const row = (over = {}) => ({
  key: 'alpha', displayName: 'alpha', state: 'healthy' as const,
  containersRunning: 3, containersTotal: 3,
  deployedSha: 'abcdef1234567890abcdef1234567890abcdef12',
  deployedSubject: 'fix: the thing', deployedAt: new Date('2026-08-01T10:00:00Z'),
  driftCommits: 0, observedAt: new Date('2026-08-01T12:00:00Z'), ...over,
})

describe('FleetTable', () => {
  it('shows the short sha and the change description', () => {
    render(<FleetTable rows={[row()]} />)
    expect(screen.getByText('abcdef1')).toBeTruthy()
    expect(screen.getByText('fix: the thing')).toBeTruthy()
  })

  it('shows an em dash rather than a blank when nothing is known', () => {
    render(<FleetTable rows={[row({ deployedSha: null, deployedSubject: null })]} />)
    expect(screen.getAllByText('—').length).toBeGreaterThan(0)
  })

  it('labels a stale row as stale, not healthy', () => {
    render(<FleetTable rows={[row({ state: 'stale' })]} />)
    expect(screen.getByText(/stale/i)).toBeTruthy()
    expect(screen.queryByText(/^healthy$/i)).toBeNull()
  })

  it('flags drift when the deployed sha is behind', () => {
    render(<FleetTable rows={[row({ driftCommits: 4 })]} />)
    expect(screen.getByText(/4 behind/i)).toBeTruthy()
  })

  it('renders an empty state rather than an empty table', () => {
    render(<FleetTable rows={[]} />)
    expect(screen.getByText(/no systems reported/i)).toBeTruthy()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/components/FleetTable.test.tsx`
Expected: FAIL — cannot resolve `./FleetTable.js`.

- [ ] **Step 3: Write minimal implementation**

```tsx
// web/src/components/FleetTable.tsx
import type { DisplayState } from '../lib/staleness.js'

export type FleetRow = {
  key: string
  displayName: string
  state: DisplayState
  containersRunning: number
  containersTotal: number
  deployedSha: string | null
  deployedSubject: string | null
  deployedAt: Date | null
  driftCommits: number | null
  observedAt: Date | null
}

const DASH = '—'

export function FleetTable({ rows }: { rows: FleetRow[] }) {
  if (rows.length === 0) return <p>No systems reported yet.</p>
  return (
    <table>
      <thead>
        <tr>
          <th>System</th><th>State</th><th>Containers</th>
          <th>Version</th><th>Deployed</th><th>Latest change</th><th>Drift</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.key} data-state={r.state}>
            <td>{r.displayName}</td>
            <td>{r.state}</td>
            <td>{r.containersRunning}/{r.containersTotal}</td>
            <td>{r.deployedSha ? r.deployedSha.slice(0, 7) : DASH}</td>
            <td>{r.deployedAt ? r.deployedAt.toISOString() : DASH}</td>
            <td>{r.deployedSubject ?? DASH}</td>
            <td>{r.driftCommits === null ? DASH : r.driftCommits === 0 ? 'up to date' : `${r.driftCommits} behind`}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
```

```ts
// web/src/lib/fleet-query.ts
import { prisma } from './db.js'
import { displayState } from './staleness.js'
import type { FleetRow } from '../components/FleetTable.js'

export async function latestPerSystem(now: Date): Promise<FleetRow[]> {
  const systems = await prisma.system.findMany({
    include: { observations: { orderBy: { observedAt: 'desc' }, take: 1 } },
    orderBy: { key: 'asc' },
  })
  return systems.map((s): FleetRow => {
    const o = s.observations[0] ?? null
    return {
      key: s.key,
      displayName: s.displayName,
      state: displayState(o?.observedAt ?? null, o?.health ?? 'unknown', now),
      containersRunning: o?.containersRunning ?? 0,
      containersTotal: o?.containersTotal ?? 0,
      deployedSha: o?.deployedSha ?? null,
      deployedSubject: o?.deployedSubject ?? null,
      deployedAt: o?.deployedAt ?? null,
      driftCommits: o?.driftCommits ?? null,
      observedAt: o?.observedAt ?? null,
    }
  })
}
```

```tsx
// web/src/app/page.tsx
import { latestPerSystem } from '../lib/fleet-query.js'
import { FleetTable } from '../components/FleetTable.js'

export const dynamic = 'force-dynamic'

export default async function Page() {
  const rows = await latestPerSystem(new Date())
  return (
    <main>
      <h1>Fleet</h1>
      <FleetTable rows={rows} />
    </main>
  )
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run src/components/FleetTable.test.tsx`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add web/src/app web/src/components web/src/lib/fleet-query.ts
git commit -m "feat(web): the fleet board"
```

---

### Task 14: Deploy to the droplet, loopback only

**Files:**
- Create: `docker-compose.yml`, `deploy/agent.service`, `deploy/README.md`
- Test: manual verification, recorded below

**Interfaces:**
- Consumes: everything above.
- Produces: a running dashboard reachable only over an SSH tunnel, and an enrolled agent.

- [ ] **Step 1: Write the failing test**

The verification is a live probe. Write it first so it is run, not skipped:

```bash
# deploy/verify.sh — must print PASS on every line before this task is done.
set -u
fail=0
check() { if eval "$2"; then echo "PASS  $1"; else echo "FAIL  $1"; fail=1; fi; }

check "web answers on loopback"        '[ "$(curl -s -o /dev/null -w %{http_code} http://127.0.0.1:3000/)" = 200 ]'
check "web is NOT on the public iface" '! curl -s -m 5 -o /dev/null "http://$(hostname -I | awk "{print \$1}"):3000/"'
check "postgres publishes no host port" '[ -z "$(ss -lnt | grep -E ":5432")" ]'
check "agent unit is active"            'systemctl is-active --quiet bevora-agent'
exit $fail
```

- [ ] **Step 2: Run it to verify it fails**

Run on the droplet before deploying: `bash deploy/verify.sh`
Expected: `FAIL` on every line — nothing is deployed yet.

- [ ] **Step 3: Write minimal implementation**

```yaml
# docker-compose.yml
services:
  db:
    image: postgres:16-alpine
    container_name: bevops-db
    restart: unless-stopped
    environment:
      POSTGRES_PASSWORD_FILE: /run/secrets/postgres_password
      POSTGRES_DB: bevops
    secrets: [postgres_password]
    volumes: [bevops_pgdata:/var/lib/postgresql/data]
    # No host port: a database needs none. Debug with `docker exec`.
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 5s
      retries: 10

  web:
    image: ghcr.io/${GHCR_OWNER}/bevora-ops:${TAG:-latest}
    container_name: bevops-web
    restart: unless-stopped
    depends_on: { db: { condition: service_healthy } }
    env_file: .env
    secrets: [kek]
    # Loopback ONLY for slice 1: authentication ships in slice 3, so this must
    # not be reachable from the internet. Access over `ssh -L 3000:127.0.0.1:3000`.
    ports: ["127.0.0.1:3000:3000"]

secrets:
  postgres_password: { file: ./secrets/postgres_password }
  kek: { file: ./secrets/kek }

volumes:
  bevops_pgdata:
```

```ini
# deploy/agent.service
[Unit]
Description=Bevora Ops agent
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=simple
# Runs on the monitored host. Reads the container runtime, deploy logs and
# repo checkouts; opens an OUTBOUND connection only.
EnvironmentFile=/etc/bevora-agent/agent.env
ExecStart=/usr/bin/node /opt/bevora-agent/dist/main.js
Restart=always
RestartSec=5
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

`deploy/README.md` documents, without naming any host: generate `secrets/kek` with `openssl rand -base64 32`; run `npm run enrol -- <host-name>` on the dashboard to mint an agent token; write it to `/etc/bevora-agent/token` mode 600 on the monitored host; set `AGENT_HOST_NAME`, `AGENT_DASHBOARD_URL`, `AGENT_TOKEN_FILE`, `AGENT_DEPLOY_LOG_GLOB`, `AGENT_REPO_ROOT` in `/etc/bevora-agent/agent.env`.

- [ ] **Step 4: Run it to verify it passes**

```bash
bash deploy/verify.sh                      # expect PASS on all four
ssh -L 3000:127.0.0.1:3000 <droplet>       # then open http://127.0.0.1:3000
```
Expected: the board lists every discovered system with health, version, deploy time and latest change. Confirm the count matches `docker ps --format '{{.Label "com.docker.compose.project"}}' | sort -u | wc -l` on the monitored host — discovery must find them all without being told any of their names.

Then prove the staleness rule live: `systemctl stop bevora-agent`, wait 2 minutes, reload the page. **Every row must read `stale`, not `healthy`.** Restart the agent and confirm rows recover.

- [ ] **Step 5: Commit**

```bash
git add docker-compose.yml deploy/
git commit -m "feat(deploy): loopback-only dashboard and agent unit"
```

---

## Self-Review

**Spec coverage.** §4.1 fleet board columns — Tasks 5, 6, 7, 13 (cert and backup columns are explicitly slice 2/3, not slice 1). §2.1 discovery-not-enumeration — Task 7, asserted by the live count check in Task 14. §2.1 unknown-never-healthy — Task 11, and re-proved live in Task 14. §2.1 partial-failure-contained — Task 8. §5 outbound agent — Task 12. §6 auth foundations — Task 9 (agent identity; human login is slice 3). §7 envelope encryption — Task 3. §9 stale never healthy — Task 11. §10 disclosure gate — Task 1. §12 denial tests — Tasks 9, 10, 11.

**Known gaps, deliberate:** SSE live-push is slice 2 (slice 1 renders on request, `force-dynamic`); host vitals strip is slice 2; the certificate and backup columns are slice 2/3; human authentication is slice 3, which is why slice 1 is loopback-only.

**Type consistency.** `HealthState` is defined once in `shared/src/wire.ts` and imported by `agent/src/docker.ts`. `DisplayState` extends it with `stale` in `web/src/lib/staleness.ts` and is consumed by `FleetRow`. `ContainerSummary` is produced by `toSummary` and consumed by `discoverSystems` and `collectSnapshot`. `FleetSnapshot` is produced by `collectSnapshot`, sent by `AgentTransport.send`, and parsed by `ingestSnapshot`. `enrolAgent` returns `{ token, hostId }`, and Task 10's test consumes `hostId` from it.
