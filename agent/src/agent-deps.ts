import { readFile } from 'node:fs/promises'
import type { AgentConfig } from './config.js'
import type { CollectDeps } from './collect.js'
import { toSummary } from './docker.js'
import { probeHostnameOnBox, probeUrl, type FetchLike } from './probe.js'
import { resolveDeployLogPath, resolveRepoDir } from './paths.js'
import { discoverHostnamesFromDir, nodeVhostFs } from './vhosts.js'

/**
 * The one method of dockerode's `Docker` this module actually calls,
 * pulled out as its own tiny structural type rather than importing
 * `Docker` itself.
 *
 * This is what makes `buildCollectDeps` testable without a real Docker
 * socket, a mock library, or satisfying dockerode's full (three-overload,
 * callback-and-promise) `listContainers` signature: a plain object literal
 * with one `async` method is enough. `main.ts` still passes a real
 * `Docker` instance at the only real call site -- its promise-shaped
 * overload is structurally compatible with this narrower type.
 */
export type DockerLike = {
  listContainers(opts: { all: boolean }): Promise<Array<Parameters<typeof toSummary>[0]>>
}

/** A minimal logger, so a test can assert what gets logged instead of the real console. */
export type Logger = { warn: (...args: unknown[]) => void }

/**
 * Reads the host's own reverse-proxy config and derives which hostnames
 * serve which loopback port -- see `agent/src/vhosts.ts`'s module docstring
 * for why this is derived rather than configured.
 *
 * Logs (never throws) when the vhost directory itself could not be read
 * this tick: that is a diagnostic failure worth an operator seeing, quite
 * different from "read it fine, this host has zero vhosts" -- collapsing
 * the two would render every system on the board as having no HTTP surface,
 * which is the false claim `discoverHostnamesFromDir`'s `null` return
 * exists to prevent. See its docstring and `agent/src/collect.ts`'s
 * `hostnamesByPort` for the contract this satisfies.
 *
 * Returns a closure (not the `Map | null` itself) because `CollectDeps`
 * wants this read to happen ONCE PER TICK, not once at startup -- a vhost
 * file can change between ticks (certbot renewing, a new stack deploying),
 * and `collectSnapshot` calls this closure fresh every time it runs.
 */
export function buildHostnamesByPort(
  vhostDir: string,
  log: Logger = console,
): () => Promise<Map<number, string[]> | null> {
  return async () => {
    const byPort = await discoverHostnamesFromDir(vhostDir, nodeVhostFs)
    if (byPort === null) {
      log.warn(`[agent] vhost directory unreadable (${vhostDir}); on-box hostname probing skipped this tick`)
    }
    return byPort
  }
}

/**
 * Builds the real `CollectDeps` this agent runs with in production.
 *
 * Extracted out of `main.ts` specifically because a seam review found the
 * inline version untestable: `main.ts` runs `loadConfig()`, connects to
 * Docker, and starts the tick interval the moment it is imported, so
 * nothing could import it to check the wiring without also running the
 * whole agent. That made two of `CollectDeps`' keys -- `hostnamesByPort`
 * and `probeOnBoxHostname` -- both optional AND untested at the one place
 * they were actually wired: deleting either line in `main.ts` typechecked,
 * passed every existing test, and silently reverted on-box probing to
 * inert. See `agent-deps.test.ts`'s "wires both on-box probing keys" test,
 * which exists to catch exactly that regression.
 *
 * `fetchImpl` defaults to the global `fetch` (what `main.ts` actually
 * wants) but is an explicit parameter so a test can inject a fake and
 * assert on what this function actually dials -- see
 * `agent-deps.test.ts`'s "genuinely calls through" test, which is the
 * second half of what that same review asked for.
 */
export function buildCollectDeps(cfg: AgentConfig, docker: DockerLike, fetchImpl: FetchLike = fetch): CollectDeps {
  return {
    // `key` originates from a Docker compose-project label on the monitored
    // host, not from this agent's own config -- resolveDeployLogPath and
    // resolveRepoDir below both guard against it being used to escape the
    // configured glob/root (see agent/src/paths.ts). Per-system failures
    // here (bad path, unreadable file) are contained by collectSnapshot's
    // own try/catch around each of these calls, so one bad key degrades
    // only that system's row.
    listContainers: async () => (await docker.listContainers({ all: true })).map(toSummary),
    readDeployLog: async (key) => readFile(resolveDeployLogPath(cfg.deployLogGlob, key), 'utf8').catch(() => null),
    repoDirFor: (key) => resolveRepoDir(cfg.repoRoot, key),
    now: () => new Date(),
    // Spec §4.1's HTTP probe. `systemUrls` is empty unless an operator sets
    // AGENT_SYSTEM_URLS, and a system with no entry is simply not probed --
    // never downgraded for it. See agent/src/config.ts for why that map is
    // empty in every deployment today.
    urlFor: (key) => cfg.systemUrls[key] ?? null,
    probe: (url) => probeUrl(url, fetchImpl, cfg.probeTimeoutMs),
    // The on-box probe: no operator configuration required at all, unlike
    // urlFor/probe above -- every hostname comes from the host's own proxy
    // config, and every system's published ports come from Docker itself.
    hostnamesByPort: buildHostnamesByPort(cfg.vhostDir),
    probeOnBoxHostname: (hostname, port) => probeHostnameOnBox(hostname, port, fetchImpl, cfg.probeTimeoutMs),
  }
}
