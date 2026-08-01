export type IngestServerConfig = { host: string; port: number }

const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT = 4100

/**
 * Defaults to LOOPBACK. TLS terminates at a reverse proxy in front of this
 * service, and this estate's standing convention is that the proxy holds
 * the public interface and forwards to the app over loopback -- the same
 * shape as the Next.js app's own slice-1 default. Exposing this listener on
 * every interface is a deployment decision (e.g. the proxy and this service
 * running as SIBLING CONTAINERS on a compose network with no host
 * networking, where loopback inside this container's namespace is genuinely
 * unreachable from the proxy container) and must be made EXPLICITLY via
 * `INGEST_SERVER_HOST=0.0.0.0`, scoped to that network -- never silently by
 * a code default. If that default is ever changed, it should happen in a
 * reviewable deployment artifact (compose file, unit file), not here.
 */
export function loadIngestServerConfig(env: NodeJS.ProcessEnv = process.env): IngestServerConfig {
  return {
    host: env.INGEST_SERVER_HOST ?? DEFAULT_HOST,
    port: Number(env.INGEST_SERVER_PORT ?? DEFAULT_PORT),
  }
}
