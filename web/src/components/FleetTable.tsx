import type { DisplayState } from '../lib/staleness.js'
import type { Beat } from '../lib/beats.js'

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
  // operator which of those is true. Rendered by `containersLabel` below.
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
  /**
   * The signature element: this system's recent reporting beats, oldest
   * first, bucketed into fixed 30-second slots by `buildBeatTrace`
   * (web/src/lib/beats.ts). A slot with no observation is a visible hole in
   * the trace, not a red flag — see `BeatTrace` below for why.
   *
   * Empty (`[]`) means there is no system here to trace at all — the
   * "enrolled host, no systems reported yet" placeholder row. That is
   * DISTINCT from a real system with a fully-silent 20-minute window, which
   * gets a full array of `absent` slots instead: both are "we heard
   * nothing", but only one of them is a system that exists.
   */
  beats: Beat[]
}

const DASH = '—'

/**
 * `/vault?host=<hostId>&system=<systemKey>` for this row, so the board is a
 * way IN to the credential vault for a specific system, not just a status
 * display. Links even when the system carries no credentials yet -- the
 * vault page itself is responsible for offering to add one rather than
 * showing a dead end, per task-8-brief.md Resolution 3.
 *
 * `r.id` is `${hostId}:${key}` (see `FleetRow.id`'s doc comment) and is
 * parsed by trimming the known `:${r.key}` suffix rather than splitting on
 * the first colon, so a system key that happened to contain one would not
 * corrupt the extracted host id.
 */
function vaultHref(r: Pick<FleetRow, 'id' | 'key'>): string {
  const hostId = r.id.slice(0, r.id.length - r.key.length - 1)
  return `/vault?host=${encodeURIComponent(hostId)}&system=${encodeURIComponent(r.key)}`
}

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

/**
 * `null` (either field) means this system has never reported and there is
 * nothing to count -- rendered as the same em dash every other unknown value
 * on this board gets. A genuine `0/0` is a real, checked fact about a system
 * that IS reporting and simply runs no containers, so it renders as ordinary
 * digits, never the dash. These two must stay visually distinguishable: the
 * dash carries `.col-containers--unknown` (muted), a real count does not --
 * see the CRITICAL defect this guards against in `FleetRow.containersRunning`.
 */
function containersLabel(running: number | null, total: number | null): string {
  if (running === null || total === null) return DASH
  return `${running}/${total}`
}

/**
 * The trace strip's text alternative -- carries the SAME fact the beat
 * colours do (how many of the last N beats were missed), so the trace is
 * never colour-only. This is what a screen reader announces for the whole
 * strip; the individual beat swatches are `aria-hidden` (see `BeatTrace`)
 * because they are not independently meaningful, only this summary is.
 */
function beatSummary(beats: readonly Beat[]): string {
  const missed = beats.filter((b) => b.state === 'absent').length
  const alarms = beats.filter((b) => b.state === 'alarm').length
  const received = beats.length - missed
  let summary = `${received} of last ${beats.length} beats received`
  if (missed > 0) summary += `, ${missed} missed`
  if (alarms > 0) summary += `, ${alarms} reported a fault`
  return summary
}

/**
 * The signature element of the "Heartbeat" redesign: a horizontal strip of
 * a system's recent reporting beats.
 *
 * A system that stopped reporting does NOT get a text label saying "stale"
 * here -- it gets a visible hole in its trace, and the length of the hole
 * shows how long it has been silent. Colour carries meaning, never
 * decoration: `good` (we heard from it), `absent` (grey -- silence is not
 * itself a fault, so it must never read as red), `alarm` (a beat that
 * actually reported trouble). All three are rendered as a distinct
 * `data-beat` state, not merely a CSS colour, and the whole strip carries an
 * `aria-label` naming the same fact in words -- so none of it depends on
 * colour perception to be understood.
 *
 * `beats.length === 0` means there is no system here to trace (see
 * `FleetRow.beats`) -- rendered as the same em dash every other unknown
 * value on this board gets, never a fabricated 40-slot silence.
 */
function BeatTrace({ beats }: { beats: readonly Beat[] }) {
  if (beats.length === 0) {
    return <span className="beat-trace beat-trace--empty">{DASH}</span>
  }
  return (
    <span className="beat-trace" role="img" tabIndex={0} aria-label={beatSummary(beats)}>
      {beats.map((beat, i) => (
        // eslint-disable-next-line react/no-array-index-key -- fixed-length, positional slots; index IS the identity here
        <span key={i} className="beat" data-beat={beat.state} aria-hidden="true" />
      ))}
    </span>
  )
}

/** What the beat colours mean, spelled out below the table -- not left to be inferred from a single glance. */
function BeatLegend() {
  return (
    <ul className="beat-legend">
      <li>
        <span className="beat" data-beat="good" aria-hidden="true" /> beat received
      </li>
      <li>
        <span className="beat" data-beat="absent" aria-hidden="true" /> no beat — not a fault
      </li>
      <li>
        <span className="beat" data-beat="alarm" aria-hidden="true" /> beat reported a fault
      </li>
    </ul>
  )
}

export function FleetTable({ rows }: { rows: FleetRow[] }) {
  if (rows.length === 0) return <p>No systems reported yet.</p>
  return (
    <div className="fleet-board">
      <table className="fleet-table">
        <thead>
          <tr>
            <th scope="col">System</th>
            <th scope="col">State</th>
            <th scope="col">Containers</th>
            <th scope="col">Last 40 beats</th>
            <th scope="col">Version</th>
            <th scope="col">Deployed</th>
            <th scope="col">Latest change</th>
            <th scope="col">Drift</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            // `r.id` (host + key), never `r.key`: see FleetRow.id.
            <tr key={r.id} data-state={r.state} data-host={r.hostName}>
              <td className="col-system">
                <span className="host-name">{r.hostName}</span>
                <a className="sys-name" href={vaultHref(r)}>
                  {r.displayName}
                </a>
              </td>
              <td className="col-state" data-state={r.state}>
                {stateLabel(r)}
              </td>
              <td
                className={
                  r.containersRunning === null || r.containersTotal === null
                    ? 'col-containers col-containers--unknown'
                    : 'col-containers'
                }
              >
                {containersLabel(r.containersRunning, r.containersTotal)}
              </td>
              <td className="col-trace">
                <BeatTrace beats={r.beats} />
              </td>
              <td className="col-version">{r.deployedSha ? r.deployedSha.slice(0, 7) : DASH}</td>
              <td className="col-deployed">{r.deployedAt ? r.deployedAt.toISOString() : DASH}</td>
              <td className="col-change">{r.deployedSubject ?? DASH}</td>
              <td className="col-drift">
                {r.driftCommits === null ? DASH : r.driftCommits === 0 ? 'up to date' : `${r.driftCommits} behind`}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <BeatLegend />
    </div>
  )
}
