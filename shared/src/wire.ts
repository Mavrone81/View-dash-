import { z } from 'zod'

export const HealthStateSchema = z.enum(['healthy', 'degraded', 'down', 'unknown'])
export type HealthState = z.infer<typeof HealthStateSchema>

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
