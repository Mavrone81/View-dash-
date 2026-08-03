import type { DisplayState } from '../lib/staleness.js'
import type { Beat } from '../lib/beats.js'
import type { HostnameConfig, OnBoxProbeResult, ProbeOutcome } from '@bevora-ops/shared'
import type { Verdict } from '../lib/answers.js'

/**
 * One named hostname's own two-axis result, computed by fleet-query.ts via
 * `combine()` (Task 7) from that hostname's on-box probe (matched by name
 * out of `FleetRow.onBoxProbes`) and its latest external result (Task 7a's
 * `latestExternalResultsByHostname`).
 *
 * Task 5/7a's certificate facts travel here per hostname, not per row,
 * because a system with several hostnames can have them disagree on BOTH
 * axes (spec §8) -- a shared vhost with one hostname's certificate expiring
 * and a sibling's fine must not be flattened into one row-level number.
 *
 * `listensTls` is the vhost's CONFIG fact (from `hostnames` on the wire);
 * `certDaysRemaining`/`certExpiresAt` are what the external probe's OWN TLS
 * handshake most recently observed. These are deliberately not conflated --
 * spec §6/§8's "no certificate where TLS is configured without one" needs
 * BOTH: the config says TLS is expected, the handshake says none was
 * presented.
 */
