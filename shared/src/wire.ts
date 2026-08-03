import { z } from 'zod'

export const HealthStateSchema = z.enum(['healthy', 'degraded', 'down', 'unknown'])
export type HealthState = z.infer<typeof HealthStateSchema>

/**
 * What a single probe of a single hostname found.
 *
 * `proxy-no-upstream` is deliberately its own value rather than a flavour
 * of `not-answering`: a 502/504 is the reverse proxy telling us it is
 * healthy and the thing behind it is not. That sentence is the entire
 * reason this slice exists, and collapsing it into a generic failure
 * throws away the only outcome that names its own cause.
 *
 * `not-probed` means no probe ran. It is NOT a pass.
 */
export const ProbeOutcomeSchema = z.enum([
  'answering',
  'answering-oddly',
  'not-answering',
  'proxy-no-upstream',
  'tls-failed',
  'not-probed',
])
export type ProbeOutcome = z.infer<typeof ProbeOutcomeSchema>

/**
 * One hostname the host's own reverse-proxy config maps to this system,
 * paired with whether the server block that declares it listens for TLS.
 *
 * `listensTls` is a config FACT, independent of whether anything answered a
 * probe on this hostname -- a vhost that listens for TLS with no working
 * certificate is exactly spec §8's "No certificate where TLS is configured
 * without one", and §7's live finding of three such hostnames. It travels
 * here, on the config-derived hostname list, rather than on `OnBoxProbeResultSchema`
 * below, because it describes the vhost declaration, not a probe outcome --
 * the on-box axis never touches TLS at all (see `agent/src/probe.ts`'s
 * `probeHostnameOnBox`), and attaching it to a probe result would either
 * have to repeat it once per probed hostname or leave it undefined on the
 * (very real) `hostname: null` probe results that have no declaring vhost
 * to read it from.
 *
 * `null`, not just `true`/`false`: on `agent/src/collect.ts`'s side, the
 * whole on-box vhost read can fail this tick (see
 * `agent/src/vhosts.ts`'s `discoverVhostsFromDir`, which derives BOTH the
 * hostname->port map and the hostname->TLS map from ONE read specifically
 * so the two can never disagree with each other -- fix round 2 closed a
 * Critical where two INDEPENDENT reads of the same directory could each see
 * a different set of readable files and disagree). `null` here covers that
 * read failure, plus a defensive fallback for the (now structurally
 * unreachable in production, but not type-excluded) case of a hostname
 * present in one derived map and missing from the other. Reporting `false`
 * in either case would silently misrepresent a TLS-configured hostname as
 * plain HTTP, hiding the exact finding spec §8 exists to surface; `null`
 * says plainly "not determined this tick".
 */
export const HostnameConfigSchema = z.object({
  hostname: z.string().min(1),
  listensTls: z.boolean().nullable(),
})
export type HostnameConfig = z.infer<typeof HostnameConfigSchema>

/**
 * What one on-box probe target found. Mirrors the shape
 * `agent/src/probe.ts`'s `probeHostnameOnBox` already returns, so the agent
 * passes its result straight through with no reshaping.
 *
 * `hostname: null` means a published port with no vhost mapping at all --
 * probed anyway, addressed by port only, with no `Host` header (see
 * `agent/src/probe.ts`'s `hostnamesForSystem`/`probeHostnameOnBox`
 * docstrings for why this is still worth probing). This is a DEFINITE,
 * POSITIVE fact about the target -- "no name was claimed for this port" --
 * and it is NOT the same thing as "we don't know the hostname". Every
 * unmapped-port probe produces exactly this shape, deterministically; there
 * is no code path that produces a `hostname: null` result meaning "unknown"
 * rather than "none". A renderer must not fold this into a blank cell or a
 * dash indistinguishable from missing data -- it is evidence ("the app on
 * this port answered/didn't"), just evidence with no name attached to it.
 */
export const OnBoxProbeResultSchema = z.object({
  hostname: z.string().min(1).nullable(),
  outcome: ProbeOutcomeSchema,
  status: z.number().int().nullable(),
})
export type OnBoxProbeResult = z.infer<typeof OnBoxProbeResultSchema>

