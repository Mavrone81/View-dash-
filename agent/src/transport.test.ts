import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { WebSocketServer, type WebSocket as WsSocket } from 'ws'
import { createServer, type Server, type AddressInfo } from 'node:net'
import { nextBackoffMs, AgentTransport } from './transport.js'
import type { AgentConfig } from './config.js'
import type { FleetSnapshot } from '@bevora-ops/shared'

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

const snapshot: FleetSnapshot = { collectedAt: '2026-08-01T12:00:00.000Z', systems: [] }

function makeConfig(over: Partial<AgentConfig> = {}): AgentConfig {
  return {
    hostName: 'proj-a',
    dashboardUrl: 'ws://127.0.0.1:1/unused',
    token: 'sekret-bearer-token-value',
    deployLogGlob: '/var/log/deploy-*.log',
    repoRoot: '/srv/repos',
    intervalMs: 30_000,
    // The probe is off in this fixture: AgentTransport does not probe
    // anything, and an empty map is also the real-deployment default.
    systemUrls: {},
    probeTimeoutMs: 5_000,
    vhostDir: '/etc/nginx/sites-enabled',
    ...over,
  }
}

describe('AgentTransport', () => {
  let server: WebSocketServer
  let port: number
  let received: { data: string; authorization: string | undefined }[]

  beforeEach(async () => {
    received = []
    server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    await new Promise<void>((resolve) => server.once('listening', resolve))
    port = (server.address() as AddressInfo).port
    server.on('connection', (ws: WsSocket, req) => {
      ws.on('message', (data: Buffer) => {
        received.push({ data: data.toString(), authorization: req.headers.authorization })
      })
    })
  })

  afterEach(async () => {
    for (const client of server.clients) client.terminate()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it('dials out to the dashboard and delivers the snapshot as a bearer-authenticated message', async () => {
    const cfg = makeConfig({ dashboardUrl: `ws://127.0.0.1:${port}`, token: 'sekret-bearer-token-value' })
    const transport = new AgentTransport(cfg)
    await transport.send(snapshot)
    // Two messages: the one-shot `hello` (asserted on its own below) and
    // then the snapshot.
    await vi.waitFor(() => expect(received).toHaveLength(2))
    expect(received[1]!.authorization).toBe('Bearer sekret-bearer-token-value')
    expect(JSON.parse(received[1]!.data)).toEqual({ type: 'snapshot', payload: snapshot })
  })

  it('holds the connection open: a second send reuses the same socket rather than reconnecting', async () => {
    const connections: unknown[] = []
    server.on('connection', (ws) => connections.push(ws))
    const cfg = makeConfig({ dashboardUrl: `ws://127.0.0.1:${port}` })
    const transport = new AgentTransport(cfg)
    await transport.send(snapshot)
    await transport.send(snapshot)
    // hello + two snapshots.
    await vi.waitFor(() => expect(received).toHaveLength(3))
    expect(connections).toHaveLength(1)
  })

  // AGENT_HOST_NAME was a required agent setting that nothing anywhere read.
  // This is what now reads it: the agent states, once per connection, what
  // its own config believes this host is called, so the dashboard can
  // compare that against the host its TOKEN belongs to and log a mismatch.
  // It remains advisory -- the token is what identifies this agent.
  it('states its configured host name once, before the first snapshot', async () => {
    const cfg = makeConfig({ dashboardUrl: `ws://127.0.0.1:${port}`, hostName: 'proj-a' })
    const transport = new AgentTransport(cfg)
    await transport.send(snapshot)
    await vi.waitFor(() => expect(received).toHaveLength(2))
    expect(JSON.parse(received[0]!.data)).toEqual({ type: 'hello', hostName: 'proj-a' })
  })

  it('does not repeat the hello on every send, only once per connection', async () => {
    const cfg = makeConfig({ dashboardUrl: `ws://127.0.0.1:${port}` })
    const transport = new AgentTransport(cfg)
    await transport.send(snapshot)
    await transport.send(snapshot)
    await transport.send(snapshot)
    await vi.waitFor(() => expect(received).toHaveLength(4))
    const hellos = received.filter((r) => JSON.parse(r.data).type === 'hello')
    expect(hellos).toHaveLength(1)
  })

  it('never puts the bearer token in the hello message body', async () => {
    const cfg = makeConfig({ dashboardUrl: `ws://127.0.0.1:${port}`, token: 'sekret-bearer-token-value' })
    const transport = new AgentTransport(cfg)
    await transport.send(snapshot)
    await vi.waitFor(() => expect(received).toHaveLength(2))
    expect(received[0]!.data).not.toContain('sekret-bearer-token-value')
  })

  it('never throws when the dashboard is unreachable: it backs off instead of killing the agent', async () => {
    // Nothing listens on this port: the connection will fail every time.
    const cfg = makeConfig({ dashboardUrl: 'ws://127.0.0.1:1/unreachable' })
    const transport = new AgentTransport(cfg, { base: 5, cap: 20 })
    await expect(transport.send(snapshot)).resolves.toBeUndefined()
  })

  it('never logs the bearer token, even when a send fails', async () => {
    const cfg = makeConfig({ dashboardUrl: 'ws://127.0.0.1:1/unreachable', token: 'sekret-bearer-token-value' })
    const transport = new AgentTransport(cfg, { base: 5, cap: 20 })
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await transport.send(snapshot)
      const logged = spy.mock.calls.map((args) => args.map(String).join(' ')).join('\n')
      expect(logged).not.toContain('sekret-bearer-token-value')
    } finally {
      spy.mockRestore()
    }
  })
})

// The backoff has to SUPPRESS reconnection attempts, not merely sleep
// inside the call that failed. The agent's loop (agent/src/main.ts) fires a
// tick on a fixed interval; a backoff implemented as `await sleep(wait)`
// inside `send` delays only the tick that already failed, while every
// SUBSEQUENT tick still dials a brand-new socket on schedule. During a
// dashboard outage that means one fresh connection attempt every interval
// forever, no matter how large the computed backoff got -- the cap is
// decorative. These tests measure the thing that actually matters: how many
// times the transport touches the network, not how long a call took.
//
// A plain TCP server stands in for an unreachable dashboard: it ACCEPTS the
// connection (so the attempt is observable and countable) and then destroys
// it without ever completing a WebSocket handshake, so `send` fails exactly
// as it would against a dead dashboard.
describe('AgentTransport backoff suppression', () => {
  let tcp: Server
  let tcpPort: number
  let attempts: number

  beforeEach(async () => {
    attempts = 0
    tcp = createServer((socket) => {
      attempts++
      socket.destroy()
    })
    await new Promise<void>((resolve) => tcp.listen(0, '127.0.0.1', resolve))
    tcpPort = (tcp.address() as AddressInfo).port
  })

  afterEach(async () => {
    await new Promise<void>((resolve) => tcp.close(() => resolve()))
  })

  it('does not open a second socket while the backoff from a failed send is still in effect', async () => {
    let clock = 0
    const cfg = makeConfig({ dashboardUrl: `ws://127.0.0.1:${tcpPort}` })
    const transport = new AgentTransport(cfg, { base: 60_000, cap: 60_000 }, () => clock)
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await transport.send(snapshot)
      await vi.waitFor(() => expect(attempts).toBe(1))

      // Two further ticks land while the 60s backoff is still running. A
      // sleep-based backoff cannot stop either of them: the sleep happened
      // inside the previous call and has no bearing on this one.
      clock += 1_000
      await transport.send(snapshot)
      clock += 1_000
      await transport.send(snapshot)

      // Give any (wrongly) opened socket time to reach the listener before
      // asserting it did not -- otherwise this would pass simply by being
      // faster than the connection.
      await new Promise((r) => setTimeout(r, 150))
      expect(attempts).toBe(1)
    } finally {
      spy.mockRestore()
    }
  })

  it('retries once the backoff has actually elapsed, so suppression is a delay and never a permanent stop', async () => {
    let clock = 0
    const cfg = makeConfig({ dashboardUrl: `ws://127.0.0.1:${tcpPort}` })
    const transport = new AgentTransport(cfg, { base: 60_000, cap: 60_000 }, () => clock)
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await transport.send(snapshot)
      await vi.waitFor(() => expect(attempts).toBe(1))

      clock += 60_001
      await transport.send(snapshot)
      await vi.waitFor(() => expect(attempts).toBe(2))
    } finally {
      spy.mockRestore()
    }
  })

  it('returns immediately while suppressed rather than blocking its caller for the backoff duration', async () => {
    // The old implementation slept the full backoff inside `send`, which
    // also made the agent's collection loop `await` it. With a 60s backoff
    // that is a 60s stall; this asserts the call is now effectively free.
    let clock = 0
    const cfg = makeConfig({ dashboardUrl: `ws://127.0.0.1:${tcpPort}` })
    const transport = new AgentTransport(cfg, { base: 60_000, cap: 60_000 }, () => clock)
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await transport.send(snapshot)
      const startedAt = Date.now()
      await transport.send(snapshot)
      expect(Date.now() - startedAt).toBeLessThan(1_000)
    } finally {
      spy.mockRestore()
    }
  })
})
