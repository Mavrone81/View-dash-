import type { DisplayState } from '../lib/staleness.js'

export type FleetRow = {
  /**
   * Globally unique row identity: host id + system key.
   *
   * NOT `key` on its own. The schema makes `System.key` unique PER HOST and
   * deliberately so (`@@unique([hostId, key])`) -- two hosts may each run a
   * stack called `web`, and enrolling the second must not collide with the
   * first. Keying React rows on `key` alone therefore produced duplicate
   * keys and two identical-looking rows the moment a second host ran a
   * same-named system, on the one page whose job is telling machines apart.
   */
  id: string
  /**
   * Which host this row is about. Always rendered: the board mixes rows
   * from every enrolled host, so without it two same-named systems on
   * different machines are indistinguishable -- and "which box is this on"
   * is the first question an operator asks about a red row.
   */
  hostName: string
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
  /**
   * When this row's HOST was last heard from at all (`Host.lastSeenAt`),
   * independent of any one system's own observation.
   *
   * This column was written on every ingest and never read by anything,
   * while spec §9's requirement -- *"If the agent connection drops, every
   * row renders 'agent unreachable, last seen HH:MM'"* -- went undelivered.
   * It is the fallback timestamp for a row that has no observation of its
   * own: a host enrolled but never reporting, or a system row created
   * before its first observation landed.
   */
  lastSeenAt: Date | null
}

const DASH = '—'

/**
 * `HH:MM` in UTC, explicitly labelled.
 *
 * UTC rather than the viewer's locale on purpose: this string is read off a
 * screen and then typed into `journalctl --since` or compared against a
 * deploy log on the host, and every one of those is UTC. A silently
 * locale-shifted time here would send someone looking in the wrong hour.
 */
function lastSeenLabel(at: Date | null): string {
  if (!at) return 'never seen'
  return `last seen ${at.toISOString().slice(11, 16)} UTC`
}

/**
 * Spec §9: a row whose data we cannot vouch for must say so AND say when it
 * was last any good -- "agent unreachable, last seen HH:MM", greyed, not
 * green. Only `stale` and `unknown` carry it: on a live row the timestamp
 * is noise, and on those two it is the single most useful thing the row can
 * tell an operator.
 */
function stateLabel(row: FleetRow): string {
  if (row.state !== 'stale' && row.state !== 'unknown') return row.state
  return `${row.state} — agent unreachable, ${lastSeenLabel(row.receivedAt ?? row.lastSeenAt)}`
}

export function FleetTable({ rows }: { rows: FleetRow[] }) {
  if (rows.length === 0) return <p>No systems reported yet.</p>
  return (
    <table>
      <thead>
        <tr>
          <th>Host</th><th>System</th><th>State</th><th>Containers</th>
          <th>Version</th><th>Deployed</th><th>Latest change</th><th>Drift</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          // `r.id` (host + key), never `r.key`: see FleetRow.id.
          <tr key={r.id} data-state={r.state} data-host={r.hostName}>
            <td>{r.hostName}</td>
            <td>{r.displayName}</td>
            <td>{stateLabel(r)}</td>
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
