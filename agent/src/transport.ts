import { WebSocket } from 'ws'
import type { AgentHello, FleetSnapshot } from '@bevora-ops/shared'
import type { AgentConfig } from './config.js'

export type BackoffConfig = { base: number; cap: number }

const DEFAULT_BACKOFF: BackoffConfig = { base: 1000, cap: 60_000 }

export function nextBackoffMs(attempt: number, base = 1000, cap = 60_000): number {
  return Math.min(cap, base * 2 ** attempt)
}

/**
 * The agent's ONLY connection to the dashboard. This class DIALS OUT and
 * holds the connection open across calls to `send` -- it never listens for
 * inbound connections, so nothing on the monitored host binds a new port.
 *
 * A failed send never throws out of this class: it records a backoff
 * deadline (capped exponential) and returns normally. Losing the dashboard
 * must never kill the agent -- the dashboard shows this host as stale in
 * the meantime, which is the correct thing for an operator to see. The
 * next scheduled `send` call is what actually retries; this class does not
 * run its own retry loop.
 *
 * The backoff SUPPRESSES attempts; it does not sleep. This distinction is
 * the whole point of it. An earlier version did `await sleep(wait)` inside
 * the failing `send`, which delayed only the call that already failed --
 * the caller (agent/src/main.ts) fires a tick on a fixed interval, so
 * every subsequent tick still dialled a brand-new socket right on
 * schedule. Through a dashboard outage that produced one fresh connection
 * attempt every interval, indefinitely, no matter how large the computed
 * backoff had grown: the cap was decorative. Recording a DEADLINE instead
 * means a `send` that arrives too early returns without touching the
 * network at all, which is what actually throttles reconnection -- and it
 * also stops the agent's collection loop from being blocked for the
 * backoff duration.
 *
 * `now` is injectable purely so tests can advance the clock without
 * waiting in real time; production always uses `Date.now`.
 */
export class AgentTransport {
  private ws: WebSocket | null = null
  private attempt = 0
  /**
   * Timestamp (same epoch as `now()`) before which `send` must not attempt
   * a connection. 0 means "no backoff in effect", which is the state after
   * construction and after any successful send.
   */
  private retryNotBefore = 0
  private readonly backoff: BackoffConfig

  constructor(
    private readonly cfg: AgentConfig,
    backoff: BackoffConfig = DEFAULT_BACKOFF,
    private readonly now: () => number = Date.now,
  ) {
    this.backoff = backoff
  }

  private async connect(): Promise<WebSocket> {
    if (this.ws?.readyState === WebSocket.OPEN) return this.ws
    return new Promise((resolve, reject) => {
      // The agent dials OUT: nothing new listens on the monitored host.
      // The token travels as a bearer credential in the upgrade request's
      // headers -- never in the URL, never logged here or on any path
      // below.
      const ws = new WebSocket(this.cfg.dashboardUrl, {
        headers: { authorization: `Bearer ${this.cfg.token}` },
      })
      ws.once('open', () => {
        this.ws = ws
        // A live connection clears the backoff entirely: the next failure
        // must start counting from the base delay again, not from wherever
        // the previous outage's exponent had climbed to.
        this.attempt = 0
        this.retryNotBefore = 0
        // Once per connection, before any snapshot: what THIS host's own
        // config believes it is called. The dashboard does not use it to
        // identify this agent (the bearer token does that, and only that);
        // it compares the two and logs a mismatch, which is how installing
        // one host's token on a different host becomes visible instead of
        // silently mis-filing this machine's systems under another host's
        // row. See AgentHelloSchema and agent/src/config.ts's `hostName`.
        const hello: AgentHello = { type: 'hello', hostName: this.cfg.hostName }
        ws.send(JSON.stringify(hello))
        resolve(ws)
      })
      ws.once('error', (e: unknown) => {
        this.ws = null
        reject(e)
      })
      ws.once('close', () => {
        this.ws = null
      })
    })
  }

  async send(snapshot: FleetSnapshot): Promise<void> {
    // Suppressed: a previous send failed and its backoff has not elapsed.
    // Return WITHOUT touching the network -- no socket, no DNS, no TLS
    // handshake against a dashboard that is already known to be down. This
    // is the line that makes the cap mean something; see the class comment.
    if (this.now() < this.retryNotBefore) return

    try {
      const ws = await this.connect()
      ws.send(JSON.stringify({ type: 'snapshot', payload: snapshot }))
    } catch (err) {
      // Losing the dashboard must never kill the agent: record the backoff
      // deadline and let a later scheduled tick retry once it passes. The
      // dashboard shows this host as stale in the meantime, which is the
      // correct thing for an operator to see.
      //
      // Only the failure's own message is logged -- never `this.cfg`, never
      // the WebSocket instance, never the upgrade request/headers -- so the
      // bearer token can never reach a log line from this path.
      const wait = nextBackoffMs(this.attempt++, this.backoff.base, this.backoff.cap)
      this.retryNotBefore = this.now() + wait
      const reason = err instanceof Error ? err.message : 'unknown error'
      console.error(`[agent] send failed, not retrying for ${wait}ms: ${reason}`)
    }
  }
}
