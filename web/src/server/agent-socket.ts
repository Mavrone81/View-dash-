import { ingestSnapshot } from './ingest.js'

export type SnapshotResponse = { type: 'ack'; accepted: number } | { type: 'error'; message: string }

/**
 * The one, stable, non-descriptive message ever returned to a peer for ANY
 * rejected snapshot. `ingestSnapshot` throws `ZodError`s carrying
 * schema-shape detail (field paths, issue codes, enum values) and can throw
 * raw Prisma errors naming tables and columns (e.g. a foreign-key violation
 * on `System.hostId`). Both are exactly the kind of database-internals
 * disclosure this connection must never hand to anyone who merely holds a
 * valid agent token -- so every rejection collapses to this one string, and
 * the response gives no signal by which an attacker could distinguish "bad
 * schema" from "bad host" from "database error".
 */
const REJECTED = 'snapshot rejected'

/**
 * Handles one inbound snapshot message on an ALREADY-AUTHENTICATED agent
 * connection -- `hostId` is the id resolved by `authenticateAgent` before
 * this is ever called; the bearer token itself is never in scope here.
 *
 * This is the one place a raw error from `ingestSnapshot` could reach the
 * wire, so it is the one place that must catch and generalise: the real
 * cause is logged server-side only (see the comment on the `console.error`
 * call below for exactly what that log line does and does not contain),
 * and only the fixed `REJECTED` string above is ever returned to the peer.
 */
export async function handleSnapshotMessage(hostId: string, raw: unknown): Promise<SnapshotResponse> {
  try {
    const { accepted } = await ingestSnapshot(hostId, raw)
    return { type: 'ack', accepted }
  } catch (err) {
    // Server-side only, never forwarded: `hostId` is an opaque id (not a
    // secret) logged for operability, and `err` (which may be a ZodError
    // with schema-shape detail, or a Prisma error naming tables/columns) is
    // logged for diagnosis. Neither this log line nor any other in this
    // function ever references the bearer token -- authentication already
    // happened in the caller, before this function runs, so the token is
    // simply not a value this function has access to.
    console.error(`[agent-socket] snapshot rejected for host ${hostId}:`, err)
    return { type: 'error', message: REJECTED }
  }
}
