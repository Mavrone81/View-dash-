import type { DisplayState } from '../lib/staleness.js'

export type FleetRow = {
  key: string
  displayName: string
  state: DisplayState
  // Nullable, like every other "we may not know this" field on this row: a
  // system that has never reported must render the same em dash as an
  // unknown sha or unknown drift, NOT `0/0`. `0/0` is a real, checked fact
  // about a system that IS reporting and genuinely runs zero containers —
  // collapsing "never heard from" into that same text would let a system
  // that has been silent since it was enrolled look identical to one that
  // is live and simply empty, on the one page whose job is telling an
  // operator which of those is true.
  containersRunning: number | null
  containersTotal: number | null
  deployedSha: string | null
  deployedSubject: string | null
  deployedAt: Date | null
  driftCommits: number | null
  // Server-set receive time for this system's latest observation — the only
  // timestamp a caller may trust (see SystemObservation.receivedAt / the
  // `displayState` doc comment). Deliberately NOT named `observedAt`: that
  // name belongs to the agent-claimed, untrusted clock reading, and reusing
  // it here would let a future edit silently wire the wrong column through.
  receivedAt: Date | null
}

const DASH = '—'

export function FleetTable({ rows }: { rows: FleetRow[] }) {
  if (rows.length === 0) return <p>No systems reported yet.</p>
  return (
    <table>
      <thead>
        <tr>
          <th>System</th><th>State</th><th>Containers</th>
          <th>Version</th><th>Deployed</th><th>Latest change</th><th>Drift</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.key} data-state={r.state}>
            <td>{r.displayName}</td>
            <td>{r.state}</td>
            <td>{r.containersRunning === null || r.containersTotal === null ? DASH : `${r.containersRunning}/${r.containersTotal}`}</td>
            <td>{r.deployedSha ? r.deployedSha.slice(0, 7) : DASH}</td>
            <td>{r.deployedAt ? r.deployedAt.toISOString() : DASH}</td>
            <td>{r.deployedSubject ?? DASH}</td>
            <td>{r.driftCommits === null ? DASH : r.driftCommits === 0 ? 'up to date' : `${r.driftCommits} behind`}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
