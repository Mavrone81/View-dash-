# Slice 2a — a green row tells the truth: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A row is green only when the application actually answers, and when it does not, the board says where the fault is.

**Architecture:** Two independent probes that are never merged into one boolean — the agent probes each system through loopback on the monitored host, and the dashboard probes the same hostnames over the public internet on a slower cadence, taking certificate expiry from its own TLS handshake. Hostnames are *derived* from the host's reverse-proxy configuration rather than configured, so a new stack is probed the day it deploys.

**Tech Stack:** TypeScript strict (`noUncheckedIndexedAccess`), Node 22, Zod for wire schemas, Prisma 6 + Postgres 16, Next.js 16 App Router, React 19, Vitest.

## Global Constraints

- **This repository is PUBLIC.** No IP addresses, hostnames, domain names or real monitored-system names in code, tests, fixtures, comments, commit messages or docs. CI enforces this via `node scripts/ci/assert-no-environment-leakage.mjs`. Test fixtures use invented names.
- **No new dependencies.** No `any`, no `@ts-ignore`.
- **Tests run from the REPO ROOT**: `npx vitest run`. `vitest.config.ts` and `vitest.setup.ts` live there. Also `npx tsc -b`.
- **Every denial test must be VERIFIED to fail without its fix** — break the code, watch that specific test fail, restore, report the exact failure text. Seventeen non-discriminating tests have been found across this project's two slices.
- **Every capability ships with a control or a display, and a test proving it is reachable from the UI.** The credential vault shipped three complete, tested backends with no way in and every per-task review missed it.
- Host fixtures in tests use a name no other spec file uses and are deleted in `beforeEach` — `Host.name` is `@unique` and nothing truncates that table.
- **Never merge the two probe results into a single boolean.** The value of this slice is the disagreement between them.

---

### Task 1: The probe vocabulary and its classification rule

**Files:**
- Modify: `shared/src/wire.ts`
- Test: `shared/src/wire.test.ts` (create if absent)

**Interfaces:**
- Produces:
  - `ProbeOutcome = 'answering' | 'answering-oddly' | 'not-answering' | 'proxy-no-upstream' | 'tls-failed' | 'not-probed'`
  - `ProbeOutcomeSchema` (Zod enum of the above)
  - `classifyHttpStatus(status: number): ProbeOutcome`
  - `classifyProbeFailure(kind: 'tls' | 'network' | 'timeout'): ProbeOutcome`
  - `probeOutcomeToHealth(o: ProbeOutcome): HealthState | null`

- [ ] **Step 1: Write the failing test**

```ts
// shared/src/wire.test.ts
import { describe, it, expect } from 'vitest'
import { classifyHttpStatus, classifyProbeFailure, probeOutcomeToHealth } from './wire.js'

describe('probe classification', () => {
  it('treats 2xx and 3xx as answering', () => {
    for (const s of [200, 201, 204, 301, 302, 307, 308]) {
      expect(classifyHttpStatus(s)).toBe('answering')
    }
  })

  // A login wall is an application doing its job. Measured against the live
  // host, a "200 is healthy" rule would have marked 19 of 42 hostnames
  // broken while they worked correctly.
  it('treats 401 and 403 as answering, NOT as a fault', () => {
    expect(classifyHttpStatus(401)).toBe('answering')
    expect(classifyHttpStatus(403)).toBe('answering')
  })

  it('treats other 4xx as answering oddly', () => {
    expect(classifyHttpStatus(404)).toBe('answering-oddly')
    expect(classifyHttpStatus(418)).toBe('answering-oddly')
  })

  // 502 and 504 come from the PROXY, not the application: they are exactly
  // what is served when the proxy is healthy and the container behind it is
  // not. That is the fault this slice exists to catch, so it gets its own
  // outcome rather than being folded into a generic 5xx.
  it('names 502 and 504 as the proxy having no upstream', () => {
    expect(classifyHttpStatus(502)).toBe('proxy-no-upstream')
    expect(classifyHttpStatus(504)).toBe('proxy-no-upstream')
  })

  it('treats other 5xx as not answering', () => {
    expect(classifyHttpStatus(500)).toBe('not-answering')
    expect(classifyHttpStatus(503)).toBe('not-answering')
  })

  it('keeps a TLS failure distinct from an application being down', () => {
    expect(classifyProbeFailure('tls')).toBe('tls-failed')
    expect(classifyProbeFailure('network')).toBe('not-answering')
    expect(classifyProbeFailure('timeout')).toBe('not-answering')
  })

  it('maps outcomes onto health, with not-probed expressing NO opinion', () => {
    expect(probeOutcomeToHealth('answering')).toBe('healthy')
    expect(probeOutcomeToHealth('answering-oddly')).toBe('degraded')
    expect(probeOutcomeToHealth('not-answering')).toBe('down')
    expect(probeOutcomeToHealth('proxy-no-upstream')).toBe('down')
    expect(probeOutcomeToHealth('tls-failed')).toBe('down')
    // null, never 'healthy': "we did not look" must not read as "we looked
    // and it was fine".
    expect(probeOutcomeToHealth('not-probed')).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run shared/src/wire.test.ts`
Expected: FAIL — `classifyHttpStatus` is not exported.

- [ ] **Step 3: Write minimal implementation**

