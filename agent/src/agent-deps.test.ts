import { describe, it, expect } from 'vitest'
import { buildCollectDeps, buildHostnamesByPort, type DockerLike } from './agent-deps.js'
import type { AgentConfig } from './config.js'
import type { FetchLike } from './probe.js'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
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
// buildCollectDeps/buildHostnamesByPort into their own side-effect-free
// module is what makes these assertions possible at all.
describe('buildCollectDeps', () => {
  it('wires both on-box probing keys -- deleting either in main.ts used to typecheck, pass every test, and silently revert on-box probing to inert', () => {
    const deps = buildCollectDeps(makeConfig(), noContainers)
    expect(deps.hostnamesByPort).toBeTypeOf('function')
    expect(deps.probeOnBoxHostname).toBeTypeOf('function')
  })

  it('probeOnBoxHostname genuinely calls through to a real on-box probe: loopback port, not the hostname, with an explicit Host header', async () => {
    const calls: Array<{ url: string; headers: Record<string, string> | undefined }> = []
    const fakeFetch: FetchLike = async (url, init) => {
      calls.push({ url, headers: init.headers })
      return { status: 200 }
    }
    const deps = buildCollectDeps(makeConfig(), noContainers, fakeFetch)
    const result = await deps.probeOnBoxHostname!('alpha.example.invalid', 8081)
    expect(calls).toEqual([{ url: 'http://127.0.0.1:8081/', headers: { Host: 'alpha.example.invalid' } }])
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

describe('buildHostnamesByPort', () => {
  it('discovers hostnames by port when the vhost directory is reachable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-deps-'))
    try {
      await mkdir(join(root, 'enabled'))
      await writeFile(
        join(root, 'enabled', 'a.conf'),
        'server { server_name found.example.invalid; location / { proxy_pass http://127.0.0.1:8081; } }',
      )
      const warn: unknown[][] = []
      const byPort = await buildHostnamesByPort(join(root, 'enabled'), { warn: (...a) => warn.push(a) })()
      expect(byPort?.get(8081)).toEqual(['found.example.invalid'])
      expect(warn).toHaveLength(0)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('logs and returns null, never an empty map, when the vhost directory cannot be read', async () => {
    const warn: unknown[][] = []
    const byPort = await buildHostnamesByPort('/definitely/does/not/exist/on/this/machine', { warn: (...a) => warn.push(a) })()
    expect(byPort).toBeNull()
    expect(warn).toHaveLength(1)
    expect(String(warn[0]![0])).toContain('vhost directory unreadable')
  })
})