export type HostnameAnswer = {
  hostname: string
  verdict: Verdict
  onBoxOutcome: ProbeOutcome | null
  /**
   * `null` in THREE cases, deliberately conflated: no external result
   * exists for this hostname at all; one exists but is older than
   * `fleet-query.ts`'s `EXTERNAL_RESULT_STALE_AFTER_MS` (Task 8 fix round 1,
   * C3); or the whole board is under a fleet-wide external failure (Task 8
   * fix round 1, C2b) and this reading, however fresh, is not trusted this
   * tick. In every case the CONTENT is not trusted as a current opinion --
   * the same "stop vouching for it" rule `staleness.ts`'s `displayState`
   * already applies to a stale on-box observation. `externalAgeMs` below is
   * what still lets a renderer tell "never checked" apart from "checked,
   * but not trusted right now" (see fix round 2's M1).
   */
  externalOutcome: ProbeOutcome | null
  /** Milliseconds between `now` (the query's own clock) and the external
   * probe's `observedAt` -- spec §5.1's "show the age of the last external
   * result, so a stale one is never mistaken for a fresh one." `null` ONLY
   * when no external result exists for this hostname at all. UNLIKE
   * `externalOutcome`/`certDaysRemaining`, this is NEVER nulled by
   * staleness OR by a fleet-wide failure (Task 8 fix round 2, I1 -- an
   * earlier version nulled it together with the content on a fleet-wide
   * failure, so a result stored 4 minutes ago, carrying a certificate 3
   * days from expiry, rendered as "never checked externally") -- an
   * operator must still be able to see "checked 9 days ago" even once the
   * board has stopped trusting that reading's content. */
  externalAgeMs: number | null
  listensTls: boolean | null
  /** `null` whenever `externalOutcome` is (no result, or stale -- see
   * above), in addition to every reason `certExpiresAt` was already `null`
   * on the stored `ExternalProbeResult` row itself (no handshake
   * completed). */
  certExpiresAt: Date | null
  certDaysRemaining: number | null
}

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

  /**
   * This system's hostnames per the host's own reverse-proxy config, THIS
   * TICK -- see shared/src/wire.ts's `HostnameConfigSchema` and
   * `SystemObservation.hostnames`.
   *
   * `null` and `[]` are BOTH legal and must render differently (Task 5's
   * obligation, handed to this task): `null` means NO OPINION -- no
   * observation yet, an older agent, or this tick's vhost read failed --
   * and `[]` is a POSITIVE fact, the agent looked and this system has no
   * HTTP surface at all. Collapsing them would let a transient read
   * failure render as the settled, permanent "no HTTP surface" claim.
   */
  hostnames: HostnameConfig[] | null
  /**
   * One entry per on-box probe target this system had this tick. Same
   * null-vs-`[]` discipline as `hostnames`, for the same reason -- see
   * shared/src/wire.ts's `OnBoxProbeResultSchema`.
   *
   * An entry's own `hostname` field is independently nullable: `null` there
   * means a published port with no vhost mapping, probed anyway with no
   * `Host` header -- a positive fact ("a port with no name answered"), not
   * an unknown. `unnamedOnBoxProbes` below pulls those out for display;
   * this field keeps the raw, complete list.
   */
  onBoxProbes: OnBoxProbeResult[] | null
  /**
   * The one hostname this row names in its URL column, chosen by
   * `primaryHostname()` (Task 7) -- arbitrary but total, so it never
   * flickers between refreshes for no reason. `null` iff `hostnames` is
   * `null` or `[]` -- there is nothing to name.
   */
  primaryHostname: string | null
  /**
   * This row's OWN two-axis verdict, spec §8's "Answers" column -- the
   * WORST (most alarming) of every named hostname's own `HostnameAnswer`
   * verdict, plus any unnamed on-box probe's. Deliberately NOT just the
   * primary hostname's verdict: `primaryHostname` is chosen preferring one
   * that ANSWERS (so the clickable URL is a live link), and using its
   * verdict alone here would let a genuinely failing sibling hostname
   * disappear into a green row precisely because a healthy sibling was
   * picked to represent it -- the "averaged into a green row" spec §8
   * forbids explicitly. See `worstVerdict` in fleet-query.ts.
   */
  verdict: Verdict
  /**
   * Fix round 1 (Task 8 review), I2: the NAMED hostname (out of
   * `hostnameAnswers`) whose OWN verdict equals `verdict` above -- i.e. the
   * one that actually produced the row's worst-of result. The Answers
   * column's parenthetical detail must come from THIS entry, never from
   * `primaryHostname`'s: `primaryHostname` is chosen preferring a hostname
   * that ANSWERS, so the two can name different hostnames, and reading the
   * detail off the wrong one can produce a sentence that contradicts
   * itself (a "contradiction" verdict whose parenthetical describes a
   * different, healthy hostname's evidence). `null` when the worst verdict
   * came from an unnamed on-box probe instead -- there is no hostname to
   * attribute a detail to in that case.
   */
  leadHostnameAnswer: HostnameAnswer | null
  /** The primary hostname's own `listensTls` -- convenience flattening of
   * `hostnameAnswers`, matching this row's other flat fields (`state`,
   * `beats`, etc). `null` when there is no primary hostname to read it
   * from. */
  tlsConfigured: boolean | null
  /** The primary hostname's own `certDaysRemaining` -- see `tlsConfigured`
   * above for why this is flattened rather than requiring a lookup into
   * `hostnameAnswers` on every render. */
  certDaysRemaining: number | null
  /**
   * One entry per NAMED hostname (i.e. `hostnames`, when non-null) --
   * always includes the primary. Spec §8: "the row shows the primary and
   * reveals the rest on expansion, each with its own result."
   */
  hostnameAnswers: HostnameAnswer[]
  /**
   * `onBoxProbes` entries with `hostname: null` that actually answered --
   * Task 5's "a port with no name answered" positive fact. `not-probed`
   * entries are filtered out here: they carry no opinion (see
   * `answers.ts`'s `opinion()`), so there is nothing to report about them.
   */
  unnamedOnBoxProbes: OnBoxProbeResult[]
}

const DASH = '—'

/**
 * What the URL column renders for a system whose latest observation
 * confirms zero hostnames -- a POSITIVE fact (the agent looked and there is
 * nothing here), never the bare em dash, which would read as "unknown"
 * rather than "settled: no HTTP surface". Exported so a test names the same
 * string this renders rather than asserting on a copy of it.
 */
export const NO_HTTP_SURFACE_LABEL = 'no HTTP surface'

/**
 * What the URL column renders when `hostnames` itself is `null` -- the
 * agent never told us this tick (no observation yet, an older agent, or a
 * failed vhost read), which is a DIFFERENT fact from the confirmed-empty
 * case above and must read differently, per Task 5's obligation.
 */
