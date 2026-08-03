import { WebSocketServer, type WebSocket, type RawData } from 'ws'
import type { IncomingMessage } from 'node:http'
import { AgentHelloSchema } from '@bevora-ops/shared'
import { authenticateAgent } from './auth-agent.js'
import { handleSnapshotMessage } from './agent-socket.js'
import { prisma } from '../lib/db.js'
import { loadIngestServerConfig, type IngestServerConfig } from './ingest-server-config.js'
import { startExternalProbeScheduler } from '../lib/probe-scheduler.js'

const BEARER_PREFIX = 'Bearer '

// Application-defined close code (the 4000-4999 range is reserved for
// private use by RFC 6455). A fixed, generic reason accompanies it -- this
// is a network boundary reached from a different machine, so the reason
// text is exactly as public as any other unauthenticated-request response
// and must never hint at *why* the token failed.
const UNAUTHORIZED_CLOSE_CODE = 4001
const UNAUTHORIZED_REASON = 'unauthorized'

// Distinct from UNAUTHORIZED so an operator (and a test) can tell a
// capacity rejection apart from a credential rejection. Like the code
// above it says nothing an unauthenticated peer could learn from: that the
// listener is at capacity is already evident from being disconnected.
const AT_CAPACITY_CLOSE_CODE = 4002
const AT_CAPACITY_REASON = 'at capacity'

const MALFORMED_MESSAGE = 'malformed message'

/** Extracts the bearer token from an `Authorization` header, or `undefined` if the header is absent, non-string, or not in the expected `Bearer <token>` shape. */
function extractBearerToken(header: string | string[] | undefined): string | undefined {
  if (typeof header !== 'string' || !header.startsWith(BEARER_PREFIX)) return undefined
  return header.slice(BEARER_PREFIX.length)
}

/**
 * The agent wraps its payload as `{ type: 'snapshot', payload }` (see
 * `agent/src/transport.ts`). This unwraps that envelope; anything else --
 * including a differently-shaped object, or the raw value itself -- is
 * passed straight through and re-validated (and, on failure, generalised)
 * by `handleSnapshotMessage` -> `ingestSnapshot`'s own schema check. There
 * is no unsafe path here: an unexpected shape just becomes an ordinary
 * rejection, not a crash.
 */
function extractPayload(parsed: unknown): unknown {
  if (parsed !== null && typeof parsed === 'object' && 'payload' in parsed) {
    return (parsed as { payload?: unknown }).payload
  }
  return parsed
}

/**
 * This is THE listener the agent's outbound `AgentTransport` dials into. It
 * is a standalone process (see the `import.meta.url` guard at the bottom),
 * never part of the Next.js request path, so the dashboard's deployment can
 * run it as its own service.
 *
 * Deployment note: the agent runs on a different machine from this
 * listener and is reached across the internet with TLS terminated at a
 * reverse proxy in front of it -- this code does not implement TLS, and
 * must never assume its peer is on the same host or trusted a priori.
 * Every connection is authenticated before anything it sends is acted on.
 */
export function startIngestServer(config: IngestServerConfig = loadIngestServerConfig()): WebSocketServer {
  const wss = new WebSocketServer({
    host: config.host,
    port: config.port,
    // Explicit, never `ws`'s 100 MB default -- see IngestServerConfig's own
    // comment. `ws` enforces this itself: an oversized frame is closed with
    // 1009 rather than buffered, so the limit costs nothing per message.
    maxPayload: config.maxPayloadBytes,
  })
  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    // MUST come before anything else on this socket. `ws` reports protocol
    // violations by EMITTING an 'error' event on the connection -- and a
    // Node EventEmitter with no 'error' listener THROWS instead, which for
    // this process means the whole listener dies and every other agent's
    // connection dies with it. The `maxPayload` limit above is itself a
    // trigger for exactly that: an oversized frame raises
    // WS_ERR_UNSUPPORTED_MESSAGE_LENGTH here. Found by the oversized-frame
    // test below, which crashed the test run before this listener existed
    // -- i.e. adding a payload cap without this would have converted a
    // memory-exhaustion attempt into a remote crash, which is worse.
    ws.on('error', (err: unknown) => {
      console.error('[ingest-server] connection error:', err)
    })

    // The capacity check comes FIRST, before `handleConnection` and
    // therefore before `authenticateAgent`'s database round trip. That
    // ordering is the point of it: without a cap, any peer could make this
    // listener issue a database query per connection, for free, without
    // ever holding a credential. `wss.clients` already includes this
    // connection, hence `>`.
    if (wss.clients.size > config.maxConnections) {
      ws.close(AT_CAPACITY_CLOSE_CODE, AT_CAPACITY_REASON)
      return
    }
    void handleConnection(ws, req)
  })
  return wss
}

