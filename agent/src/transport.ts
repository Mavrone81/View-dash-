import { WebSocket } from 'ws'
import type { FleetSnapshot } from '@bevora-ops/shared'
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
 * A failed send never throws out of this class: it backs off (capped
 * exponential) and returns normally. Losing the dashboard must never kill
 * the agent -- the dashboard shows this host as stale in the meantime,
 * which is the correct thing for an operator to see. The next scheduled
 * `send` call is what actually retries; this class does not run its own
 * retry loop.
 */
export class AgentTransport {
  private ws: WebSocket | null = null
  private attempt = 0
  private readonly backoff: BackoffConfig

  constructor(
    private readonly cfg: AgentConfig,
    backoff: BackoffConfig = DEFAULT_BACKOFF,
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
        this.attempt = 0
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
    try {
      const ws = await this.connect()
      ws.send(JSON.stringify({ type: 'snapshot', payload: snapshot }))
    } catch (err) {
      // Losing the dashboard must never kill the agent: back off and retry
      // on the next scheduled tick. The dashboard shows this host as stale
      // in the meantime, which is the correct thing for an operator to see.
      //
      // Only the failure's own message is logged -- never `this.cfg`, never
      // the WebSocket instance, never the upgrade request/headers -- so the
      // bearer token can never reach a log line from this path.
      const wait = nextBackoffMs(this.attempt++, this.backoff.base, this.backoff.cap)
      const reason = err instanceof Error ? err.message : 'unknown error'
      console.error(`[agent] send failed, retrying in ${wait}ms: ${reason}`)
      await new Promise((r) => setTimeout(r, wait))
    }
  }
}
