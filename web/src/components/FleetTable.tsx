import type { DisplayState } from '../lib/staleness.js'

export type FleetRow = {
  key: string
  displayName: string
  state: DisplayState
  containersRunning: number
  containersTotal: number
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
            <td>{r.containersRunning}/{r.containersTotal}</td>
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
