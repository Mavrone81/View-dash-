import type { FleetSnapshot, HealthState, ProbeOutcome, SystemState } from '@bevora-ops/shared'
import { probeOutcomeToHealth } from '@bevora-ops/shared'
import { discoverSystems, type ContainerSummary } from './docker.js'
import { parseDeployLog } from './deploy-log.js'
import { readGitState } from './git.js'
import { hostnamesForSystem, worstOf } from './probe.js'

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
  /**
   * Every hostname the host's reverse-proxy config maps to each published
   * container port, read ONCE per tick (not once per system) -- resolving a
   * named `upstream` block may require every vhost file to have been seen
   * first, see `discoverHostnamesByPort` in `agent/src/vhosts.ts`.
   *
   * Returns `null` when the vhost directory could not be read this tick
   * (missing path, permission denied, whatever) -- see
   * `agent/src/vhosts.ts`'s `readVhostDir` docstring for why an empty
   * result and an unreadable directory must never be reported as the same
   * fact. `null` here is deliberately NOT the same as an empty `Map`: an
   * empty map means "read the config, found no vhosts for any port",
   * whereas `null` means "did not read the config at all", and only the
   * former is a real fact about the host worth acting on. Both result in no
   * on-box probing this tick, which is the safe behaviour either way, but
   * only `null` is worth a caller logging as a diagnostic failure -- see
   * `agent/src/main.ts`.
   *
   * Optional, and absent in every deployment until a monitored host has a
   * vhost path configured to read -- see `agent/src/config.ts`.
   */
  hostnamesByPort?: () => Promise<Map<number, string[]> | null>
  /**
   * Probes one hostname FROM the monitored host itself, through loopback
   * (see `agent/src/probe.ts`'s `probeHostnameOnBox`). Optional for the
   * same reason as `probe` above -- with no hostnames discovered for a
   * system, it is never called for that system.
   */
  probeOnBoxHostname?: (hostname: string) => Promise<{ outcome: ProbeOutcome; status: number | null }>
}

export async function collectSnapshot(deps: CollectDeps): Promise<FleetSnapshot> {
  const discovered = discoverSystems(await deps.listContainers())

  // Read the host's reverse-proxy config ONCE for the whole tick, not once
  // per system: discoverHostnamesByPort needs every vhost file to resolve a
  // named upstream block that may be declared in a different file than the
  // vhost referencing it. `null` means the read failed -- see
  // `hostnamesByPort`'s docstring on CollectDeps -- and must not be treated
  // as "read successfully, found nothing".
  const byPort = deps.hostnamesByPort ? await deps.hostnamesByPort() : null

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

      // Which hostnames does THIS system's published ports resolve to, and
      // does each one answer through loopback on the monitored host itself?
      // This is separate from the `probed`/`urlFor` block above: that is an
      // EXTERNAL probe of an operator-configured public URL; this is an
      // ON-BOX probe of hostnames DERIVED from the host's own reverse-proxy
      // config, requiring no configuration at all.
      //
      // A system with no published ports, or whose published ports match no
      // vhost, legitimately has no HTTP surface -- `hostnamesForSystem`
      // then returns `[]`, `onBoxHealth` stays `null`, and `worstOf` leaves
      // the row exactly as the containers (and any URL probe) already
      // describe it. That is the same "null means not probed, never means
      // probed-and-clean" discipline `worstOf` already enforces above; see
      // its docstring in agent/src/probe.ts.
      //
      // Concurrent across every hostname of this one system, each
      // individually time-bounded by `probeHostnameOnBox`'s own abort (see
      // `probeOnBoxHostname`'s wiring in agent/src/main.ts) -- and this
      // whole block runs inside the same per-system `Promise.all` callback
      // as everything else here, so it is also concurrent with every OTHER
      // system's on-box probing. Total collection time stays the slowest
      // single probe, never the sum of them all.
      let onBoxHealth: HealthState | null = null
      if (byPort && deps.probeOnBoxHostname) {
        try {
          const hostnames = hostnamesForSystem(d.publishedPorts, byPort)
          const results = await Promise.all(
            hostnames.map((h) =>
              deps.probeOnBoxHostname!(h).catch(
                // A configured probe function that REJECTS (rather than
                // resolving with a failure outcome, which
                // probeHostnameOnBox always does on its own) must still be
                // treated as evidence of a broken hostname, not as an
                // absence of one -- the same rule the URL probe above
                // applies to a throwing `deps.probe`.
                (): { outcome: ProbeOutcome; status: number | null } => ({ outcome: 'not-answering', status: null }),
              ),
            ),
          )
          for (const r of results) {
            const h = probeOutcomeToHealth(r.outcome)
            if (h !== null) onBoxHealth = onBoxHealth === null ? h : worstOf(onBoxHealth, h)
          }
        } catch {
          // The `.catch()` above only guards a REJECTED promise. A
          // `probeOnBoxHostname` that misbehaves badly enough to throw
          // SYNCHRONOUSLY (never returning a promise at all, despite its
          // declared type) would otherwise escape `.map()`/`Promise.all`
          // uncaught and reject THIS SYSTEM'S whole promise -- which,
          // unhandled here, would propagate out of the outer `Promise.all`
          // in `collectSnapshot` and fail the ENTIRE snapshot for every
          // system, not just this one. A probe must never throw into the
          // collection loop; treated as `down`, the same as a URL probe
          // that could not be reached at all.
          onBoxHealth = 'down'
        }
      }

      return {
        key: d.key,
        displayName: d.displayName,
        health: worstOf(worstOf(d.health, probed), onBoxHealth),
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
