import type { FleetSnapshot, SystemState } from '@bevora-ops/shared'
import { discoverSystems, type ContainerSummary } from './docker.js'
import { parseDeployLog } from './deploy-log.js'
import { readGitState } from './git.js'

export type CollectDeps = {
  listContainers: () => Promise<ContainerSummary[]>
  readDeployLog: (systemKey: string) => Promise<string | null>
  repoDirFor: (systemKey: string) => string
  now: () => Date
}

export async function collectSnapshot(deps: CollectDeps): Promise<FleetSnapshot> {
  const discovered = discoverSystems(await deps.listContainers())

  const systems: SystemState[] = await Promise.all(
    discovered.map(async (d): Promise<SystemState> => {
      // Every per-system failure is contained here: one bad log or repo
      // degrades that row only, and never removes it from the board.
      let sha: string | null = null
      try {
        const text = await deps.readDeployLog(d.key)
        sha = text ? (parseDeployLog(text)?.sha ?? null) : null
      } catch {
        sha = null
      }

      let git = { deployedSha: sha, subject: null as string | null, deployedAt: null as Date | null, driftCommits: null as number | null }
      try {
        git = await readGitState(deps.repoDirFor(d.key), sha)
      } catch {
        /* keep the nulls */
      }

      return {
        key: d.key,
        displayName: d.displayName,
        health: d.health,
        containers: d.containers,
        // A short sha from a log is not a valid 40-char wire sha; only the
        // git-resolved full sha is reported.
        deployedSha: git.deployedSha && /^[0-9a-f]{40}$/.test(git.deployedSha) ? git.deployedSha : null,
        deployedSubject: git.subject,
        deployedAt: git.deployedAt ? git.deployedAt.toISOString() : null,
        driftCommits: git.driftCommits,
      }
    }),
  )

  return { collectedAt: deps.now().toISOString(), systems }
}