export const HOSTNAMES_UNKNOWN_LABEL = 'hostname data not available this tick'

/**
 * What the Cert column renders when there is no hostname at all to have a
 * certificate for -- reuses the URL column's own wording rather than
 * inventing a third phrase for the identical underlying fact.
 */
const CERT_NO_SURFACE_LABEL = NO_HTTP_SURFACE_LABEL

/**
 * The words the Answers column shows for each `Verdict` -- spec §8's "the
 * wording names the fault, not a colour". `unconfirmed` is Task 7's
 * addition (see answers.ts's own docstring): it will be the MOST COMMON
 * verdict on first deploy, before the external axis has completed its
 * first 5-minute cycle, so its wording is deliberately neutral -- neither
 * an alarm ("down") nor reassurance ("healthy"), just "we do not have both
 * axes yet". `unprobed` reads distinctly from it ("not probed" vs "not yet
 * confirmed") because they are different facts: nothing ran at all, versus
 * one axis ran and the other has not.
 */
const VERDICT_COPY: Record<Verdict, string> = {
  healthy: 'healthy',
  'route-broken': 'app up, route broken',
  'app-down': 'app down',
  contradiction: 'contradiction — unreachable on-box, answering from outside',
  unconfirmed: 'not yet confirmed',
  unprobed: 'not probed',
}

/**
 * A parenthetical naming the SPECIFIC failure mode behind a bad outcome,
 * layered on top of `VERDICT_COPY`'s word -- spec §5's rule that a 502/504
 * is the proxy testifying the application is not responding, and that a
 * TLS failure is "a separate state, not app down". Returns `null` for every
 * outcome that needs no elaboration (an answering outcome, or a generic
 * `not-answering`/`not-probed`, both already fully named by the verdict
 * word alone).
 */
function outcomeDetail(outcome: ProbeOutcome | null): string | null {
  if (outcome === 'proxy-no-upstream') return 'proxy up, app not responding'
  if (outcome === 'tls-failed') return 'TLS handshake failed'
  return null
}

/** `ms` to a short, human age string -- spec §5.1's "show the age of the
 * last external result, so a stale one is never mistaken for a fresh one." */