```ts
// append to shared/src/wire.ts

/**
 * What a single probe of a single hostname found.
 *
 * `proxy-no-upstream` is deliberately its own value rather than a flavour
 * of `not-answering`: a 502/504 is the reverse proxy telling us it is
 * healthy and the thing behind it is not. That sentence is the entire
 * reason this slice exists, and collapsing it into a generic failure
 * throws away the only outcome that names its own cause.
 *
 * `not-probed` means no probe ran. It is NOT a pass.
 */
export const ProbeOutcomeSchema = z.enum([
  'answering',
  'answering-oddly',
  'not-answering',
  'proxy-no-upstream',
  'tls-failed',
  'not-probed',
])
export type ProbeOutcome = z.infer<typeof ProbeOutcomeSchema>

/**
 * Maps an HTTP status onto an outcome.
 *
 * 401 and 403 count as ANSWERING. A login wall is an application working.
 * Measured across every hostname on the monitored host, a "200 is healthy"
 * rule would have marked 19 of 42 as broken while they were fine, and a
 * column that cries wolf is a column nobody reads.
 */
export function classifyHttpStatus(status: number): ProbeOutcome {
  if (status === 502 || status === 504) return 'proxy-no-upstream'
  if (status >= 500) return 'not-answering'
  if (status === 401 || status === 403) return 'answering'
  if (status >= 400) return 'answering-oddly'
  return 'answering'
}

/** A probe that produced no HTTP status at all. TLS is kept separate: a
 * certificate problem is a different repair from a dead application. */
export function classifyProbeFailure(kind: 'tls' | 'network' | 'timeout'): ProbeOutcome {
  return kind === 'tls' ? 'tls-failed' : 'not-answering'
}

/**
 * Folds an outcome onto the health scale the container side already uses.
 * `not-probed` yields null — no opinion — so a system nobody could probe is
 * reported exactly as its containers describe it and is never downgraded
 * for the absence of a probe, nor upgraded by one that never ran.
 */
export function probeOutcomeToHealth(o: ProbeOutcome): HealthState | null {
  switch (o) {
    case 'answering':
      return 'healthy'
    case 'answering-oddly':
      return 'degraded'
    case 'not-answering':
    case 'proxy-no-upstream':
    case 'tls-failed':
      return 'down'
    case 'not-probed':
      return null
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run shared/src/wire.test.ts` → PASS, 7 tests. Then `npx tsc -b`.

- [ ] **Step 5: Commit**

```bash
git add shared/src/wire.ts shared/src/wire.test.ts
git commit -m "feat(shared): a probe vocabulary that names what it found"
```

---

### Task 2: Derive hostnames from the reverse-proxy configuration

**Files:**
- Create: `agent/src/vhosts.ts`, `agent/src/vhosts.test.ts`

**Interfaces:**
- Produces:
  - `type VhostEntry = { hostnames: string[]; upstreamPort: number | null; listensTls: boolean }`
  - `parseVhost(text: string): VhostEntry`
  - `discoverHostnamesByPort(files: Array<{ text: string }>): Map<number, string[]>`

- [ ] **Step 1: Write the failing test**

```ts
// agent/src/vhosts.test.ts
import { describe, it, expect } from 'vitest'
import { parseVhost, discoverHostnamesByPort } from './vhosts.js'

const VHOST = `
server {
    listen 443 ssl;
    server_name alpha.example.invalid www.alpha.example.invalid;
    location / {
        proxy_pass http://127.0.0.1:8081;
    }
}
`

describe('vhost parsing', () => {
  it('extracts every hostname and the upstream port', () => {
    const v = parseVhost(VHOST)
    expect(v.hostnames).toEqual(['alpha.example.invalid', 'www.alpha.example.invalid'])
    expect(v.upstreamPort).toBe(8081)
    expect(v.listensTls).toBe(true)
  })

  it('ignores the catch-all server_name, which names no system', () => {
    expect(parseVhost('server { server_name _; listen 80; }').hostnames).toEqual([])
  })

  it('reports a vhost that listens for TLS but proxies nowhere', () => {
    const v = parseVhost('server { listen 443 ssl; server_name beta.example.invalid; }')
    expect(v.hostnames).toEqual(['beta.example.invalid'])
    expect(v.upstreamPort).toBeNull()
    expect(v.listensTls).toBe(true)
  })

  it('groups hostnames by the port they proxy to', () => {
    const byPort = discoverHostnamesByPort([
      { text: VHOST },
      { text: 'server { server_name gamma.example.invalid; location / { proxy_pass http://127.0.0.1:9001; } }' },
      { text: 'server { server_name delta.example.invalid; location / { proxy_pass http://127.0.0.1:8081; } }' },
    ])
    expect(byPort.get(8081)).toEqual(['alpha.example.invalid', 'www.alpha.example.invalid', 'delta.example.invalid'])
    expect(byPort.get(9001)).toEqual(['gamma.example.invalid'])
  })

  it('drops a vhost with no upstream from the port map rather than inventing one', () => {
    const byPort = discoverHostnamesByPort([{ text: 'server { listen 443 ssl; server_name beta.example.invalid; }' }])
    expect(byPort.size).toBe(0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run agent/src/vhosts.test.ts`
