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
