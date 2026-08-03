import type { HealthState } from '@bevora-ops/shared'

export type ContainerSummary = {
  names: string[]
  project: string | null
  state: string
  health: string | null
  /**
   * The container's HOST-reachable ports only -- i.e. every entry Docker's
   * own `Ports` array reported that carries a `PublicPort`. An entry with no
   * `PublicPort` is a container-internal port nothing outside the daemon can
   * reach; treating it as published would let a vhost's proxy_pass target
   * attach a hostname to a port no probe can actually hit from the host,
   * which is worse than reporting no hostname at all -- it is the same
   * false-attribution shape this slice's vhost parser was fixed three times
   * over. Deduplicated: the same PublicPort is reported twice when a
   * container binds both an IPv4 and an IPv6 host address to it.
   */
  publishedPorts: number[]
}

export type DiscoveredSystem = {
  key: string
  displayName: string
  health: HealthState
  containers: { total: number; running: number }
  /** The union, deduplicated, of every one of this system's containers' `publishedPorts`. */
  publishedPorts: number[]
}

/** Dedupes and sorts for a deterministic, order-independent result. */
function dedupeSortedPorts(ports: number[]): number[] {
  return [...new Set(ports)].sort((a, b) => a - b)
}

// Health values a container can carry once parsed from Docker's Status string.
// `null` (on ContainerSummary.health) is reserved for "no healthcheck configured" --
// the common case, and one that must count as fine. Every other outcome below means
// a healthcheck exists in some form, and only 'healthy' may read as fine.
const NOT_HEALTHY = new Set(['unhealthy', 'starting', 'unknown'])

/** Pure: takes an already-fetched container list so no daemon is needed to test. */
export function discoverSystems(list: ContainerSummary[]): DiscoveredSystem[] {
  const byProject = new Map<string, ContainerSummary[]>()
  for (const c of list) {
    if (!c.project) continue // not part of a system; do not invent one
    const arr = byProject.get(c.project) ?? []
    arr.push(c)
    byProject.set(c.project, arr)
  }

  const systems = [...byProject.entries()].map(([key, cs]) => {
    const running = cs.filter((c) => c.state === 'running').length
    // Starting and unknown are deliberately treated the same as unhealthy here: a
    // container mid-startup is not yet serving, and a container whose health string
    // we cannot recognise must not be certified healthy just because it isn't the
    // literal string "unhealthy".
    const notHealthy = cs.some((c) => c.health !== null && NOT_HEALTHY.has(c.health))
    const health: HealthState =
      running === 0 ? 'down' : running < cs.length || notHealthy ? 'degraded' : 'healthy'
    const publishedPorts = dedupeSortedPorts(cs.flatMap((c) => c.publishedPorts))
    return { key, displayName: key, health, containers: { total: cs.length, running }, publishedPorts }
  })

  // Map iteration order follows whatever order the container list happened to arrive
  // in (i.e. Docker's), which is not stable between polls. Sort so the board's rows
  // don't jitter when the upstream list reorders for reasons that have nothing to do
  // with system health.
  return systems.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
}

// Matches the parenthetical Docker appends to a container's Status string, e.g.
// "Up 2 hours (healthy)" or "Up 2 hours (health: starting)". Absence of a match is
// itself meaningful -- see parseHealth below.
const HEALTH_PAREN = /\(([^)]+)\)/

/**
 * Parses the health portion of a `docker ps`-style Status string into one of:
 *   - null        -- no parenthetical at all. The container has NO healthcheck
 *                    configured, which is the common case and is fine.
 *   - 'healthy'   -- `(healthy)`
 *   - 'unhealthy' -- `(unhealthy)`
 *   - 'starting'  -- `(health: starting)`. A healthcheck exists but hasn't reported
 *                    yet; the container is not yet known-good.
 *   - 'unknown'   -- any other parenthetical. A healthcheck clearly exists (there IS
 *                    a parenthetical), but we don't recognise its phrasing. This must
 *                    never collapse to null/"no healthcheck" -- that would silently
 *                    certify a container we cannot actually vouch for.
 */
function parseHealth(status: string | undefined): string | null {
  const match = HEALTH_PAREN.exec(status ?? '')
  if (!match) return null
  const inner = match[1] ?? ''
  if (inner === 'healthy') return 'healthy'
  if (inner === 'unhealthy') return 'unhealthy'
  if (inner === 'health: starting') return 'starting'
  return 'unknown'
}

/**
 * A single entry of Docker's own `Ports` array on a container summary. Only
 * `PublicPort` is optional -- an entry with no `PublicPort` is a container
 * port that is exposed but not published to the host, e.g. a bare `EXPOSE`
 * or a port shared only over an internal compose network.
 */
type RawPort = { PrivatePort: number; PublicPort?: number; Type: string; IP?: string }

function toPublishedPorts(ports: RawPort[] | undefined): number[] {
  if (!ports) return []
  return dedupeSortedPorts(
    ports.flatMap((p) => (p.PublicPort === undefined ? [] : [p.PublicPort])),
  )
}

/** Maps the Docker API shape onto ContainerSummary. */
export function toSummary(raw: {
  Names: string[]
  State: string
  Labels?: Record<string, string>
  Status?: string
  Ports?: RawPort[]
}): ContainerSummary {
  return {
    names: raw.Names,
    project: raw.Labels?.['com.docker.compose.project'] ?? null,
    state: raw.State,
    health: parseHealth(raw.Status),
    publishedPorts: toPublishedPorts(raw.Ports),
  }
}