Expected: FAIL — cannot resolve `./vhosts.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// agent/src/vhosts.ts

/**
 * Derives which hostnames serve which system, by reading the host's
 * reverse-proxy configuration rather than a maintained list.
 *
 * A maintained list is why slice 1's probe never ran: the code shipped, the
 * configuration to feed it never did. Derivation means a new stack is
 * probed the day it deploys, with nobody editing anything — which is the
 * property the operator asked for when they said this must stay "robust and
 * expendable".
 *
 * The chain is: server_name -> proxy_pass loopback port -> published
 * container port -> compose project. This module owns the first two links.
 */

export type VhostEntry = {
  hostnames: string[]
  upstreamPort: number | null
  listensTls: boolean
}

// `_` is nginx's catch-all: it names no system and must never become a
// probe target.
const CATCH_ALL = '_'

export function parseVhost(text: string): VhostEntry {
  const hostnames: string[] = []
  for (const m of text.matchAll(/server_name\s+([^;]+);/g)) {
    for (const name of (m[1] ?? '').trim().split(/\s+/)) {
      if (name && name !== CATCH_ALL && name.includes('.')) hostnames.push(name)
    }
  }
  const port = text.match(/proxy_pass\s+https?:\/\/127\.0\.0\.1:(\d+)/)
  const tls = /listen[^;]*\b443\b/.test(text) || /listen[^;]*\bssl\b/.test(text)
  return {
    hostnames,
    upstreamPort: port?.[1] !== undefined ? Number(port[1]) : null,
    listensTls: tls,
  }
}

export function discoverHostnamesByPort(files: Array<{ text: string }>): Map<number, string[]> {
  const byPort = new Map<number, string[]>()
  for (const f of files) {
    const v = parseVhost(f.text)
    // A vhost with no upstream is real and worth reporting elsewhere, but it
    // maps to no system, so it contributes nothing here rather than being
    // guessed onto one.
    if (v.upstreamPort === null || v.hostnames.length === 0) continue
    const existing = byPort.get(v.upstreamPort) ?? []
    byPort.set(v.upstreamPort, [...existing, ...v.hostnames])
  }
  return byPort
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run agent/src/vhosts.test.ts` → PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add agent/src/vhosts.ts agent/src/vhosts.test.ts
git commit -m "feat(agent): derive hostnames from the proxy config, not a list"
```

---

### Task 3: Read vhost files through symlinks

**Files:**
- Modify: `agent/src/vhosts.ts`
- Modify: `agent/src/vhosts.test.ts`

**Interfaces:**
- Consumes: `discoverHostnamesByPort` from Task 2.
- Produces: `readVhostDir(dir: string, fs: VhostFs): Promise<Array<{ text: string }>>` where
  `type VhostFs = { readdir(d: string): Promise<string[]>; readFile(p: string): Promise<string> }`

**Why this is its own task:** the enabled-vhost directory is entirely symlinks, and `grep -r` skips those. During the survey this returned **zero hostnames, twice, and looked authoritative**. A reader that silently sees nothing is the exact failure this project keeps finding.

- [ ] **Step 1: Write the failing test**

```ts
// append to agent/src/vhosts.test.ts
import { readVhostDir } from './vhosts.js'
import { mkdtemp, mkdir, writeFile, symlink, readdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('reading the vhost directory', () => {
  it('follows symlinks, because the enabled directory is nothing but symlinks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vhosts-'))
    const available = join(root, 'available')
    const enabled = join(root, 'enabled')
    await mkdir(available)
    await mkdir(enabled)
    await writeFile(join(available, 'a.conf'), 'server { server_name a.example.invalid; }')
    await symlink(join(available, 'a.conf'), join(enabled, 'a.conf'))

    const files = await readVhostDir(enabled, {
      readdir: (d) => readdir(d),
      readFile: (p) => readFile(p, 'utf8'),
    })

    expect(files).toHaveLength(1)
    expect(files[0]!.text).toContain('a.example.invalid')
  })

  it('skips a file it cannot read rather than failing the whole scan', async () => {
    const files = await readVhostDir('/enabled', {
      readdir: async () => ['ok.conf', 'gone.conf'],
      readFile: async (p) => {
        if (p.endsWith('gone.conf')) throw new Error('ENOENT')
        return 'server { server_name ok.example.invalid; }'
      },
    })
    expect(files).toHaveLength(1)
  })

  it('returns empty when the directory does not exist, without throwing', async () => {
    const files = await readVhostDir('/nope', {
      readdir: async () => {
        throw new Error('ENOENT')
      },
      readFile: async () => '',
    })
    expect(files).toEqual([])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run agent/src/vhosts.test.ts` → FAIL, `readVhostDir` is not exported.

- [ ] **Step 3: Write minimal implementation**

```ts
// append to agent/src/vhosts.ts

/** The two filesystem calls this module needs, so a test needs no mocking of node:fs. */
export type VhostFs = {
  readdir(d: string): Promise<string[]>
  readFile(p: string): Promise<string>
}

/**
 * Reads every vhost file in a directory.
 *
 * `readFile` follows symlinks; this is load-bearing rather than incidental.
 * The enabled-vhost directory is entirely symlinks into an adjacent
 * directory, and a scan that does not follow them returns nothing while
 * looking exactly like a scan of a host with no vhosts. That happened twice
 * during the survey for this slice, using `grep -r`, which skips symlinks
 * where `grep -R` follows them.
 *
 * Never throws: a missing directory or an unreadable file yields fewer
 * entries, not a failed collection cycle. A probe is a diagnostic.
 */
export async function readVhostDir(dir: string, fs: VhostFs): Promise<Array<{ text: string }>> {
  let names: string[]
  try {
    names = await fs.readdir(dir)
  } catch {
    return []
  }
  const out: Array<{ text: string }> = []
  for (const n of names) {
    try {
      out.push({ text: await fs.readFile(`${dir}/${n}`) })
    } catch {
      // One unreadable file must not blind the scan to the rest.
    }
  }
  return out
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run agent/src/vhosts.test.ts` → PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add agent/src/vhosts.ts agent/src/vhosts.test.ts
git commit -m "feat(agent): read vhosts through symlinks, which grep -r silently skips"
```

---

### Task 4: Map a container's published ports to its system, and probe on-box

**Files:**
- Modify: `agent/src/probe.ts`, `agent/src/probe.test.ts`
- Modify: `agent/src/docker.ts` (expose published ports per system)

**Interfaces:**
- Consumes: `discoverHostnamesByPort` (Task 2), `readVhostDir` (Task 3), `classifyHttpStatus` / `classifyProbeFailure` (Task 1).
- Produces:
  - `hostnamesForSystem(publishedPorts: number[], byPort: Map<number, string[]>): string[]`
  - `probeHostnameOnBox(hostname: string, fetchImpl: FetchLike, timeoutMs?: number): Promise<{ hostname: string; outcome: ProbeOutcome; status: number | null }>`

**Note on existing code:** `agent/src/probe.ts` already has `worstOf` and `probeUrl`. `probeUrl` maps ALL 4xx to `degraded`; Task 1 supersedes that. Replace `probeUrl`'s classification with `classifyHttpStatus` — do not leave two rules in the tree.

- [ ] **Step 1: Write the failing test**

```ts
// append to agent/src/probe.test.ts
import { hostnamesForSystem, probeHostnameOnBox } from './probe.js'

describe('mapping ports to hostnames', () => {
  it('collects every hostname across all of a system's published ports', () => {
    const byPort = new Map([
      [8081, ['alpha.example.invalid']],
      [9001, ['gamma.example.invalid']],
    ])
    expect(hostnamesForSystem([8081, 9001], byPort)).toEqual([
      'alpha.example.invalid',
      'gamma.example.invalid',
    ])
  })

  it('returns nothing for a system with no vhost, rather than guessing one', () => {
    expect(hostnamesForSystem([7777], new Map([[8081, ['alpha.example.invalid']]]))).toEqual([])
  })
})

describe('on-box probing', () => {
  it('reports the status it saw alongside the outcome', async () => {
    const r = await probeHostnameOnBox('alpha.example.invalid', async () => ({ status: 301 }))
    expect(r).toEqual({ hostname: 'alpha.example.invalid', outcome: 'answering', status: 301 })
  })

  it('names a 502 as the proxy having no upstream', async () => {
    const r = await probeHostnameOnBox('alpha.example.invalid', async () => ({ status: 502 }))
    expect(r.outcome).toBe('proxy-no-upstream')
  })

  it('distinguishes a TLS failure from a dead application', async () => {
    const r = await probeHostnameOnBox('alpha.example.invalid', async () => {
      throw Object.assign(new Error('handshake'), { code: 'ERR_TLS_CERT_ALTNAME_INVALID' })
    })
    expect(r.outcome).toBe('tls-failed')
    expect(r.status).toBeNull()
  })

  it('never throws, whatever the fetch does', async () => {
    const r = await probeHostnameOnBox('alpha.example.invalid', async () => {
      throw new Error('boom')
    })
    expect(r.outcome).toBe('not-answering')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run agent/src/probe.test.ts` → FAIL, `hostnamesForSystem` is not exported.

- [ ] **Step 3: Write minimal implementation**

```ts
// append to agent/src/probe.ts
import { classifyHttpStatus, classifyProbeFailure, type ProbeOutcome } from '@bevora-ops/shared'

export function hostnamesForSystem(publishedPorts: number[], byPort: Map<number, string[]>): string[] {
  const out: string[] = []
  for (const p of publishedPorts) out.push(...(byPort.get(p) ?? []))
  return out
}

/** Node's TLS errors all carry a code beginning ERR_TLS_, or ERR_SSL_ from OpenSSL. */
function isTlsError(err: unknown): boolean {
  const code = (err as { code?: unknown })?.code
  return typeof code === 'string' && (code.startsWith('ERR_TLS_') || code.startsWith('ERR_SSL_'))
}

/**
 * Probes one hostname from ON the monitored host, through loopback.
 *
 * This proves the application and the proxy are working. It cannot prove
 * DNS, routing or the certificate a real visitor is handed — that is the
 * external probe's job, and the disagreement between the two is what
 * locates a fault.
 */
export async function probeHostnameOnBox(
  hostname: string,
  fetchImpl: FetchLike,
  timeoutMs: number = DEFAULT_PROBE_TIMEOUT_MS,
): Promise<{ hostname: string; outcome: ProbeOutcome; status: number | null }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const { status } = await fetchImpl(`https://${hostname}/`, {
      signal: controller.signal,
      redirect: 'manual',
    })
    return { hostname, outcome: classifyHttpStatus(status), status }
  } catch (err) {
    return {
      hostname,
      outcome: classifyProbeFailure(isTlsError(err) ? 'tls' : 'network'),
      status: null,
    }
  } finally {
    clearTimeout(timer)
  }
}
```

Then replace `probeUrl`'s inline status branching with `classifyHttpStatus` + `probeOutcomeToHealth` so one rule exists in the tree, and update any test asserting the old all-4xx-are-degraded behaviour.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run agent/src/probe.test.ts` → PASS. Then `npx vitest run` (full suite).

