import { describe, it, expect } from 'vitest'
import { buildCollectDeps, buildVhostDiscovery, type DockerLike } from './agent-deps.js'
import type { AgentConfig } from './config.js'
import type { FetchLike, OnBoxRequestLike } from './probe.js'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createServer } from 'node:http'
import { join } from 'node:path'

function makeConfig(over: Partial<AgentConfig> = {}): AgentConfig {
  return {
    hostName: 'proj-a',
    dashboardUrl: 'wss://dashboard.example.test/agent/ingest',
    token: 'sekret-bearer-token-value',
    deployLogGlob: '/var/log/deploy-*.log',
    repoRoot: '/srv/repos',
    intervalMs: 30_000,
    systemUrls: {},
    probeTimeoutMs: 5_000,
    vhostDir: '/etc/nginx/sites-enabled',
    ...over,
  }
}

const noContainers: DockerLike = { listContainers: async () => [] }

// This suite exists because a seam review found the wiring it pins here
// living only in main.ts, which nothing could import to test without also
// running the whole agent (loadConfig() at module scope, a real Docker
// connection, an immediately-started tick interval). Extracting
// buildCollectDeps/buildVhostDiscovery into their own side-effect-free
// module is what makes these assertions possible at all.
describe('buildCollectDeps', () => {
  it('wires onBoxProbing as a real object with both functions -- fix round 2: hostnamesByPort/probeOnBoxHostname used to be two separate OPTIONAL keys, either deletable without a type error; Task 5 initially split the vhost read into a third field (tlsByHostname), then fix round 2 (this shape) merged it back into ONE vhostDiscovery field precisely because two independent reads of the same directory could disagree with each other', () => {
    const deps = buildCollectDeps(makeConfig(), noContainers)
    expect(deps.onBoxProbing).not.toBeNull()
    expect(deps.onBoxProbing!.vhostDiscovery).toBeTypeOf('function')
    expect(deps.onBoxProbing!.probeOnBoxHostname).toBeTypeOf('function')
  })

  it('probeOnBoxHostname wires hostname and port through to the on-box transport unmodified (argument shape, not wire delivery -- see the real-transport suite below for that)', async () => {
    const calls: Array<{ port: number; hostname: string | null }> = []
    const fakeRequest: OnBoxRequestLike = async (port, hostname) => {
      calls.push({ port, hostname })
      return { status: 200 }
    }
    const deps = buildCollectDeps(makeConfig(), noContainers, fetch, fakeRequest)
    const result = await deps.onBoxProbing!.probeOnBoxHostname('alpha.example.invalid', 8081)
    expect(calls).toEqual([{ port: 8081, hostname: 'alpha.example.invalid' }])
    expect(result.outcome).toBe('answering')
  })

  it('probe (the external axis) genuinely calls through to the given URL, unmodified, with no Host override', async () => {
    const calls: string[] = []
    const fakeFetch: FetchLike = async (url) => {
      calls.push(url)
      return { status: 200 }
    }
    const deps = buildCollectDeps(makeConfig(), noContainers, fakeFetch)
    await deps.probe!('https://alpha.example.invalid/')
    expect(calls).toEqual(['https://alpha.example.invalid/'])
  })

  it('listContainers calls through to the injected Docker-like object', async () => {
    const seen: Array<{ all: boolean }> = []
    const docker: DockerLike = {
      listContainers: async (opts) => {
        seen.push(opts)
        return [{ Names: ['/a'], State: 'running' }]
      },
    }
    const deps = buildCollectDeps(makeConfig(), docker)
    const out = await deps.listContainers()
    expect(seen).toEqual([{ all: true }])
    expect(out).toEqual([{ names: ['/a'], project: null, state: 'running', health: null, publishedPorts: [] }])
  })
})

