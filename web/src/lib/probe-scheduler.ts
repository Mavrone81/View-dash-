import type { PrismaClient } from '@prisma/client'
import { prisma } from './db.js'
import { httpsExternalRequest, type ExternalDeps } from './external-probe.js'
import { runExternalProbes } from './external-probe-runner.js'
import { currentExternalProbeTargets } from './external-probe-targets.js'
import { latestExternalProbeRun, EXTERNAL_PROBE_INTERVAL_MS as FLEET_QUERY_EXTERNAL_PROBE_INTERVAL_MS } from './fleet-query.js'

/**
 * Re-exported, NOT redefined. `fleet-query.ts`'s own docstring on this
 * constant records the obligation directly: `EXTERNAL_RESULT_STALE_AFTER_MS`
 * (the board's 15-minute staleness ceiling) is only "three missed cycles" if
 * this scheduler runs on the SAME cadence that constant was derived from. A
 * second `300_000` defined here, even one that happens to hold the same
 * value today, would decouple the two the moment either one is edited
 * without the other -- this import is what makes that impossible rather
 * than merely undocumented.
 */
export const EXTERNAL_PROBE_INTERVAL_MS = FLEET_QUERY_EXTERNAL_PROBE_INTERVAL_MS

/**
 * Whether a new external sweep is due, given when the last one ran (`null`
 * if none ever has) and the current time.
 *
 * A pure function of two timestamps, deliberately: it has no memory of its
 * own, so it gives the SAME answer whether this process has been running
 * for weeks or was restarted ten seconds ago -- `lastRunAt` always comes
 * from `ExternalProbeRun`, a persisted fact, never from an in-memory
 * variable that a restart would reset to "never ran" and cause an
 * immediate, unwanted re-probe of every hostname on the fleet the moment
 * the dashboard container restarts.
 */
export function shouldRunExternalProbe(lastRunAt: Date | null, now: Date): boolean {
  if (lastRunAt === null) return true
  return now.getTime() - lastRunAt.getTime() >= EXTERNAL_PROBE_INTERVAL_MS
}

/**
 * The real, live `ExternalDeps` -- `httpsExternalRequest` wired in exactly
 * as `external-probe.ts`'s own docstrings describe production doing: no
 * `port`/`ca` test overrides, ever, and `scheme` forwarded UNCHANGED from
 * whatever `probeExternally` decided from this hostname's own `listensTls`.
 * This is the one call site in the whole codebase where a live probe
 * actually leaves this box.
 *
 * EXPORTED (fix round 1, Task 9 review, H2) specifically so a test can call
 * `productionDeps.request` directly and confirm `scheme` actually survives
 * this handoff -- before this export existed, nothing in the suite invoked
 * this object at all (every test built its OWN `deps`), so dropping `scheme`
 * from the line below (`httpsExternalRequest(hostname, signal, {})`) left
 * all 826 tests passing and `tsc -b` clean. That is the exact "asserted on
 * the argument, not the wire" shape this slice already paid a Critical for
 * in `external-probe.test.ts`, relocated one layer up -- and the defect it
 * would silently reintroduce is the dangerous one: a plain-HTTP vhost
 * dialled over TLS on 443, answered by a different tenant's server block,
 * recorded as `answering`, the row goes green on someone else's response.
 * See `probe-scheduler.test.ts`'s test against this exact export.
 */
export const productionDeps: ExternalDeps = {
  request: (hostname, signal, scheme) => httpsExternalRequest(hostname, signal, { scheme }),
}

export type SchedulerLogger = {
  warn: (...args: unknown[]) => void
  error: (...args: unknown[]) => void
}