- [ ] **Step 5: Commit**

```bash
git add agent/src/probe.ts agent/src/probe.test.ts agent/src/docker.ts
git commit -m "feat(agent): probe every derived hostname, on-box, through loopback"
```

---

### Task 5: Carry probe results on the wire and store them

**Files:**
- Modify: `shared/src/wire.ts`
- Modify: `web/prisma/schema.prisma`
- Create: `web/prisma/migrations/<timestamp>_probe_results/migration.sql`
- Modify: `web/src/server/ingest.ts` and its test

**Interfaces:**
- Produces:
  - `SystemStateSchema` gains `hostnames: z.array(z.string()).default([])` and
    `onBoxProbes: z.array(z.object({ hostname: z.string(), outcome: ProbeOutcomeSchema, status: z.number().int().nullable() })).default([])`
  - `SystemObservation` gains `hostnames String[]` and `onBoxProbes Json?`

**Migration must be additive and nullable** — it runs as a separate operator step before the new code starts, and an older image must tolerate the newer schema.

- [ ] **Step 1: Write the failing test**

```ts
// append to web/src/server/ingest.test.ts
it('stores the hostnames and per-hostname probe results the agent reported', async () => {
  const host = await prisma.host.create({ data: { name: 'probe-fixture-host' } })
  await ingestSnapshot(host.id, {
    collectedAt: new Date().toISOString(),
    systems: [
      {
        key: 'alpha',
        displayName: 'alpha',
        health: 'degraded',
        containers: { total: 1, running: 1 },
        deployedSha: null,
        deployedSubject: null,
        deployedAt: null,
        driftCommits: null,
        hostnames: ['alpha.example.invalid'],
        onBoxProbes: [{ hostname: 'alpha.example.invalid', outcome: 'proxy-no-upstream', status: 502 }],
      },
    ],
  })
  const obs = await prisma.systemObservation.findFirstOrThrow({ orderBy: { receivedAt: 'desc' } })
  expect(obs.hostnames).toEqual(['alpha.example.invalid'])
  expect(obs.onBoxProbes).toEqual([
    { hostname: 'alpha.example.invalid', outcome: 'proxy-no-upstream', status: 502 },
  ])
})

it('accepts a snapshot from an OLDER agent that sends neither field', async () => {
  // A rolling deploy means the agent and dashboard are briefly different
  // versions. An older agent must not be rejected, and must not be recorded
  // as "no hostnames" in a way that reads as "this system has no vhost".
  const host = await prisma.host.create({ data: { name: 'probe-fixture-host-2' } })
  await expect(
    ingestSnapshot(host.id, {
      collectedAt: new Date().toISOString(),
      systems: [
        {
          key: 'beta',
          displayName: 'beta',
          health: 'healthy',
          containers: { total: 1, running: 1 },
          deployedSha: null,
          deployedSubject: null,
          deployedAt: null,
          driftCommits: null,
        },
      ],
    } as never),
  ).resolves.not.toThrow()
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run web/src/server/ingest.test.ts` → FAIL, `hostnames` is not a column.

