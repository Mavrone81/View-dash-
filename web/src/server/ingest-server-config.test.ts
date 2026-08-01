import { describe, it, expect } from 'vitest'
import { loadIngestServerConfig } from './ingest-server-config.js'

describe('loadIngestServerConfig', () => {
  it('defaults to loopback: exposure is a deployment decision, made explicitly via INGEST_SERVER_HOST, never a silent default', () => {
    expect(loadIngestServerConfig({})).toMatchObject({ host: '127.0.0.1' })
  })

  it('defaults to a sensible port when none is configured', () => {
    const cfg = loadIngestServerConfig({})
    expect(cfg.port).toBeGreaterThan(0)
    expect(Number.isInteger(cfg.port)).toBe(true)
  })

  it('honours an overridden host and port from the environment', () => {
    const cfg = loadIngestServerConfig({ INGEST_SERVER_HOST: '127.0.0.1', INGEST_SERVER_PORT: '9999' })
    expect(cfg).toMatchObject({ host: '127.0.0.1', port: 9999 })
  })

  it('bounds the message size by default, well below ws\'s own 100 MB', () => {
    // This listener is internet-facing (TLS terminates at a proxy in front
    // of it) and runs on a 1 GB droplet. `ws`'s 100 MB default is an
    // out-of-memory condition anyone can request; a real snapshot is a few
    // kilobytes.
    const cfg = loadIngestServerConfig({})
    expect(cfg.maxPayloadBytes).toBeGreaterThan(0)
    expect(cfg.maxPayloadBytes).toBeLessThanOrEqual(4 * 1024 * 1024)
  })

  it('caps concurrent connections by default', () => {
    const cfg = loadIngestServerConfig({})
    expect(cfg.maxConnections).toBeGreaterThan(0)
    expect(Number.isInteger(cfg.maxConnections)).toBe(true)
  })

  it('honours overridden limits from the environment', () => {
    const cfg = loadIngestServerConfig({ INGEST_MAX_PAYLOAD_BYTES: '2048', INGEST_MAX_CONNECTIONS: '3' })
    expect(cfg.maxPayloadBytes).toBe(2048)
    expect(cfg.maxConnections).toBe(3)
  })
})
