import Docker from 'dockerode'
import { readFile } from 'node:fs/promises'
import { loadConfig } from './config.js'
import { collectSnapshot } from './collect.js'
import { toSummary } from './docker.js'
import { AgentTransport } from './transport.js'
import { resolveDeployLogPath, resolveRepoDir } from './paths.js'

const cfg = loadConfig()
const docker = new Docker()
// The agent's only network connection: it DIALS OUT to the dashboard and
// holds that connection open across ticks. Nothing in this file, or in
// AgentTransport, ever binds a listening socket on this host.
const transport = new AgentTransport(cfg)

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
  })
  // A failed send never throws (see AgentTransport.send): losing the
  // dashboard must never stop this loop from continuing to collect and
  // retry on the next tick.
  await transport.send(snapshot)
}

setInterval(() => {
  void tick()
}, cfg.intervalMs)
void tick()