- [ ] **Step 3: Write minimal implementation**

Add to `SystemObservation` in `web/prisma/schema.prisma`:

```prisma
  // Derived from the host's proxy config, not configured. Empty means the
  // agent found no vhost for this system -- which the board renders as
  // "no HTTP surface", never as a dash.
  hostnames         String[]
  // One entry per hostname: { hostname, outcome, status }. Json because the
  // shape belongs to the wire schema in shared/, which validates it on the
  // way in; a relational table here would duplicate that contract.
  onBoxProbes       Json?
```

Migration SQL:

```sql
ALTER TABLE "SystemObservation" ADD COLUMN "hostnames" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "SystemObservation" ADD COLUMN "onBoxProbes" JSONB;
```

Extend the Zod schema with `.default([])` on both new fields so an older agent's snapshot validates unchanged, and pass them through in `ingestSnapshot`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run web/src/server/ingest.test.ts` → PASS. Then the full suite.

- [ ] **Step 5: Commit**

```bash
git add shared/src/wire.ts web/prisma web/src/server/ingest.ts web/src/server/ingest.test.ts
git commit -m "feat: carry per-hostname probe results from agent to database"
```

---

### Task 6: The external probe, with certificate expiry from its own handshake

**Files:**
- Create: `web/src/lib/external-probe.ts`, `web/src/lib/external-probe.test.ts`

**Interfaces:**
- Produces:
  - `type ExternalResult = { hostname: string; outcome: ProbeOutcome; status: number | null; certExpiresAt: Date | null }`
  - `probeExternally(hostname: string, deps: ExternalDeps): Promise<ExternalResult>` where
    `type ExternalDeps = { request(hostname: string, signal: AbortSignal): Promise<{ status: number; certExpiresAt: Date | null }>; timeoutMs?: number }`

**Certificate expiry comes from the handshake, not from files.** Files say what should be served; the handshake says what is. They differ exactly when a renewed certificate was never reloaded — an outage this estate has already had.

- [ ] **Step 1: Write the failing test**

