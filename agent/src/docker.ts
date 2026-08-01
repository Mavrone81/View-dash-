import type { HealthState } from '@bevora-ops/shared'

export type ContainerSummary = {
  names: string[]
  project: string | null
  state: string
  health: string | null
}

export type DiscoveredSystem = {
  key: string
  displayName: string
  health: HealthState
  containers: { total: number; running: number }
}

/** Pure: takes an already-fetched container list so no daemon is needed to test. */
export function discoverSystems(list: ContainerSummary[]): DiscoveredSystem[] {
  const byProject = new Map<string, ContainerSummary[]>()
  for (const c of list) {
    if (!c.project) continue // not part of a system; do not invent one
    const arr = byProject.get(c.project) ?? []
    arr.push(c)
    byProject.set(c.project, arr)
  }

  return [...byProject.entries()].map(([key, cs]) => {
    const running = cs.filter((c) => c.state === 'running').length
    const anyUnhealthy = cs.some((c) => c.health === 'unhealthy')
    const health: HealthState =
      running === 0 ? 'down' : running < cs.length || anyUnhealthy ? 'degraded' : 'healthy'
    return { key, displayName: key, health, containers: { total: cs.length, running } }
  })
}

/** Maps the Docker API shape onto ContainerSummary. */
export function toSummary(raw: {
  Names: string[]
  State: string
  Labels?: Record<string, string>
  Status?: string
}): ContainerSummary {
  return {
    names: raw.Names,
    project: raw.Labels?.['com.docker.compose.project'] ?? null,
    state: raw.State,
    health: /\(healthy\)/.test(raw.Status ?? '')
      ? 'healthy'
      : /\(unhealthy\)/.test(raw.Status ?? '')
        ? 'unhealthy'
        : null,
  }
}