// Fix round 2's Critical: a fetch-based on-box probe silently dropped the
// Host header entirely (undici enforces WHATWG's "forbidden header name"
// list by dropping it, not erroring) -- reproduced against a real
// node:http server on Node v22.23.1. `agent-deps.test.ts`'s and
// `probe.test.ts`'s previous tests both pinned the ARGUMENT handed to a
// fake transport, never what actually reached a server -- the same seam
// fix round 1 closed one layer up, reopened one layer down. This suite
// runs `buildCollectDeps`'s REAL, UN-FAKED transport (no `onBoxRequestImpl`
// override) against a real listener and reads the header the listener
// actually received.
describe('the real on-box transport, exercised end to end (not a recorded argument)', () => {
  it('genuinely delivers the Host header over the wire to a real listener', async () => {
    const seenHosts: Array<string | undefined> = []
    const server = createServer((req, res) => {
      seenHosts.push(req.headers.host)
      res.writeHead(200)
      res.end()
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    try {
      const address = server.address()
      if (address === null || typeof address === 'string') throw new Error('expected a real TCP address')
      const deps = buildCollectDeps(makeConfig(), noContainers)
      const result = await deps.onBoxProbing!.probeOnBoxHostname('alpha.example.invalid', address.port)
      expect(seenHosts).toEqual(['alpha.example.invalid'])
      expect(result.outcome).toBe('answering')
      expect(result.status).toBe(200)
    } finally {
      server.close()
    }
  })

  it('sends no claimed Host at all for a null hostname -- the listener sees its own address, never a literal "null"', async () => {
    const seenHosts: Array<string | undefined> = []
    const server = createServer((req, res) => {
      seenHosts.push(req.headers.host)
      res.writeHead(200)
      res.end()
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    try {
      const address = server.address()
      if (address === null || typeof address === 'string') throw new Error('expected a real TCP address')
      const deps = buildCollectDeps(makeConfig(), noContainers)
      await deps.onBoxProbing!.probeOnBoxHostname(null, address.port)
      expect(seenHosts).toHaveLength(1)
      expect(seenHosts[0]).not.toContain('null')
    } finally {
      server.close()
    }
  })
})

describe('buildVhostDiscovery', () => {
  it('discovers hostnames by port AND the TLS bit per hostname, from one reachable read', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-deps-'))
    try {
      await mkdir(join(root, 'enabled'))
      await writeFile(
        join(root, 'enabled', 'a.conf'),
        'server { listen 443 ssl; server_name found.example.invalid; location / { proxy_pass http://127.0.0.1:8081; } }',
      )
      const warn: unknown[][] = []
      const discovery = await buildVhostDiscovery(join(root, 'enabled'), { warn: (...a) => warn.push(a) })()
      expect(discovery?.byPort.get(8081)).toEqual(['found.example.invalid'])
      expect(discovery?.tlsByHostname.get('found.example.invalid')).toBe(true)
      expect(warn).toHaveLength(0)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('logs and returns null, never an empty discovery, when the vhost directory cannot be read', async () => {
    const warn: unknown[][] = []
    const discovery = await buildVhostDiscovery('/definitely/does/not/exist/on/this/machine', { warn: (...a) => warn.push(a) })()
    expect(discovery).toBeNull()
    expect(warn).toHaveLength(1)
    expect(String(warn[0]![0])).toContain('vhost directory unreadable')
  })
})

describe('buildCollectDeps wires vhostDiscovery through to real vhost data', () => {
  it('genuinely reads the vhost directory, not a stub -- both maps agree, because they come from the same read', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-deps-wired-tls-'))
    try {
      await mkdir(join(root, 'enabled'))
      await writeFile(
        join(root, 'enabled', 'a.conf'),
        'server { listen 443 ssl; server_name wired.example.invalid; location / { proxy_pass http://127.0.0.1:8081; } }',
      )
      const deps = buildCollectDeps(makeConfig({ vhostDir: join(root, 'enabled') }), noContainers)
      const discovery = await deps.onBoxProbing!.vhostDiscovery()
      expect(discovery?.byPort.get(8081)).toEqual(['wired.example.invalid'])
      expect(discovery?.tlsByHostname.get('wired.example.invalid')).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  // Fix round 2: pins that the PRODUCTION wiring exposes exactly one
  // vhost-discovery function, not the old hostnamesByPort/tlsByHostname
  // pair each backed by its own independent directory read. The actual
  // per-call read-COUNT assertion (proving `discoverVhostsFromDir` itself
  // never reads a file twice) lives in vhosts.test.ts, closer to the real
  // mechanism; this test only guards against `onBoxProbing`'s shape
  // silently regressing back to two separate fields at this layer.
  it('exposes exactly one vhost-discovery function on onBoxProbing, not a hostnamesByPort/tlsByHostname pair', async () => {
    const deps = buildCollectDeps(makeConfig(), noContainers)
    const keys = Object.keys(deps.onBoxProbing!).sort()
    expect(keys).toEqual(['probeOnBoxHostname', 'vhostDiscovery'])
  })
})