```ts
// web/src/lib/external-probe.test.ts
import { describe, it, expect } from 'vitest'
import { probeExternally } from './external-probe.js'

const at = (d: string) => new Date(d)

describe('external probe', () => {
  it('returns the certificate expiry the handshake actually presented', async () => {
    const r = await probeExternally('alpha.example.invalid', {
      request: async () => ({ status: 200, certExpiresAt: at('2026-12-01T00:00:00Z') }),
    })
    expect(r.outcome).toBe('answering')
    expect(r.certExpiresAt).toEqual(at('2026-12-01T00:00:00Z'))
  })

  it('reports a TLS failure as tls-failed with no expiry, not as a dead app', async () => {
    const r = await probeExternally('alpha.example.invalid', {
      request: async () => {
        throw Object.assign(new Error('bad cert'), { code: 'ERR_TLS_CERT_ALTNAME_INVALID' })
      },
    })
    expect(r.outcome).toBe('tls-failed')
    expect(r.certExpiresAt).toBeNull()
  })

  it('does not report an expiry it never saw', async () => {
    const r = await probeExternally('alpha.example.invalid', {
      request: async () => ({ status: 500, certExpiresAt: null }),
    })
    expect(r.outcome).toBe('not-answering')
    expect(r.certExpiresAt).toBeNull()
  })

  it('times out rather than hanging, and says so', async () => {
    const r = await probeExternally('alpha.example.invalid', {
      request: (_h, signal) =>
        new Promise((_res, rej) => signal.addEventListener('abort', () => rej(new Error('aborted')))),
      timeoutMs: 10,
    })
    expect(r.outcome).toBe('not-answering')
  })

  it('never throws', async () => {
    await expect(
      probeExternally('alpha.example.invalid', {
        request: async () => {
          throw new Error('boom')
        },
      }),
    ).resolves.toMatchObject({ outcome: 'not-answering' })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run web/src/lib/external-probe.test.ts` → FAIL, cannot resolve `./external-probe.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// web/src/lib/external-probe.ts
import { classifyHttpStatus, classifyProbeFailure, type ProbeOutcome } from '@bevora-ops/shared'

export type ExternalResult = {
  hostname: string
  outcome: ProbeOutcome
  status: number | null
  certExpiresAt: Date | null
}

export type ExternalDeps = {
  request(hostname: string, signal: AbortSignal): Promise<{ status: number; certExpiresAt: Date | null }>
  timeoutMs?: number
}

export const DEFAULT_EXTERNAL_TIMEOUT_MS = 10_000

function isTlsError(err: unknown): boolean {
  const code = (err as { code?: unknown })?.code
  return typeof code === 'string' && (code.startsWith('ERR_TLS_') || code.startsWith('ERR_SSL_'))
}

/**
 * Probes one hostname the way a visitor reaches it: real DNS, real routing,
 * real TLS. Certificate expiry is whatever THIS handshake presented, which
 * is the only figure that reflects what the proxy is actually serving.
 *
 * Never throws. A probe is a diagnostic; a failure in it is a datum.
 */
export async function probeExternally(hostname: string, deps: ExternalDeps): Promise<ExternalResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? DEFAULT_EXTERNAL_TIMEOUT_MS)
  try {
    const { status, certExpiresAt } = await deps.request(hostname, controller.signal)
    return { hostname, outcome: classifyHttpStatus(status), status, certExpiresAt }
  } catch (err) {
    return {
      hostname,
      outcome: classifyProbeFailure(isTlsError(err) ? 'tls' : 'network'),
      status: null,
      // No expiry is reported when no handshake completed. Reporting a
      // remembered value here would let an expired certificate read as
      // healthy for as long as the memory lasted.
      certExpiresAt: null,
    }
  } finally {
    clearTimeout(timer)
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run web/src/lib/external-probe.test.ts` → PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/external-probe.ts web/src/lib/external-probe.test.ts
git commit -m "feat(web): probe from outside, and take cert expiry from the handshake"
```

---

### Task 7: The two-axis verdict, and the fleet-wide-failure guard

**Files:**
- Create: `web/src/lib/answers.ts`, `web/src/lib/answers.test.ts`

**Interfaces:**
- Produces:
  - `type Axis = { outcome: ProbeOutcome; status: number | null }`
  - `type Verdict = 'healthy' | 'route-broken' | 'app-down' | 'contradiction' | 'unprobed'`
  - `combine(onBox: Axis | null, external: Axis | null): Verdict`
  - `isFleetWideExternalFailure(results: Array<{ outcome: ProbeOutcome }>): boolean`
  - `primaryHostname(hostnames: string[], results: Map<string, ProbeOutcome>): string | null`

- [ ] **Step 1: Write the failing test**

```ts
// web/src/lib/answers.test.ts
import { describe, it, expect } from 'vitest'
import { combine, isFleetWideExternalFailure, primaryHostname } from './answers.js'

const ok = { outcome: 'answering' as const, status: 200 }
const bad = { outcome: 'not-answering' as const, status: null }
const tls = { outcome: 'tls-failed' as const, status: null }

describe('the two-axis verdict', () => {
  it('is healthy only when BOTH axes answer', () => {
    expect(combine(ok, ok)).toBe('healthy')
  })

  // The row this whole slice exists for.
  it('says the ROUTE is broken when the app answers on-box but not outside', () => {
    expect(combine(ok, bad)).toBe('route-broken')
    expect(combine(ok, tls)).toBe('route-broken')
  })

  it('says the app is down when neither answers', () => {
    expect(combine(bad, bad)).toBe('app-down')
  })

  it('flags a contradiction rather than picking a winner', () => {
    expect(combine(bad, ok)).toBe('contradiction')
  })

  it('is unprobed when neither axis ran, and never healthy', () => {
    expect(combine(null, null)).toBe('unprobed')
  })

  it('does not call a system healthy on one axis alone', () => {
    expect(combine(ok, null)).not.toBe('healthy')
    expect(combine(null, ok)).not.toBe('healthy')
  })
})

describe('fleet-wide external failure', () => {
  it('is true only when EVERY external probe failed', () => {
    expect(isFleetWideExternalFailure([{ outcome: 'not-answering' }, { outcome: 'tls-failed' }])).toBe(true)
  })

  it('is false when even one answered — that is a real outage, not our network', () => {
    expect(isFleetWideExternalFailure([{ outcome: 'not-answering' }, { outcome: 'answering' }])).toBe(false)
  })

  it('is false for an empty set, which proves nothing', () => {
    expect(isFleetWideExternalFailure([])).toBe(false)
  })
})

