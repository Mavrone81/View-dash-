import { prisma } from './db.js'
import { displayState } from './staleness.js'
import type { FleetRow } from '../components/FleetTable.js'

export async function latestPerSystem(now: Date): Promise<FleetRow[]> {
  const systems = await prisma.system.findMany({
    // Order by `receivedAt`, the server-set clock, NOT `observedAt`, the
    // agent-claimed one. If this ordered by `observedAt`, a single
    // future-dated observation from a fast or malicious host clock would
    // sort above every genuinely newer row forever, and `take: 1` would
    // pin the board on that stale row indefinitely while it looks perfectly
    // normal. See the `receivedAt` doc comment on SystemObservation.
    include: { observations: { orderBy: { receivedAt: 'desc' }, take: 1 } },
    orderBy: { key: 'asc' },
  })
  return systems.map((s): FleetRow => {
    const o = s.observations[0] ?? null
    return {
      key: s.key,
      displayName: s.displayName,
      // Pass the server-trusted `receivedAt`, never the agent-claimed
      // `observedAt` — `displayState`'s first parameter is deliberately
      // named `receivedAt` to make this the only correct call.
      state: displayState(o?.receivedAt ?? null, o?.health ?? 'unknown', now),
      containersRunning: o?.containersRunning ?? 0,
      containersTotal: o?.containersTotal ?? 0,
      deployedSha: o?.deployedSha ?? null,
      deployedSubject: o?.deployedSubject ?? null,
      deployedAt: o?.deployedAt ?? null,
      driftCommits: o?.driftCommits ?? null,
      receivedAt: o?.receivedAt ?? null,
    }
  })
}