function formatAge(ms: number): string {
  if (ms < 60_000) return 'just now'
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

/**
 * The Cert column's severity, from the CONFIG fact (`listensTls`) and the
 * HANDSHAKE fact (`certDaysRemaining`) kept deliberately separate, per this
 * task's instruction not to conflate them: a hostname can be TLS-configured
 * with no certificate ever observed, and that is its own distinct, urgent
 * state, not "unknown" and not "fine".
 *
 * Thresholds are spec §6's: amber under 21 days, red under 7.
 *
 * Fix round 1 (Task 8 review), C1: a NULL `certDaysRemaining` is NOT, on
 * its own, evidence of a missing certificate -- it is also exactly what
 * `null` reads as when the external axis has never run at all (Task 9 not
 * yet deployed) or when a probe attempt failed BEFORE it ever reached the
 * TLS layer (DNS, a timeout, a refused connection). Collapsing all three
 * into red "no certificate" turned an absence of evidence into a finding:
 * on first deploy, with `ExternalProbeResult` empty, every TLS-configured
 * hostname would render red against a survey that measured 40+ days
 * remaining on every real certificate.
 *
 * The discriminator is `externalOutcome`, which `buildHostnameAnswers`
 * (fleet-query.ts) already nulls together with `certDaysRemaining` on
 * every path that is not "a completed TLS handshake, this check": no
 * external result at all, one older than the staleness ceiling (C3), or a
 * probe failure. `probeExternally`'s OWN contract (external-probe.ts) is
 * what makes `'tls-failed'` unambiguous here: it is produced ONLY by a
 * handshake that started and failed verification (`classifyProbeFailure`),
 * never by a network-level failure that never reached TLS at all -- so
 * `externalOutcome === 'tls-failed'` is the one case where "no certificate"
 * is a claim the evidence actually supports (spec §7's real finding: three
 * hostnames configured for TLS whose handshake fails). Every other reason
 * `certDaysRemaining` is null reads as "not observed", not "absent".
 *
 * KNOWN LIMITATION, recorded rather than silently accepted: a successful
 * handshake whose peer certificate happens to carry no readable `valid_to`
 * (see `httpsExternalRequest`'s own `cert?.valid_to` check) also produces
 * `certDaysRemaining: null` with `externalOutcome` set to whatever HTTP
 * status followed -- not `'tls-failed'` -- and would therefore read
 * "not observed" here rather than red. Distinguishing that case precisely
 * would need an explicit boolean carried the whole way from the probe
 * through storage, which is more than this evidence-only fix justifies;
 * the case is exotic (a real, currently-valid TLS certificate with no
 * `notAfter` field) and has never been observed on the monitored estate.
 */
export type CertSeverity = 'red' | 'amber' | 'ok' | 'unknown' | 'none'

/**
 * Fix round 2 (Task 8 review), C1: how "bad" each severity is, for taking
 * the WORST across every named hostname (see `worstCertSeverity` below) --
 * the Cert-column equivalent of `fleet-query.ts`'s `VERDICT_SEVERITY`,
 * which Answers already had and Cert did not.
 *
 * `ok` and `none` tie at the bottom: a plain-HTTP-by-design hostname is not
 * a certificate concern at all, so it must not make a row look WORSE, but
 * it also must not be allowed to hide a genuine problem elsewhere on the
 * same row -- ties resolve in `worstCertSeverity` by simply not being the
 * max. `unknown` outranks both of them on purpose, the same reasoning
 * `fleet-query.ts`'s `VERDICT_SEVERITY` gives for `unprobed`/`unconfirmed`
 * outranking `healthy`: a row must not read as fully fine while one of its
 * hostnames' certificate status is simply unverified.
 */
const CERT_SEVERITY_RANK: Record<CertSeverity, number> = {
  ok: 0,
  none: 0,
  unknown: 1,
  amber: 2,
  red: 3,
}

type CertEvidence = Pick<HostnameAnswer, 'listensTls' | 'certDaysRemaining' | 'externalOutcome' | 'externalAgeMs'>

function certSeverity(h: CertEvidence | null): CertSeverity {
  if (h === null) return 'unknown'
  if (h.listensTls === false) return 'none'
  if (h.listensTls === null) return 'unknown'
  if (h.certDaysRemaining !== null) {
    if (h.certDaysRemaining < 7) return 'red'
    if (h.certDaysRemaining < 21) return 'amber'
    return 'ok'
  }
  // No days-remaining figure. Red only when the evidence says the
  // handshake itself was reached and failed -- everything else is "we
  // have not observed this", not "it is missing".
  return h.externalOutcome === 'tls-failed' ? 'red' : 'unknown'
}

/**
 * Fix round 2 (Task 8 review), C1 -- THE fix: the Cert column's `<td>`
 * used to carry only the PRIMARY hostname's own severity, computed by
 * `primaryHostname()` (Task 7), which chooses by which hostname ANSWERS --
 * a criterion with no relationship whatsoever to certificate health. A
 * sibling hostname two days from expiry could sit behind a closed
 * `<details>` while the cell itself rendered `ok`/green, because nothing
 * folded the per-hostname severities the way `fleet-query.ts`'s
 * `worstVerdict` already folds Answers. This is spec §8's no-averaging
 * rule, unapplied to the one column whose entire purpose is warning about
 * an expiring certificate -- and it failed SILENTLY, toward reassurance,
 * which is the most dangerous direction a defect on this board can point.
 *
 * The row's TEXT still shows the primary hostname's own days-remaining
 * figure (a real number is more informative than a generic severity word,
 * and it is still genuinely true of the primary) -- only the colour is
 * now worst-of. A row whose cell reads red with a primary hostname that
 * says "60d remaining" is not a contradiction: it is exactly the signal
 * that something else on this row needs the expansion opened.
 */
function worstCertSeverity(answers: readonly HostnameAnswer[]): CertSeverity {
  const severities = answers.map((h) => certSeverity(h))
  if (severities.length === 0) return 'unknown'
  return severities.reduce((worst, s) => (CERT_SEVERITY_RANK[s] > CERT_SEVERITY_RANK[worst] ? s : worst))
}

/**
 * Fix round 2 (Task 8 review), M1: `externalOutcome === null` no longer
 * distinguishes "never checked" from "checked, but no longer current"
 * (stale, or fleet-wide-suppressed -- see `fleet-query.ts`'s
 * `buildHostnameAnswers`) -- both null it identically. `externalAgeMs`,
 * which I1 fixed to stay populated in BOTH cases, is what tells them apart:
 * `null` age genuinely means never checked; a real age means there IS a
 * reading, it is simply not being trusted as current right now. Without
 * this, a 9-day-old (or fleet-wide-suppressed 4-minutes-old) result read
 * as "not checked yet" -- a sentence the evidence does not support, and one
 * that actively contradicts the Answers cell on the SAME row, which shows
 * that age plainly (spec §5.1).
 */
function certLabel(h: CertEvidence | null): string {
  if (h === null) return CERT_NO_SURFACE_LABEL
  if (h.listensTls === false) return 'no TLS configured'
  if (h.listensTls === null) return 'TLS status unknown this tick'
  if (h.certDaysRemaining !== null) return `${h.certDaysRemaining}d remaining`
  if (h.externalOutcome === 'tls-failed') return 'no certificate'
  if (h.externalOutcome === null) {
    return h.externalAgeMs === null
      ? 'certificate not checked yet'
      : `certificate last checked ${formatAge(h.externalAgeMs)}, no longer current`
  }
  return 'certificate not observed this check'
}

/**
 * `https://<hostname>/` (or `http://` when the vhost is deliberately plain
 * HTTP) -- the URL column links the way a real visitor reaches the system
 * (the external axis's own path), never the on-box loopback address a
 * probe uses internally.
 *
 * Fix round 1 (Task 8 review), I3, scoped exactly as asked: only the LINK
 * SCHEME is fixed here. `listensTls === false` now links `http://`, so a
 * deliberately plain-HTTP vhost is at least clickable to somewhere real
 * instead of a permanently-wrong `https://` link. `null` (config
 * undetermined this tick) still defaults to `https://` -- the more common
 * case on this estate, and the substantive half of this problem (the
 * EXTERNAL PROBER itself always dialling 443 regardless of `listensTls`,
 * so a plain-HTTP vhost is probed the wrong way and reads red while
 * healthy, or green from whatever default server block answers port 443
 * for a DIFFERENT system) is explicitly NOT fixed here -- it belongs with
 * Task 9, which owns the hostname list the runner receives.
 */
function externalUrl(hostname: string, listensTls: boolean | null): string {
  return `${listensTls === false ? 'http' : 'https'}://${hostname}/`
}

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

/**
 * The URL column: the primary hostname, linked out to the real (external)
 * address. `hostnames === null` and `hostnames === []` are TWO DIFFERENT
 * absences (see `FleetRow.hostnames`'s docstring) and must read as two
 * different sentences, neither of them a bare dash -- a dash reads as
 * "unknown", which is the wrong fact in the confirmed-empty case.
 */
function UrlCell({ r }: { r: FleetRow }) {
  if (r.hostnames === null) {
    return <span className="col-url col-url--unknown">{HOSTNAMES_UNKNOWN_LABEL}</span>
  }
  if (r.hostnames.length === 0 || r.primaryHostname === null) {
    return <span className="col-url col-url--none">{NO_HTTP_SURFACE_LABEL}</span>
  }
  const primaryAnswer = r.hostnameAnswers.find((h) => h.hostname === r.primaryHostname) ?? null
  const others = r.hostnameAnswers.filter((h) => h.hostname !== r.primaryHostname)
  return (
    <span className="col-url">
      <a href={externalUrl(r.primaryHostname, primaryAnswer?.listensTls ?? null)} className="url-link">
        {r.primaryHostname}
      </a>
      {others.length > 0 && (
        <details className="hostname-expand">
          <summary>+{others.length} more</summary>
          <ul>
            {others.map((h) => (
              <li key={h.hostname}>
                <a href={externalUrl(h.hostname, h.listensTls)} className="url-link">
                  {h.hostname}
                </a>
              </li>
            ))}
          </ul>
        </details>
      )}
    </span>
  )
}

/** `null` -> "never checked externally"; otherwise the human age string. */
function ageDetail(ms: number | null): string {
  return ms == null ? 'never checked externally' : `checked ${formatAge(ms)}`
}

/**
 * The Answers column: spec §8's two-axis verdict, named in words. Shows the
 * row's overall (worst-of, see `FleetRow.verdict`) verdict plus, when the
 * failing axis names a specific cause (a 502/504, a TLS failure),
 * `outcomeDetail`'s parenthetical -- so `route-broken` reads as "app up,
 * route broken", and if the external side specifically saw a 502/504 it
 * additionally says "proxy up, app not responding", never colour-only.
 *
 * Fix round 1 (Task 8 review), I2/C3: the summary's detail and age come
 * from `r.leadHostnameAnswer` -- the hostname that actually PRODUCED
 * `r.verdict` -- never from the primary hostname, which can legitimately be
 * a DIFFERENT, healthy one (see `FleetRow.leadHostnameAnswer`'s docstring
 * for why using the primary produced self-contradicting sentences). The
 * per-hostname expansion below shows every hostname's OWN age alongside its
 * own verdict, spec §5.1's requirement that a stale reading is never
 * presented as current -- a system with several hostnames must not have
 * only the (arbitrary) primary's age visible.
 *
 * A multi-hostname system reveals each hostname's OWN verdict on expansion
 * -- spec §8's requirement that a failing hostname stay visible rather than
 * being averaged away into the row's green summary.
 */
function AnswersCell({ r }: { r: FleetRow }) {
  const lead = r.leadHostnameAnswer
  const detail = outcomeDetail(lead?.externalOutcome ?? lead?.onBoxOutcome ?? null)
  return (
    <td className="col-answers" data-verdict={r.verdict} data-testid="answers-cell">
      <span className="answer-word">{VERDICT_COPY[r.verdict]}</span>
      {detail && <span className="answer-detail"> ({detail})</span>}
      {lead && (
        <span className="answer-age"> — external {ageDetail(lead.externalAgeMs)}</span>
      )}
      {r.unnamedOnBoxProbes.length > 0 && (
        <p className="answer-unnamed">
          a port with no name answered on-box ({r.unnamedOnBoxProbes.length})
        </p>
      )}
      {r.hostnameAnswers.length > 1 && (
        <details className="answer-expand">
          <summary>{r.hostnameAnswers.length} hostnames</summary>
          <ul>
            {r.hostnameAnswers.map((h) => {
              const hDetail = outcomeDetail(h.externalOutcome ?? h.onBoxOutcome ?? null)
              return (
                <li key={h.hostname}>
                  <span className="mono">{h.hostname}</span>: {VERDICT_COPY[h.verdict]}
                  {hDetail ? ` (${hDetail})` : ''} — external {ageDetail(h.externalAgeMs)}
                </li>
              )
            })}
          </ul>
        </details>
      )}
    </td>
  )
}

/**
 * The Cert column: days remaining, amber under 21, red under 7, and "no
 * certificate" where TLS is configured without one -- spec §6/§8. Shows the
 * primary hostname's own facts, with the rest revealed on expansion, the
 * same primary+expand pattern as `UrlCell` and `AnswersCell`.
 *
 * Fix round 1 (Task 8 review), I1: `hostnames === null` (never checked
 * this tick) and `hostnames === []` (confirmed no HTTP surface) are handled
 * explicitly here, the same two-branch guard `UrlCell` already has -- the
 * previous version let BOTH fall through to `certLabel(null)`, which always
 * said "no HTTP surface" even for a host that has simply never reported,
 * destroying the exact distinction Task 5 spent two fix rounds preserving.
 */
function CertCell({ r }: { r: FleetRow }) {
  if (r.hostnames === null) {
    return (
      <td className="col-cert" data-severity="unknown" data-testid="cert-cell">
        {HOSTNAMES_UNKNOWN_LABEL}
      </td>
    )
  }
  if (r.hostnames.length === 0 || r.primaryHostname === null) {
    return (
      <td className="col-cert" data-severity="unknown" data-testid="cert-cell">
        {NO_HTTP_SURFACE_LABEL}
      </td>
    )
  }
  const primary = r.hostnameAnswers.find((h) => h.hostname === r.primaryHostname) ?? null
  const others = r.hostnameAnswers.filter((h) => h.hostname !== r.primaryHostname)
  return (
    <td className="col-cert" data-severity={worstCertSeverity(r.hostnameAnswers)} data-testid="cert-cell">
      {certLabel(primary)}
      {others.length > 0 && (
        <details className="cert-expand">
          <summary>{others.length} more</summary>
          <ul>
            {others.map((h) => (
              <li key={h.hostname} data-severity={certSeverity(h)}>
                <span className="mono">{h.hostname}</span>: {certLabel(h)}
              </li>
            ))}
          </ul>
        </details>
      )}
    </td>
  )
}

/**
 * Fix round 1 (Task 8 review), C2b: the banner. `null`/`undefined` means no
 * external sweep has ever run (or `reachedAnything` is true) -- no banner.
 * When present with `reachedAnything: false`, it names the fact the run-level
 * record (`ExternalProbeRun`) actually establishes: "the last external
 * sweep reached nothing, N ago" -- never "this cycle", which the data
 * cannot support (a sweep and a board render are two different clocks; see
 * `latestExternalProbeRun`'s own docstring in fleet-query.ts for why the
 * OLD, inferred version of this flag could fire for the wrong reason, or
 * fail to fire for the right one).
 */
function fleetBanner(sweep: { reachedAnything: boolean; ageMs: number } | null | undefined) {
  if (!sweep || sweep.reachedAnything) return null
  return (
    <p className="fleet-banner" role="status">
      The last external sweep reached nothing, {formatAge(sweep.ageMs)} — showing on-box results only.
    </p>
  )
}

export function FleetTable({
  rows,
  lastExternalSweep,
}: {
  rows: FleetRow[]
  /**
   * The last recorded external-probe sweep's own status (Task 8 fix
   * round 1) -- see `fleetBanner` above and `FleetBoard.lastExternalSweep`
   * in fleet-query.ts. When it reached nothing, every row's own `verdict`
   * was ALREADY computed treating the external axis as absent (falling
   * back to on-box evidence) -- this prop only controls the banner text,
   * it does not itself change any row's colour. That is the point: the
   * failure mode this guards against is turning a local probe fault into
   * twenty false outages, not hiding the banner.
   */
  lastExternalSweep?: { reachedAnything: boolean; ageMs: number } | null
}) {
  // Fix round 1 (Task 8 review), Minor 2: the banner is a fact about the
  // DASHBOARD's own probing, independent of whether any system happens to
  // be enrolled -- it must not disappear behind the "no systems" message.
  if (rows.length === 0) {
    return (
      <>
        {fleetBanner(lastExternalSweep)}
        <p>No systems reported yet.</p>
      </>
    )
  }
  return (
    <div className="fleet-board">
      {fleetBanner(lastExternalSweep)}
      <table className="fleet-table">
        <thead>
          <tr>
            <th scope="col">System</th>
            <th scope="col">URL</th>
            <th scope="col">State</th>
            <th scope="col">Answers</th>
            <th scope="col">Cert</th>
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
              <td className="col-url-cell">
                <UrlCell r={r} />
              </td>
              <td className="col-state" data-state={r.state}>
                {stateLabel(r)}
              </td>
              <AnswersCell r={r} />
              <CertCell r={r} />
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
