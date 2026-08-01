import { WebSocketServer, type WebSocket, type RawData } from 'ws'
import type { IncomingMessage } from 'node:http'
import { authenticateAgent } from './auth-agent.js'
import { handleSnapshotMessage } from './agent-socket.js'
import { prisma } from '../lib/db.js'
import { loadIngestServerConfig, type IngestServerConfig } from './ingest-server-config.js'

const BEARER_PREFIX = 'Bearer '

// Application-defined close code (the 4000-4999 range is reserved for
// private use by RFC 6455). A fixed, generic reason accompanies it -- this
// is a network boundary reached from a different machine, so the reason
// text is exactly as public as any other unauthenticated-request response
// and must never hint at *why* the token failed.
const UNAUTHORIZED_CLOSE_CODE = 4001
const UNAUTHORIZED_REASON = 'unauthorized'

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
  const wss = new WebSocketServer({ host: config.host, port: config.port })
  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
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
  let rejected = false

  ws.on('message', (data: RawData) => {
    if (rejected) return
    if (authorizedHostId !== null) {
      void handleMessage(ws, authorizedHostId, data)
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
  const host = await prisma.host.findUnique({ where: { id: auth.hostId } })
  console.log(`[ingest-server] agent connected: ${host?.name ?? auth.hostId}`)

  authorizedHostId = auth.hostId
  for (const data of queued.splice(0)) void handleMessage(ws, auth.hostId, data)
}

async function handleMessage(ws: WebSocket, hostId: string, data: RawData): Promise<void> {
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

if (import.meta.url === `file://${process.argv[1]}`) {
  const cfg = loadIngestServerConfig()
  const wss = startIngestServer(cfg)
  wss.once('listening', () => {
    console.log(`[ingest-server] listening on ${cfg.host}:${cfg.port}`)
  })
}
