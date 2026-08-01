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
