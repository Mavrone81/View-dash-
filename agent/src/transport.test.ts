import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { WebSocketServer, type WebSocket as WsSocket } from 'ws'
import type { AddressInfo } from 'node:net'
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
    await vi.waitFor(() => expect(received).toHaveLength(1))
    expect(received[0]!.authorization).toBe('Bearer sekret-bearer-token-value')
    expect(JSON.parse(received[0]!.data)).toEqual({ type: 'snapshot', payload: snapshot })
  })

  it('holds the connection open: a second send reuses the same socket rather than reconnecting', async () => {
    const connections: unknown[] = []
    server.on('connection', (ws) => connections.push(ws))
    const cfg = makeConfig({ dashboardUrl: `ws://127.0.0.1:${port}` })
    const transport = new AgentTransport(cfg)
    await transport.send(snapshot)
    await transport.send(snapshot)
    await vi.waitFor(() => expect(received).toHaveLength(2))
    expect(connections).toHaveLength(1)
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
