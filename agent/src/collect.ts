import type { FleetSnapshot, HealthState, SystemState } from '@bevora-ops/shared'
import { discoverSystems, type ContainerSummary } from './docker.js'
import { parseDeployLog } from './deploy-log.js'
import { readGitState } from './git.js'
import { worstOf } from './probe.js'

export type CollectDeps = {
  listContainers: () => Promise<ContainerSummary[]>
  readDeployLog: (systemKey: string) => Promise<string | null>
  repoDirFor: (systemKey: string) => string
  now: () => Date
  /**
   * This system's public URL, or `null` if none is known.
   *
   * Optional, and defaulting to "no URL for anything": a system with no
   * known URL is simply not probed, and is reported exactly as its
   * containers describe it (see `worstOf`). Downgrading it instead would
   * conflate "nobody told us where this app lives" with "we checked and it
   * is broken", which is precisely the kind of health claim this board must
   * not make.
   */
  urlFor?: (systemKey: string) => string | null
  /**
   * Probes one URL and reports what it found. Optional for the same reason
   * as `urlFor` -- with no URLs configured it is never called.
   */
  probe?: (url: string) => Promise<HealthState>
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

      // Spec §4.1: health is the worst-of container state AND an HTTP
      // probe of the system's public URL -- "A container can be Up while
      // the app 502s -- both, or it is not green."
      //
      // `null` here means NOT PROBED (no URL configured for this system),
      // which leaves the container-derived health untouched. It never
      // means "probe found nothing wrong".
      //
      // This whole block sits inside the same per-system `Promise.all`
      // callback as everything above it, which is what keeps one slow or
      // hanging probe from stalling collection for the other systems: the
      // probes run concurrently with each other, and each is individually
      // bounded in time by `probeUrl`'s own abort. Total collection time
      // is therefore the SLOWEST probe, never the sum of all of them.
      let probed: HealthState | null = null
      const url = deps.urlFor?.(d.key) ?? null
      if (url && deps.probe) {
        try {
          probed = await deps.probe(url)
        } catch {
          // A configured URL that could not be probed at all is evidence,
          // not an absence of it -- unlike the no-URL case above. Anything
          // an operator pointed us at and we could not reach is `down`.
          probed = 'down'
        }
      }

      return {
        key: d.key,
        displayName: d.displayName,
        health: worstOf(d.health, probed),
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
