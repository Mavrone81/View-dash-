export type IngestServerConfig = { host: string; port: number }

const DEFAULT_HOST = '0.0.0.0'
const DEFAULT_PORT = 4100

/**
 * This listener is dialed into from a DIFFERENT machine than the dashboard,
 * across the internet, with TLS terminated at a reverse proxy in front of
 * it -- unlike the Next.js app (loopback-only for slice 1), it cannot
 * assume its peer is local, so the default host binds every interface
 * rather than defaulting to loopback. Both values are still overridable
 * from the environment (never hardcoded at the call site).
 */
export function loadIngestServerConfig(env: NodeJS.ProcessEnv = process.env): IngestServerConfig {
  return {
    host: env.INGEST_SERVER_HOST ?? DEFAULT_HOST,
    port: Number(env.INGEST_SERVER_PORT ?? DEFAULT_PORT),
  }
}