/**
 * One check: is a sweep due, and if so, run it. This is the function a
 * timer calls repeatedly (see `startExternalProbeScheduler` below) -- it is
 * NOT itself the 5-minute cadence. It is meant to be invoked far more often
 * than that (the timer below uses `CHECK_INTERVAL_MS`) and simply does
 * nothing on every tick that is not due, which is what makes the cadence
 * survive a process restart correctly: the check re-reads `ExternalProbeRun`
 * every time rather than trusting an in-memory clock.
 *
 * NEVER throws. This is a scheduled path (spec's own rule, echoed in every
 * probe function this slice built): a probe -- and the decision of whether
 * to run one -- is a diagnostic, and a failure in it is a datum to log, not
 * a reason to crash the process that also serves the fleet board and the
 * agent ingest socket.
 */
export async function runExternalProbeCycle(
  now: Date = new Date(),
  deps: ExternalDeps = productionDeps,
  client: PrismaClient = prisma,
  log: SchedulerLogger = console,
): Promise<void> {
  try {
    const lastRun = await latestExternalProbeRun(client)
    if (!shouldRunExternalProbe(lastRun?.ranAt ?? null, now)) return
    const targets = await currentExternalProbeTargets(client)
    await runExternalProbes(targets, deps, client)
  } catch (err) {
    // Contained, the same way `agent/src/loop.ts`'s `createTickRunner`
    // contains a collection-tick failure: one bad cycle (a transient DB
    // hiccup between the read and the write, say) must degrade this one
    // sweep, never take down the process serving the fleet board.
    log.error('[probe-scheduler] external probe cycle failed; continuing:', err)
  }
}

/**
 * How often THIS PROCESS checks whether a sweep is due -- NOT the sweep's
 * own cadence, which is `EXTERNAL_PROBE_INTERVAL_MS` above. Deliberately
 * much shorter (30s, matching the agent's own default poll interval) so a
 * due sweep starts promptly rather than waiting up to a whole cadence
 * period after it becomes due; deliberately NOT the same constant as
 * `EXTERNAL_PROBE_INTERVAL_MS` -- conflating the two would either make the
 * real internet traffic this comment (and Task 9's brief) warns about fire
 * every 30 seconds, or make "due" sweeps wait up to 5 extra minutes to
 * actually start. `shouldRunExternalProbe` is what still enforces the real
 * 5-minute cadence regardless of how often this timer fires.
 */
const CHECK_INTERVAL_MS = 30_000

/**
 * Starts the scheduler: an interval that checks, at `CHECK_INTERVAL_MS`,
 * whether a sweep is due, with an overlap guard so a slow sweep (42
 * hostnames, some timing out at `DEFAULT_EXTERNAL_TIMEOUT_MS` each) cannot
 * stack a second one on top of itself -- the same shape
 * `agent/src/loop.ts`'s `createTickRunner` uses for the on-box collection
 * loop, reproduced locally here rather than imported: `agent` and `web` are
 * separate npm workspaces, `agent`'s bundle is built standalone for a
 * monitored host with no monorepo (see `scripts/build/bundle-agent.mjs`),
 * and importing across that boundary would tie the two together for no
 * benefit -- this file's own guard is a handful of lines, not worth a
 * cross-workspace dependency to avoid duplicating.
 *
 * Returns a stop function so a test (or a graceful shutdown path, should one
 * ever be added) can tear the interval down; production's one call site
 * (`ingest-server.ts`'s self-start guard) never calls it, by design -- this
 * process runs until the container stops.
 */
export function startExternalProbeScheduler(
  deps: ExternalDeps = productionDeps,
  client: PrismaClient = prisma,
  log: SchedulerLogger = console,
): () => void {
  let inFlight = false

  const tick = (): void => {
    if (inFlight) return
    inFlight = true
    void runExternalProbeCycle(new Date(), deps, client, log).finally(() => {
      inFlight = false
    })
  }

  const timer = setInterval(tick, CHECK_INTERVAL_MS)
  // Also check once immediately at startup, rather than waiting a full
  // `CHECK_INTERVAL_MS` before the very first sweep -- on a fresh deploy
  // (no `ExternalProbeRun` row yet) `shouldRunExternalProbe` is due
  // instantly, and there is no reason to make an operator watching a fresh
  // deploy wait 30 extra seconds to see it start.
  tick()

  return () => clearInterval(timer)
}
