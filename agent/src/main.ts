import Docker from 'dockerode'
import { loadConfig } from './config.js'
import { collectSnapshot } from './collect.js'
import { AgentTransport } from './transport.js'
import { createTickRunner } from './loop.js'
import { buildCollectDeps } from './agent-deps.js'

// This file is deliberately thin, and deliberately untested: everything it
// does beyond wiring the three real singletons together (config, Docker,
// the transport) lives in agent-deps.ts, which HAS no top-level side
// effects and IS tested -- see agent-deps.test.ts. Importing THIS file, by
// contrast, immediately calls loadConfig() (throws without a real
// environment), opens a Docker client, and starts the tick interval below.
// A test file must never import main.ts for that reason; anything worth
// pinning belongs in agent-deps.ts instead.

const cfg = loadConfig()
const docker = new Docker()
// This agent DIALS OUT only -- to the dashboard here (held open across
// ticks), and, every tick, to `127.0.0.1:<published port>` for each
// system's on-box probe (see agent/src/agent-deps.ts/probe.ts). Nothing in
// this file, AgentTransport, or the on-box probe ever binds a LISTENING
// socket on this host. (This comment used to say the dashboard connection
// was the agent's ONLY network connection -- true before this task added
// on-box probing, false now; corrected rather than left to mislead an
// auditor reasoning about this host's egress.)
const transport = new AgentTransport(cfg)

async function tick(): Promise<void> {
  const snapshot = await collectSnapshot(buildCollectDeps(cfg, docker))
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