// A well-behaved agent (see agent/src/transport.ts) sends its snapshot the
// instant the connection opens, which can race the single DB round trip
// `authenticateAgent` makes below. Bound how many of those early messages
// are held rather than letting an unauthenticated peer force unbounded
// growth by flooding the socket during that window.
const MAX_QUEUED_DURING_AUTH = 8

async function handleConnection(ws: WebSocket, req: IncomingMessage): Promise<void> {
  // Authentication is one `await` (a single DB lookup), during which a
  // message can legitimately arrive from an agent that sent its snapshot
  // the instant `open` fired. A 'message' listener is attached immediately
  // so that message is not lost -- but it is only QUEUED, never dispatched,
  // until authentication resolves. If authentication fails, the queue is
  // discarded unread: nothing an unauthenticated peer sends is ever passed
  // to `handleMessage`/`handleSnapshotMessage`, regardless of timing.
  const queued: RawData[] = []
  let authorizedHostId: string | null = null
  let authorizedHostName: string | null = null
  let rejected = false

  ws.on('message', (data: RawData) => {
    if (rejected) return
    if (authorizedHostId !== null) {
      void handleMessage(ws, authorizedHostId, authorizedHostName, data)
      return
    }
    if (queued.length < MAX_QUEUED_DURING_AUTH) queued.push(data)
  })

  const auth = await authenticateAgent(extractBearerToken(req.headers.authorization))
  if (!auth) {
    rejected = true
    queued.length = 0
    ws.close(UNAUTHORIZED_CLOSE_CODE, UNAUTHORIZED_REASON)
    return
  }

  // Never the token -- only the host's own name (falling back to its
  // opaque, non-secret id if the row vanished between auth and this
  // lookup), logged purely so an operator can see which agents are live.
  // This same lookup supplies the name the agent's `hello` is checked
  // against below, so the check costs no extra query.
  const host = await prisma.host.findUnique({ where: { id: auth.hostId } })
  console.log(`[ingest-server] agent connected: ${host?.name ?? auth.hostId}`)

  authorizedHostId = auth.hostId
  authorizedHostName = host?.name ?? null
  for (const data of queued.splice(0)) void handleMessage(ws, auth.hostId, authorizedHostName, data)
}

