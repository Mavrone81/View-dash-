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
   * `agent/src/agent-deps.ts`'s `buildHostnamesByPort`.
   *
   * Optional, and absent in every deployment until a monitored host has a
   * vhost path configured to read -- see `agent/src/config.ts`.
   */
  hostnamesByPort?: () => Promise<Map<number, string[]> | null>
  /**
   * Probes one hostname FROM the monitored host itself, by addressing its
   * resolved loopback PORT directly with an explicit `Host` header (see
   * `agent/src/probe.ts`'s `probeHostnameOnBox` and the spec's §3.1
   * correction) -- NOT by resolving the hostname over DNS. Optional for the
   * same reason as `probe` above -- with no hostnames discovered for a
   * system, it is never called for that system.
   */
  probeOnBoxHostname?: (hostname: string | null, port: number) => Promise<{ outcome: ProbeOutcome; status: number | null }>
}

export async function collectSnapshot(deps: CollectDeps): Promise<FleetSnapshot> {
  const discovered = discoverSystems(await deps.listContainers())

  // Read the host's reverse-proxy config ONCE for the whole tick, not once
  // per system: discoverHostnamesByPort needs every vhost file to resolve a
  // named upstream block that may be declared in a different file than the
  // vhost referencing it. `null` means the read failed -- see
  // `hostnamesByPort`'s docstring on CollectDeps -- and must not be treated
  // as "read successfully, found nothing".
  //
  // Wrapped in try/catch: this call sits OUTSIDE the per-system Promise.all
  // below, so an uncaught throw here would fail the ENTIRE snapshot -- every
  // system's container state, sha, and URL probe along with it -- for what
  // is, at worst, one unreadable directory. "Nothing may throw into the
  // collection loop" is stated as an absolute in this project, not a
  // best-effort; a failure here degrades to "skip on-box probing this
  // tick", the same outcome as the directory being unreachable.
  let byPort: Map<number, string[]> | null = null
  if (deps.hostnamesByPort) {
    try {
      byPort = await deps.hostnamesByPort()
    } catch {
      byPort = null
    }
  }

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
      // A system with no published ports at all has no HTTP surface, full
      // stop -- `hostnamesForSystem` then returns `[]`, `onBoxHealth` stays
      // `null`, and `worstOf` leaves the row exactly as the containers (and
      // any URL probe) already describe it. That is the same "null means
      // not probed, never means probed-and-clean" discipline `worstOf`
      // already enforces above; see its docstring in agent/src/probe.ts.
      //
      // A published port with NO vhost mapping is different, and IS still
      // probed: `hostnamesForSystem` yields a `{ hostname: null, port }`
      // target for it (fix round 1's explicit call), which
      // `probeHostnameOnBox` sends with no `Host` header. "The app answered
      // on its port" is weaker evidence than a matched hostname but real,
      // and it is the only evidence available in the gap between a stack's
      // first deploy and its vhost being written.
      //
      // Concurrent across every hostname of this one system, each
      // individually time-bounded by `probeHostnameOnBox`'s own abort (see
      // `probeOnBoxHostname`'s wiring in agent/src/agent-deps.ts) -- and this
      // whole block runs inside the same per-system `Promise.all` callback
      // as everything else here, so it is also concurrent with every OTHER
      // system's on-box probing. Total collection time stays the slowest
      // single probe, never the sum of them all.
      let onBoxHealth: HealthState | null = null
      if (byPort && deps.probeOnBoxHostname) {
        try {
          const targets = hostnamesForSystem(d.publishedPorts, byPort)
          const results = await Promise.all(
            targets.map((t) =>
              deps.probeOnBoxHostname!(t.hostname, t.port).catch(
                // A configured probe function that REJECTS (rather than
                // resolving with a failure outcome, which
                // probeHostnameOnBox always does on its own) is a REAL probe
                // attempt that failed -- evidence about the customer's
                // system, same as any other unreachable hostname -- so it
                // stays `down`-shaped via the ordinary `not-answering`
                // outcome, not the `unknown` used below for a fault in our
                // own machinery.
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
          // collection loop.
          //
          // `unknown`, not `down`: this branch means OUR OWN machinery
          // faulted (a badly-behaved injected function), not that a probe
          // ran and found the customer's system unreachable -- that is what
          // the `not-answering` path above is for, and it correctly stays
          // `down`-shaped. `unknown` is the truthful state for "we cannot
          // vouch for this", and `RANK` in this file already places it
          // below `down` for exactly this reason.
          onBoxHealth = 'unknown'
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
