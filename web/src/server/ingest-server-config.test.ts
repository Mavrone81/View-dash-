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
    expect(cfg).toEqual({ host: '127.0.0.1', port: 9999 })
  })
})
