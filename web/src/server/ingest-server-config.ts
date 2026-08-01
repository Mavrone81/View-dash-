export type IngestServerConfig = {
  host: string
  port: number
  /**
   * Largest single message this listener will accept, in bytes.
   *
   * `ws`'s own default is 100 MB. This process runs on a 1 GB droplet and
   * its peers are agents sending a few kilobytes of JSON every 30 seconds,
   * so that default is four to five orders of magnitude larger than any
   * legitimate message and is simply an OOM waiting to be asked for. 1 MiB
   * leaves enormous headroom over a real snapshot (~200 systems of a few
   * hundred bytes each) while making a memory-exhaustion attempt fail
   * immediately -- `ws` closes an oversized frame with 1009 rather than
   * buffering it.
   */
  maxPayloadBytes: number
  /**
   * Hard ceiling on simultaneously-open connections.
   *
   * Unbounded, every inbound connection -- including one that will be
   * rejected a moment later -- costs a socket and a database round trip
   * (`authenticateAgent`). That makes an unauthenticated peer able to drive
   * this listener's database load for free. Above this ceiling a connection
   * is closed BEFORE authentication, so the cheap defence runs before the
   * expensive check. Sized for the estate with a lot of room: one agent per
   * monitored host, a couple of dozen hosts.
   */
  maxConnections: number
}

const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT = 4100
const DEFAULT_MAX_PAYLOAD_BYTES = 1024 * 1024
const DEFAULT_MAX_CONNECTIONS = 64

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
    maxPayloadBytes: Number(env.INGEST_MAX_PAYLOAD_BYTES ?? DEFAULT_MAX_PAYLOAD_BYTES),
    maxConnections: Number(env.INGEST_MAX_CONNECTIONS ?? DEFAULT_MAX_CONNECTIONS),
  }
}