describe('primary hostname', () => {
  it('prefers one that answers', () => {
    const r = new Map([['zzz.example.invalid', 'answering' as const], ['a.example.invalid', 'not-answering' as const]])
    expect(primaryHostname(['a.example.invalid', 'zzz.example.invalid'], r)).toBe('zzz.example.invalid')
  })

  it('falls back to shortest, then alphabetical, so it never changes between refreshes', () => {
    const r = new Map<string, never>()
    expect(primaryHostname(['bbb.example.invalid', 'a.example.invalid'], r)).toBe('a.example.invalid')
    expect(primaryHostname(['b.example.invalid', 'a.example.invalid'], r)).toBe('a.example.invalid')
  })

  it('is null when there are no hostnames', () => {
    expect(primaryHostname([], new Map())).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run web/src/lib/answers.test.ts` → FAIL, cannot resolve `./answers.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// web/src/lib/answers.ts
import type { ProbeOutcome } from '@bevora-ops/shared'

export type Axis = { outcome: ProbeOutcome; status: number | null }
export type Verdict = 'healthy' | 'route-broken' | 'app-down' | 'contradiction' | 'unprobed'

const answers = (a: Axis | null): boolean =>
  a !== null && (a.outcome === 'answering' || a.outcome === 'answering-oddly')

/**
 * Combines the two probes WITHOUT collapsing them into a boolean.
 *
 * `route-broken` is the reason this design has two probes at all: the
 * application is provably fine on the machine, and something between it and
 * the world -- DNS, routing, firewall, certificate -- is not. Neither probe
 * alone can produce that statement, and it is the one that turns "something
 * is wrong" into "here is where".
 *
 * `contradiction` is not resolved by preferring an axis. It is rare, it
 * usually means a cache or CDN is serving what the origin cannot, and
 * guessing which probe to believe would be inventing a fact.
 */
export function combine(onBox: Axis | null, external: Axis | null): Verdict {
  if (onBox === null && external === null) return 'unprobed'
  if (onBox === null || external === null) return 'unprobed'
  if (answers(onBox) && answers(external)) return 'healthy'
  if (answers(onBox) && !answers(external)) return 'route-broken'
  if (!answers(onBox) && !answers(external)) return 'app-down'
  return 'contradiction'
}

/**
 * True only when every external probe in the cycle failed, which is the
 * dashboard's own network rather than every system dying at once.
 *
 * Empty is FALSE: nothing was probed, so nothing was learned, and an empty
 * set must never be read as evidence of anything. That is the same
 * empty-input trap this project has already hit twice in its verification
 * script.
 */
export function isFleetWideExternalFailure(results: Array<{ outcome: ProbeOutcome }>): boolean {
  if (results.length === 0) return false
  return results.every((r) => r.outcome !== 'answering' && r.outcome !== 'answering-oddly')
}

/**
 * Picks the hostname the row displays. Arbitrary but TOTAL: the same input
 * always yields the same answer, so the board's most prominent column does
 * not change between refreshes for no reason.
 */
export function primaryHostname(hostnames: string[], results: Map<string, ProbeOutcome>): string | null {
  if (hostnames.length === 0) return null
  const sorted = [...hostnames].sort((a, b) => {
    const aOk = results.get(a) === 'answering' ? 0 : 1
    const bOk = results.get(b) === 'answering' ? 0 : 1
    if (aOk !== bOk) return aOk - bOk
    if (a.length !== b.length) return a.length - b.length
    return a < b ? -1 : 1
  })
  return sorted[0] ?? null
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run web/src/lib/answers.test.ts` → PASS, 12 tests.

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/answers.ts web/src/lib/answers.test.ts
git commit -m "feat(web): a two-axis verdict that names where the fault is"
```

---

### Task 8: The board says it — URL, Answers, Cert

**Files:**
- Modify: `web/src/components/FleetTable.tsx`, `web/src/components/FleetTable.test.tsx`
- Modify: `web/src/lib/fleet-query.ts` and its test
- Modify: `web/src/app/globals.css`

**Interfaces:**
- Consumes: `combine`, `primaryHostname`, `isFleetWideExternalFailure` (Task 7); the stored `hostnames` and `onBoxProbes` (Task 5); `ExternalResult` (Task 6).

**Required behaviour:**
- **URL** column: the primary hostname, linked. A system with no hostnames renders **"no HTTP surface"** — never a dash, which reads as "unknown".
- **Answers** column: the verdict in words, not only a colour. `route-broken` reads as *"app up, route broken"*; `proxy-no-upstream` reads as *"proxy up, app not responding"*; `contradiction` says so.
- **Cert** column: days remaining; amber under 21, red under 7; **"no certificate"** where TLS is configured without one.
- A system with several hostnames shows the primary and expands to show each with its own result. **One failing hostname must not be averaged into a green row.**
- When `isFleetWideExternalFailure` is true, the board shows a banner saying the dashboard could not reach anything and falls back to displaying on-box results — it must NOT turn every row red.

- [ ] **Step 1: Write the failing test**

```tsx
// append to web/src/components/FleetTable.test.tsx
it('renders "no HTTP surface" for a system with no hostnames, never a dash', () => {
  render(<FleetTable rows={[row({ hostnames: [], verdict: 'unprobed' })]} />)
  expect(screen.getByText(/no http surface/i)).toBeTruthy()
  expect(screen.queryByText('—')).toBeNull()
})

it('says the route is broken, in words, not just a colour', () => {
  render(<FleetTable rows={[row({ verdict: 'route-broken' })]} />)
  expect(screen.getByText(/route broken/i)).toBeTruthy()
})

it('does not average a failing hostname into a green row', () => {
  render(
    <FleetTable rows={[row({
      hostnames: ['a.example.invalid', 'b.example.invalid'],
      perHostname: [
        { hostname: 'a.example.invalid', outcome: 'answering' },
        { hostname: 'b.example.invalid', outcome: 'not-answering' },
      ],
      verdict: 'app-down',
    })]} />,
  )
  expect(screen.queryByText(/^healthy$/i)).toBeNull()
})

it('shows a probe-side banner instead of reddening every row', () => {
  render(<FleetTable rows={[row({ verdict: 'healthy' })]} externalProbeFailedFleetWide />)
  expect(screen.getByText(/could not reach/i)).toBeTruthy()
})

it('shows a certificate under 7 days as red, not amber', () => {
  render(<FleetTable rows={[row({ certDaysRemaining: 3 })]} />)
  expect(screen.getByTestId('cert-cell')).toHaveAttribute('data-severity', 'red')
})

it('says "no certificate" where TLS is configured without one', () => {
  render(<FleetTable rows={[row({ certDaysRemaining: null, tlsConfigured: true })]} />)
  expect(screen.getByText(/no certificate/i)).toBeTruthy()
})
```

Add a `row()` fixture helper in the test file with invented hostnames only.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run web/src/components/FleetTable.test.tsx` → FAIL, the props do not exist.

- [ ] **Step 3: Write minimal implementation**

Extend `FleetRow` with `hostnames: string[]`, `perHostname: Array<{ hostname: string; outcome: ProbeOutcome }>`, `verdict: Verdict`, `certDaysRemaining: number | null`, `tlsConfigured: boolean`; add the three columns and the banner. Style only through existing custom properties in `globals.css`; both themes must read correctly.

Extend `fleet-query.ts` to select the new observation columns, join the latest external result per hostname, and compute `verdict` via `combine` and the display hostname via `primaryHostname`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run` (full suite) and `npx tsc -b`.

- [ ] **Step 5: Commit**

```bash
git add web/src/components/FleetTable.tsx web/src/components/FleetTable.test.tsx web/src/lib/fleet-query.ts web/src/lib/fleet-query.test.ts web/src/app/globals.css
git commit -m "feat(web): the board names the fault, and never shows a hopeful dash"
```

---

### Task 9: Schedule the external probe, deploy, verify

**Files:**
- Create: `web/src/lib/probe-scheduler.ts` and its test
- Modify: `deploy/verify-vault.sh` → add probe checks, or create `deploy/verify-board.sh`
- Modify: `deploy/README.md`

**Cadence:** external probes run **every 5 minutes**, not every cycle — real internet traffic against real applications, three of which belong to another business. The board shows the **age of the last external result** so a stale one is never mistaken for a fresh one.

- [ ] **Step 1: Write the failing test**

```ts
// web/src/lib/probe-scheduler.test.ts
import { describe, it, expect, vi } from 'vitest'
import { shouldRunExternalProbe, EXTERNAL_PROBE_INTERVAL_MS } from './probe-scheduler.js'

describe('external probe cadence', () => {
  it('runs when nothing has ever run', () => {
    expect(shouldRunExternalProbe(null, new Date('2026-08-03T00:00:00Z'))).toBe(true)
  })

  it('does not run again within the interval', () => {
    const last = new Date('2026-08-03T00:00:00Z')
    const soon = new Date(last.getTime() + EXTERNAL_PROBE_INTERVAL_MS - 1)
    expect(shouldRunExternalProbe(last, soon)).toBe(false)
  })

  it('runs once the interval has elapsed', () => {
    const last = new Date('2026-08-03T00:00:00Z')
    const later = new Date(last.getTime() + EXTERNAL_PROBE_INTERVAL_MS)
    expect(shouldRunExternalProbe(last, later)).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run web/src/lib/probe-scheduler.test.ts` → FAIL, cannot resolve.

- [ ] **Step 3: Write minimal implementation**

```ts
// web/src/lib/probe-scheduler.ts

/**
 * Five minutes, not every 30-second cycle. The external probe is real
 * internet traffic against real applications -- three of the monitored
 * stacks belong to another business -- and a certificate does not change
 * between two ticks. The board displays the age of the last result so a
 * stale reading is never presented as a current one.
 */
export const EXTERNAL_PROBE_INTERVAL_MS = 300_000

export function shouldRunExternalProbe(lastRunAt: Date | null, now: Date): boolean {
  if (lastRunAt === null) return true
  return now.getTime() - lastRunAt.getTime() >= EXTERNAL_PROBE_INTERVAL_MS
}
```

Give the external prober a distinct user-agent (`bevora-ops-probe/1`) so the traffic is identifiable in the logs of the applications being probed.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run` → full suite green. `npx tsc -b`. `node scripts/ci/assert-no-environment-leakage.mjs`.

- [ ] **Step 5: Deploy and verify**

Run the verification BEFORE deploying and record that it fails — a check that passes before the feature exists is not testing what it claims.

```bash
# On the dashboard host. PULL BEFORE MIGRATE -- migrations are baked into
# the image and compose's `run` pull policy is `missing`, so migrate-first
# runs inside the stale cached image and lands new code on an old schema.
cd /opt/bevora-ops && git fetch origin && git reset --hard origin/main
export GHCR_OWNER=<owner> TAG=latest INGEST_BIND_ADDR=<this host's private address>
docker compose pull web ingest
docker compose run --rm --pull always web /deploy/with-database-url.sh \
  npx prisma migrate deploy --schema web/prisma/schema.prisma
docker compose up -d web ingest
bash deploy/verify-board.sh
```

Then confirm on the live board that the systems whose hostnames have no certificate render as **TLS fails**, not as *app down* — that distinction is the slice's core claim and the host already has three such hostnames to prove it against.

- [ ] **Step 6: Commit**

```bash
git add web/src/lib/probe-scheduler.ts web/src/lib/probe-scheduler.test.ts deploy/
git commit -m "feat: schedule the external probe, and verify the board on the box"
```

---

## Self-Review

**Spec coverage.** §3 two probes — Tasks 4, 6, 7. §4 discovery — Tasks 2, 3. §5 classification — Task 1. §5.1 cadence — Task 9. §5.2 primary hostname — Task 7. §6 certificates from handshake — Task 6. §8 interface and the reachability gate — Task 8. §9 failure modes: fleet-wide guard — Tasks 7, 8; probe-that-could-not-run — Tasks 1, 3, 6; per-probe timeout — Tasks 4, 6; identifiable traffic — Task 9. §10 testing — throughout.

**Known gap, deliberate:** §7's two survey findings are observations for the operator to fix on the host, not code. The board will display them; the plan does not repair them.

**Type consistency.** `ProbeOutcome` is defined in Task 1 and consumed in 4, 6, 7. `Axis`/`Verdict` are defined in Task 7 and consumed in 8. `FetchLike` and `DEFAULT_PROBE_TIMEOUT_MS` already exist in `agent/src/probe.ts` and are reused in Task 4 rather than redefined. `hostnames` and `onBoxProbes` are named identically in the Zod schema, the Prisma model and the query.

**Carried risk to watch in review:** Task 4 changes `probeUrl`'s existing all-4xx-is-degraded rule. Any slice-1 test asserting the old behaviour must be updated deliberately, not deleted to make the suite green.