async function handleMessage(
  ws: WebSocket,
  hostId: string,
  hostName: string | null,
  data: RawData,
): Promise<void> {
  try {
    let parsed: unknown
    try {
      parsed = JSON.parse(data.toString())
    } catch {
      // Malformed input never discloses more than this fixed string --
      // not a parser position, not the bytes received, nothing else.
      ws.send(JSON.stringify({ type: 'error', message: MALFORMED_MESSAGE }))
      return
    }

    // The agent's one-shot `hello` (see AgentHelloSchema). Handled before
    // the snapshot path because it is not a snapshot and would otherwise
    // be rejected by it.
    //
    // This is ADVISORY ONLY. `hostId` above came from the bearer token and
    // remains the sole basis for what this connection may write; nothing
    // the peer says here changes it. All a mismatch does is produce a log
    // line -- which is the entire reason AGENT_HOST_NAME still exists. The
    // failure it catches is real and otherwise silent: one host's token
    // installed on a different host files that machine's systems under
    // someone else's row, forever, with the board looking perfectly
    // normal. Rejecting instead of logging was considered and refused: a
    // typo in an env var must not be able to take a production host off
    // the fleet board, which would be a worse outcome than the
    // mislabelling being detected.
    const hello = AgentHelloSchema.safeParse(parsed)
    if (hello.success) {
      if (hostName !== null && hello.data.hostName !== hostName) {
        console.warn(
          `[ingest-server] host-name mismatch: an agent presenting host "${hostName}"'s token reports its own AGENT_HOST_NAME as "${hello.data.hostName}". The token is authoritative and this connection is being accepted as "${hostName}" -- but one of the two hosts is misconfigured, and this host's systems may be filing under the wrong row.`,
        )
      }
      return
    }

    const response = await handleSnapshotMessage(hostId, extractPayload(parsed))
    ws.send(JSON.stringify(response))
  } catch (err) {
    // Defense in depth: nothing above this point is expected to throw
    // (`handleSnapshotMessage` never throws; the JSON.parse failure path is
    // handled explicitly above), but `ws.send` can throw if the peer's
    // socket is already closing. One bad message from one connection must
    // never take the whole listener down for every other connected agent.
    console.error(`[ingest-server] unexpected error handling a message from host ${hostId}:`, err)
  }
}

/**
 * Starts the real ingest process: the WebSocket listener AND the external
 * probe scheduler, together -- exactly what production wants (see the
 * self-start guard below, this function's one real caller).
 *
 * Split out and exported (fix round 1, Task 9 review, H3) specifically so a
 * test can call it directly and observe both halves starting. Before this
 * split, everything past the `import.meta.url` guard was unreachable from
 * any test -- that guard is only ever true when this file is run as a
 * script, which a unit test cannot arrange -- so commenting out
 * `startExternalProbeScheduler()` below left all 826 tests passing and
 * `tsc -b` clean. Combined with H2, the external probe could have been
 * silently disabled entirely (a deploy that drops the one line that starts
 * it) with nothing in CI or `deploy/verify-board.sh` noticing until an
 * operator went looking -- and the board would degrade to exactly the
 * "not yet confirmed" state the runbook teaches people to treat as normal
 * for the first five minutes after a deploy, forever, not for five minutes.
 *
 * `scheduler` defaults to the real `startExternalProbeScheduler` and exists
 * as a parameter ONLY so a test can substitute a spy in its place and
 * assert it was called, without a real 30-second interval and real internet
 * traffic running during the test. Production's one call site (the guard
 * below) never passes anything -- see `ingest-server.test.ts`'s test
 * against this exact function for the pinning this closes.
 */
export function startIngestProcess(
  cfg: IngestServerConfig = loadIngestServerConfig(),
  scheduler: () => () => void = startExternalProbeScheduler,
): WebSocketServer {
  const wss = startIngestServer(cfg)
  wss.once('listening', () => {
    console.log(`[ingest-server] listening on ${cfg.host}:${cfg.port}`)
  })

  // The external prober (Task 6-8) had no production caller until this line:
  // nothing else in this codebase decides WHEN to run it or WHAT to probe.
  // This process is the natural home for that decision, not `web`'s
  // Next.js request server: it is already the long-running, standalone
  // Node process on the dashboard host (see this file's own top-of-file
  // docstring), it already imports `prisma` directly, and
  // `deploy/README.md`'s deploy runbook already restarts BOTH `web` and
  // `ingest` together on every deploy of this repo -- there would be no
  // reason for that if `ingest` had nothing new to pick up here. See
  // `web/src/lib/probe-scheduler.ts` for the cadence and overlap-guard
  // reasoning; this is its one production call site.
  scheduler()
  console.log('[ingest-server] external probe scheduler started')
  return wss
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startIngestProcess()
}