export const SystemStateSchema = z.object({
  key: z.string().min(1),
  displayName: z.string().min(1),
  health: HealthStateSchema,
  containers: z.object({ total: z.number().int().min(0), running: z.number().int().min(0) }),
  // Null means "not determined", which is distinct from "nothing deployed".
  deployedSha: z.string().regex(/^[0-9a-f]{40}$/).nullable(),
  deployedSubject: z.string().nullable(),
  deployedAt: z.string().datetime().nullable(),
  driftCommits: z.number().int().min(0).nullable(),
  /**
   * The hostnames this system's published ports resolve to, per the host's
   * own reverse-proxy config -- see `agent/src/vhosts.ts`.
   *
   * DELIBERATELY `.optional()`, NOT `.default([])`: an older agent (from
   * before this field existed, or a newer agent whose vhost-directory read
   * failed this tick -- see `agent/src/collect.ts`) sends no key at all, and
   * that must parse to `undefined`, never to `[]`. Defaulting it to `[]`
   * would make "we do not know this tick" indistinguishable from "we looked
   * and this system genuinely has no HTTP surface" -- a real positive fact a
   * NEW agent reports by sending an actual empty array. Both shapes are
   * legal on the wire; only the caller (a NEW agent) can produce the
   * confident empty-array claim, and only by actually having read the vhost
   * config and found nothing there.
   */
  hostnames: z.array(HostnameConfigSchema).optional(),
  /**
   * One entry per on-box probe target for this system. Same
   * `undefined`-vs-`[]` discipline as `hostnames` above, for the same
   * reason and from the same source (both are populated together, or not at
   * all, by `agent/src/collect.ts`).
   */
  onBoxProbes: z.array(OnBoxProbeResultSchema).optional(),
})
export type SystemState = z.infer<typeof SystemStateSchema>

export const FleetSnapshotSchema = z.object({
  collectedAt: z.string().datetime(),
  systems: z.array(SystemStateSchema),
})
export type FleetSnapshot = z.infer<typeof FleetSnapshotSchema>

/**
 * Sent once by an agent immediately after its connection opens, before any
 * snapshot.
 *
 * This is NOT an identity claim and the dashboard must never treat it as
 * one: an agent's identity is established solely by its bearer token, which
 * the dashboard resolves to a host row itself. `hostName` is what the
 * MONITORED HOST'S OWN CONFIG (AGENT_HOST_NAME) believes this machine is
 * called, sent purely so the dashboard can compare the two and log a
 * mismatch as the misconfiguration it is -- most usefully, one host's token
 * installed on a different host, which otherwise silently files that
 * machine's systems under someone else's row.
 *
 * Because it is advisory, a mismatch is LOGGED, never enforced: letting a
 * typo in an env var take a production host off the fleet board would be a
 * strictly worse outcome than the mislabelling it is meant to catch.
 */
export const AgentHelloSchema = z.object({
  type: z.literal('hello'),
  hostName: z.string().min(1),
})
export type AgentHello = z.infer<typeof AgentHelloSchema>

/**
 * Maps an HTTP status onto an outcome.
 *
 * 401 and 403 count as ANSWERING. A login wall is an application working.
 * Measured across every hostname on the monitored host, a "200 is healthy"
 * rule would have marked 19 of 42 as broken while they were fine, and a
 * column that cries wolf is a column nobody reads.
 *
 * INPUT DOMAIN: a real HTTP status from a COMPLETED response, nothing else.
 * A probe that never got a response — DNS failure, refused connection, TLS
 * rejection, timeout — must go to `classifyProbeFailure` instead; that is
 * the discipline every caller in this repository is expected to follow, not
 * yet a fact any of them demonstrates, since neither function has a
 * production caller today. The distinction matters because this function
 * cannot represent "no answer": it is a ladder of comparisons over a
 * number, so it will cheerfully classify a value that is not a status at
 * all. 0 and 199 fall through to `answering`; 1000 lands on `not-answering`.
 * Neither is reachable today, and neither is meaningful — do not add
 * validation to make them so, add it at the call site that produced a
 * non-status.
 */
export function classifyHttpStatus(status: number): ProbeOutcome {
  if (status === 502 || status === 504) return 'proxy-no-upstream'
  if (status >= 500) return 'not-answering'
  if (status === 401 || status === 403) return 'answering'
  if (status >= 400) return 'answering-oddly'
  return 'answering'
}

/** A probe that produced no HTTP status at all. TLS is kept separate: a
 * certificate problem is a different repair from a dead application. */
export function classifyProbeFailure(kind: 'tls' | 'network' | 'timeout'): ProbeOutcome {
  return kind === 'tls' ? 'tls-failed' : 'not-answering'
}

/**
 * Folds an outcome onto the health scale the container side already uses.
 * `not-probed` yields null — no opinion — so a system nobody could probe is
 * reported exactly as its containers describe it and is never downgraded
 * for the absence of a probe, nor upgraded by one that never ran.
 */
export function probeOutcomeToHealth(o: ProbeOutcome): HealthState | null {
  switch (o) {
    case 'answering':
      return 'healthy'
    case 'answering-oddly':
      return 'degraded'
    case 'not-answering':
    case 'proxy-no-upstream':
    case 'tls-failed':
      return 'down'
    case 'not-probed':
      return null
  }
}
