/**
 * The agent's collection loop, separated from `main.ts`'s wiring so it can
 * be tested without a Docker daemon, a dashboard, or a real config.
 *
 * This exists because `main.ts` originally did the two most dangerous
 * things a long-lived interval loop can do, on a host carrying nine
 * businesses' production:
 *
 *  1. `setInterval(() => { void tick() })` with NO `.catch`. `void` on a
 *     promise does not handle its rejection -- it only silences the
 *     linter. One rejected `docker.listContainers()` (the daemon
 *     restarting, a socket hiccup, an EMFILE) therefore became an
 *     unhandled rejection, which Node terminates the process for by
 *     default. That was masked by `deploy/agent.service`'s
 *     `Restart=always`, so the symptom was an agent that silently
 *     respawned rather than one that reported a transient error and
 *     carried on -- and a masked crash loop is exactly the kind of thing
 *     that stays invisible until the day it does not recover.
 *
 *  2. No overlap guard. If one tick outlives the interval (a slow Docker
 *     daemon, a slow HTTP probe, a stalled deploy-log read), the next tick
 *     starts anyway, and the one after that, each holding its own file
 *     handles and its own Docker request. The overlap compounds precisely
 *     when the host is already struggling, which is the worst possible
 *     moment for the monitoring agent to add load.
 *
 * Both are fixed here: every tick's failure is caught and logged (never
 * fatal), and a tick that is still running causes the next scheduled one
 * to be SKIPPED rather than stacked. Skipping is the right call over
 * queueing: the next tick would collect the same thing a moment later
 * anyway, so a queue would only ever accumulate stale work.
 */
export type LoopLogger = {
  warn: (...args: unknown[]) => void
  error: (...args: unknown[]) => void
}

/**
 * Wraps `tick` in the crash-containment and overlap guard described above.
 *
 * The returned function NEVER rejects -- that is its contract, and it is
 * what makes `void run()` on an interval safe. Callers get a promise they
 * may await (tests do) or ignore (the interval does).
 */
export function createTickRunner(
  tick: () => Promise<void>,
  log: LoopLogger = console,
): () => Promise<void> {
  let inFlight = false
  return async (): Promise<void> => {
    if (inFlight) {
      // Logged, not silent: an operator seeing this repeatedly is being
      // told the collection interval is shorter than collection takes,
      // which is a real, actionable configuration problem.
      log.warn('[agent] previous collection is still running; skipping this tick')
      return
    }
    inFlight = true
    try {
      await tick()
    } catch (err) {
      // Contained: one failed collection must degrade one cycle, never
      // terminate the process. Only the error itself is logged -- no
      // config, no transport, nothing that could carry the bearer token.
      log.error('[agent] collection tick failed; continuing:', err)
    } finally {
      // `finally`, not the end of `try`: a throw must release the guard
      // too, or one failure would wedge the loop permanently.
      inFlight = false
    }
  }
}
