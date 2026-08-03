import Docker from 'dockerode'
import { readFile } from 'node:fs/promises'
import { loadConfig } from './config.js'
import { collectSnapshot } from './collect.js'
import { toSummary } from './docker.js'
import { AgentTransport } from './transport.js'
import { createTickRunner } from './loop.js'
import { probeHostnameOnBox, probeUrl } from './probe.js'
import { resolveDeployLogPath, resolveRepoDir } from './paths.js'
import { discoverHostnamesFromDir, nodeVhostFs } from './vhosts.js'

const cfg = loadConfig()
const docker = new Docker()
// The agent's only network connection: it DIALS OUT to the dashboard and
// holds that connection open across ticks. Nothing in this file, or in
// AgentTransport, ever binds a listening socket on this host.
const transport = new AgentTransport(cfg)

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
 * exists to prevent. See its docstring and agent/src/collect.ts's
 * `hostnamesByPort` for the contract this satisfies.
 */
async function hostnamesByPort(): Promise<Map<number, string[]> | null> {
  const byPort = await discoverHostnamesFromDir(cfg.vhostDir, nodeVhostFs)
  if (byPort === null) {
    console.warn(`[agent] vhost directory unreadable (${cfg.vhostDir}); on-box hostname probing skipped this tick`)
  }
  return byPort
}

async function tick(): Promise<void> {
  const snapshot = await collectSnapshot({
    listContainers: async () => (await docker.listContainers({ all: true })).map(toSummary),
    // `key` originates from a Docker compose-project label on the monitored
    // host, not from this agent's own config -- resolveDeployLogPath and
    // resolveRepoDir below both guard against it being used to escape the
    // configured glob/root (see agent/src/paths.ts). Per-system failures
    // here (bad path, unreadable file) are contained by collectSnapshot's
    // own try/catch around each of these calls, so one bad key degrades
    // only that system's row.
    readDeployLog: async (key) => readFile(resolveDeployLogPath(cfg.deployLogGlob, key), 'utf8').catch(() => null),
    repoDirFor: (key) => resolveRepoDir(cfg.repoRoot, key),
    now: () => new Date(),
    // Spec §4.1's HTTP probe. `systemUrls` is empty unless an operator sets
    // AGENT_SYSTEM_URLS, and a system with no entry is simply not probed --
    // never downgraded for it. See agent/src/config.ts for why that map is
    // empty in every deployment today.
    urlFor: (key) => cfg.systemUrls[key] ?? null,
    probe: (url) => probeUrl(url, fetch, cfg.probeTimeoutMs),
    // The on-box probe: no operator configuration required at all, unlike
    // urlFor/probe above -- every hostname comes from the host's own proxy
    // config, and every system's published ports come from Docker itself.
    hostnamesByPort,
    probeOnBoxHostname: (hostname) => probeHostnameOnBox(hostname, fetch, cfg.probeTimeoutMs),
  })
  // A failed send never throws (see AgentTransport.send): losing the
  // dashboard must never stop this loop from continuing to collect and
  // retry on the next tick.
  await transport.send(snapshot)
}

// NOT `void tick()` directly. `createTickRunner` (see agent/src/loop.ts for
// the full reasoning) contains two failure modes that matter a great deal
// on a host carrying nine businesses' production: a rejected tick is caught
// and logged instead of becoming an unhandled rejection that terminates the
// process (previously masked by deploy/agent.service's `Restart=always`),
// and a tick that outlives the interval causes the next one to be skipped
// instead of stacking concurrent collections onto an already-slow host.
const run = createTickRunner(tick)

setInterval(() => {
  void run()
}, cfg.intervalMs)
void run()
