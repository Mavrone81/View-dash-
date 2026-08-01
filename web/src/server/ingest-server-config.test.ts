import { describe, it, expect } from 'vitest'
import { loadIngestServerConfig } from './ingest-server-config.js'

describe('loadIngestServerConfig', () => {
  it('defaults to binding every interface, since this listener is reached from a different machine', () => {
    expect(loadIngestServerConfig({})).toMatchObject({ host: '0.0.0.0' })
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
