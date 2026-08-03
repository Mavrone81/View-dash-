import { request as httpsRequest } from 'node:https'
import { request as httpRequest } from 'node:http'
import type { TLSSocket } from 'node:tls'
import { classifyHttpStatus, classifyProbeFailure, type ProbeOutcome } from '@bevora-ops/shared'

/**
 * What the external probe found for one hostname, reached the way a real
 * visitor reaches it: public DNS, the real reverse proxy, real TLS.
 *
 * Contrast with `agent/src/probe.ts`'s on-box probe, which dials
 * `127.0.0.1:<published port>` directly and never touches DNS, TLS, or the
 * proxy at all. The two axes are deliberately built on different transports
 * (this one on `node:https`, that one on `node:http`) specifically so they
 * CAN disagree -- spec §3's whole table, and in particular its second row
 * ("the application is fine; DNS, routing, firewall or certificate is
 * broken"), is unreachable if both axes measure the same path.
 */
export type ExternalResult = {
  hostname: string
  outcome: ProbeOutcome
  status: number | null
  certExpiresAt: Date | null
}

/**
 * Which transport `probeExternally` asks the real request function to use
 * for one hostname -- see that function's own docstring, and Task 9's
 * report, for why this exists at all: a vhost deliberately served over
 * plain HTTP (`listensTls === false`) must be reached over PLAIN HTTP, not
 * TLS. Dialling it over TLS anyway does not fail safely -- whichever
 * server block actually owns port 443 (a different hostname's, possibly a
 * different TENANT's, on a multi-tenant host) answers instead, and the
 * external axis then records `answering` for a hostname it never actually
 * reached. That is a false GREEN, not a false red, and it is silent: the
 * board would show this system healthy on the strength of a different
 * system's response.
 */
export type ExternalScheme = 'http' | 'https'

/**
 * The external probe's transport contract, injected so `probeExternally`
 * can be tested with no network and no real TLS at all. The real
 * implementation is `httpsExternalRequest` below; production wires it in
 * directly (it satisfies this narrower shape -- see its own docstring for
 * why it takes a third `overrides` parameter this type has no equivalent
 * of).
 *
 * `status` and `certExpiresAt` travel together, resolved by the SAME
 * handshake, on purpose: they are not two independently observable facts.
 * If the handshake never completes, there is no status and no certificate
 * either, which is exactly what a rejected promise (see `probeExternally`)
 * represents -- there is no shape in which a caller could report a
 * certificate expiry without a status, or vice versa, because both come
 * from the one TLS connection this type models.
 *
 * `scheme` is the THIRD parameter, deliberately after `signal` rather than
 * between `hostname` and `signal`: every existing caller (this file's own
 * tests, `external-probe-runner.ts`) already destructures this function's
 * first two parameters positionally as `(hostname, signal)`, and JavaScript
 * lets an implementation declare fewer parameters than its type allows --
 * appending `scheme` here means every one of those callers keeps compiling
 * and behaving exactly as before (defaulting, via `probeExternally`, to
 * `https`) with no edit required, while a caller that DOES care can read it.
 */
export type ExternalDeps = {
  request(
    hostname: string,
    signal: AbortSignal,
    scheme: ExternalScheme,
  ): Promise<{ status: number; certExpiresAt: Date | null }>
  timeoutMs?: number
}

export const DEFAULT_EXTERNAL_TIMEOUT_MS = 10_000

/**
 * The finite set of certificate-verification failures a real TLS handshake
 * can raise, so a certificate problem is reported as `tls-failed` --
 * spec's rule that "a certificate problem is a different repair from a
 * dead application" -- rather than folded into `not-answering` as an
 * ordinary network failure.
 *
 * This is deliberately NOT `code.startsWith('ERR_TLS_')`. That prefix test
 * is both too broad and too narrow, reproduced against real listeners in
 * `external-probe.test.ts`:
 *
 *   - too broad: `ERR_TLS_HANDSHAKE_TIMEOUT` is a stalled connection, not a
 *     bad certificate, and belongs in `not-answering` with every other
 *     timeout -- a prefix match would misfile it as a certificate problem.
 *   - too narrow: the certificate errors a real invalid certificate
 *     actually raises mostly do NOT start with `ERR_TLS_` at all. Measured
 *     against real self-signed, expired, and mismatched-hostname
 *     certificates on Node 22:
 *       - a self-signed certificate  -> code `DEPTH_ZERO_SELF_SIGNED_CERT`
 *       - an expired certificate     -> code `CERT_HAS_EXPIRED`
 *       - a hostname/cert mismatch   -> code `ERR_TLS_CERT_ALTNAME_INVALID`
 *     Only the last of those three carries the `ERR_TLS_` prefix; a
 *     prefix-only check would have reported the other two as a dead
 *     application instead of a certificate fault -- the exact confusion
 *     rule 4 exists to prevent.
 *
 * The rest of this set is OpenSSL's own X.509 verify-error vocabulary
 * (`X509_V_ERR_*`, minus that prefix), which Node forwards verbatim as
 * `err.code` for every other way a certificate can fail verification --
 * untrusted issuer, revoked, not yet valid, a broken chain, and so on. It
 * is finite and stable (it is OpenSSL's own, long-published enum), so
 * enumerating it here is precise rather than guesswork.
 */
const TLS_CERT_ERROR_CODES = new Set<string>([
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_CRL',
  'UNABLE_TO_DECRYPT_CERT_SIGNATURE',
  'UNABLE_TO_DECRYPT_CRL_SIGNATURE',
  'UNABLE_TO_DECODE_ISSUER_PUBLIC_KEY',
  'CERT_SIGNATURE_FAILURE',
  'CRL_SIGNATURE_FAILURE',
  'CERT_NOT_YET_VALID',
  'CERT_HAS_EXPIRED',
  'CRL_NOT_YET_VALID',
  'CRL_HAS_EXPIRED',
  'ERROR_IN_CERT_NOT_BEFORE_FIELD',
  'ERROR_IN_CERT_NOT_AFTER_FIELD',
  'ERROR_IN_CRL_LAST_UPDATE_FIELD',
  'ERROR_IN_CRL_NEXT_UPDATE_FIELD',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'CERT_CHAIN_TOO_LONG',
  'CERT_REVOKED',
  'INVALID_CA',
  'PATH_LENGTH_EXCEEDED',
  'INVALID_PURPOSE',
  'CERT_UNTRUSTED',
  'CERT_REJECTED',
  'HOSTNAME_MISMATCH',
])

function isTlsError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null | undefined)?.code
  return typeof code === 'string' && TLS_CERT_ERROR_CODES.has(code)
}

/**
 * Probes one hostname the way a real visitor reaches it: real DNS, real
 * routing through the reverse proxy, real TLS. Certificate expiry is
 * whatever THIS handshake presented (see `httpsExternalRequest`), never a
 * value read from a certificate file on disk -- a file says what SHOULD be
 * served, the handshake says what IS, and they differ exactly when a
 * renewed certificate was never reloaded into the proxy. This estate has
 * already had that outage (spec §6).
 *
 * Deliberately a different transport contract from the on-box probe
 * (`agent/src/probe.ts`'s `probeHostnameOnBox`/`OnBoxRequestLike`): that
 * axis dials a loopback port directly by IP and never resolves a name,
 * negotiates TLS, or passes through the proxy. Reusing that transport here
 * -- or reusing THIS one there -- would make both axes measure the same
 * path, and spec §3's whole reason for running two probes is that they can
 * disagree. That disagreement is the entire diagnostic value of this
 * design; a single merged probe could never produce it.
 *
 * NEVER throws. A probe is a diagnostic; a failure in it is a datum, not
 * an error to propagate to a caller that is, in production, walking every
 * hostname on the monitored host.
 *
 * Bounded in time by this function's OWN `AbortController`, never trusted
 * to `deps.request`'s implementation, so a hostname that accepts a TCP (and
 * even a TLS) connection and then simply never answers cannot hold this
 * one probe open indefinitely. A per-probe bound is necessary but, on a
 * host with 42 hostnames, not sufficient on its own -- see
 * task-6-report.md's answer to "where does the timeout live": the caller
 * that eventually schedules these (Task 9) must also run them concurrently
 * rather than in a sequential loop, or 42 individually-bounded probes still
 * sum to a slow cycle.
 *
 * `listensTls` -- Task 5's config-time fact about THIS hostname
 * (`HostnameConfig.listensTls`, nullable) -- decides the SCHEME this probe
 * dials, not whether it dials at all:
 *
 *   - `false` (the agent positively confirmed no TLS server block) -> plain
 *     HTTP. This is the substantive half of the fix Task 8 deferred: dialling
 *     TLS anyway for a deliberately-plain-HTTP vhost either fails permanently
 *     against a certificate that was never meant to exist (a false RED for a
 *     working application), or -- worse, and silent -- lands on whichever
 *     server block actually answers port 443 on that host, which can be a
 *     different hostname or tenant entirely, recording `answering` for a
 *     hostname this probe never truly reached (a false GREEN on someone
 *     else's response).
 *   - `true` or `null` (confirmed TLS, or undetermined this tick) -> HTTPS,
 *     the existing, safe default. An undetermined reading must not be
 *     treated as "confirmed plain HTTP" -- that would be inventing the exact
 *     positive fact `listensTls: null` says nobody has established yet.
 *
 * Defaults to `null` so every existing caller that has no opinion (this
 * file's own tests, anything written before this parameter existed) keeps
 * probing over HTTPS exactly as it always has.
 */
export async function probeExternally(
  hostname: string,
  deps: ExternalDeps,
  listensTls: boolean | null = null,
): Promise<ExternalResult> {
  const scheme: ExternalScheme = listensTls === false ? 'http' : 'https'
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? DEFAULT_EXTERNAL_TIMEOUT_MS)
  try {
    const { status, certExpiresAt } = await deps.request(hostname, controller.signal, scheme)
    return { hostname, outcome: classifyHttpStatus(status), status, certExpiresAt }
  } catch (err) {
    return {
      hostname,
      outcome: classifyProbeFailure(isTlsError(err) ? 'tls' : 'network'),
      status: null,
      // No expiry is reported when no handshake completed, or when the
      // handshake is the very thing that failed. Reporting a remembered or
      // inferred value here would let an expired or misconfigured
      // certificate read as healthy for as long as the memory lasted --
      // rule 2: never report an expiry this probe did not itself observe.
      certExpiresAt: null,
    }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Overrides `httpsExternalRequest` accepts beyond the plain `(hostname,
 * signal)` pair. Unlike the name this type used to carry, `scheme` is NOT
 * test-only -- it is Task 9's real production input (see `probeExternally`'s
 * `listensTls` parameter above), threaded through by the scheduler's own
 * `ExternalDeps.request` on every live probe. `port` and `ca` remain exactly
 * what they always were: test-only, so a test can point this function at an
 * ephemeral local listener and trust a test-only self-signed certificate,
 * instead of the real internet on the scheme's default port under the
 * system's real trust store. Production's one call site (Task 9's
 * `probe-scheduler.ts`) sets `scheme` and never sets `port` or `ca`, so every
 * live probe runs on the scheme's real default port, under Node's default
 * trust store, the same as any real browser.
 */
export type ExternalRequestOverrides = {
  /** `'https'` (the default, matching this function's historical behaviour
   * when omitted) or `'http'` -- see `ExternalScheme` and `probeExternally`'s
   * `listensTls` parameter for why a plain-HTTP vhost must be reached this
   * way and not by attempting -- and failing, or worse, silently
   * mis-landing on -- a TLS handshake it was never configured to answer. */
  scheme?: ExternalScheme
  /** Test-only. Defaults to the scheme's real port (443 for https, 80 for
   * http) -- never set by the one production call site. */
  port?: number
  /** Test-only, and meaningful only when `scheme` is `'https'`: a plain HTTP
   * request has no TLS handshake and therefore nothing for a trusted CA to
   * verify. Never set by the one production call site. */
  ca?: string | Buffer | Array<string | Buffer>
}

/**
 * The real external transport: a genuine DNS resolution and one HTTP
 * request against the given hostname, over `node:https` (the default, and
 * the only scheme this function had before Task 9) or `node:http` when
 * `overrides.scheme` is `'http'` -- see `ExternalScheme` and
 * `probeExternally`'s `listensTls` parameter for why the CALLER, never this
 * function, decides which.
 *
 * Certificate expiry is read from `res.socket.getPeerCertificate()` -- the
 * TLS socket THIS request just negotiated -- never from a file, a cache,
 * or a prior observation. If the handshake fails, this promise REJECTS
 * before any certificate is ever read; `probeExternally` above is what
 * turns that rejection into `certExpiresAt: null`, this function never
 * invents a fallback value of its own. Under the `http` scheme there is no
 * TLS socket to negotiate at all, so `certExpiresAt` is unconditionally
 * `null` -- not a gap in this function, but the correct fact: a plain-HTTP
 * request has no certificate to report, ever.
 *
 * No redirect is ever followed, on either scheme. `node:https.request` and
 * `node:http.request` both have no concept of following one in the first
 * place (unlike `fetch`), so a 3xx is simply returned as the status it is --
 * not a workaround, simply what this transport does by construction. This
 * matches spec §5's explicit rule for the whole design ("one request per
 * hostname, no chasing a redirect off the host"), and it is also the right
 * call specifically for THIS probe: an apex-to-www or HTTP-to-HTTPS redirect
 * is frequently the entire point of a hostname's configuration, and
 * following it would silently start probing a different hostname than the
 * one this result claims to describe, filing that hostname's evidence under
 * the wrong name.
 *
 * `overrides` is described on `ExternalRequestOverrides` above -- `scheme`
 * is real production input; `port`/`ca` remain test-only, never passed at
 * the real call site.
 */
export function httpsExternalRequest(
  hostname: string,
  signal: AbortSignal,
  overrides: ExternalRequestOverrides = {},
): Promise<{ status: number; certExpiresAt: Date | null }> {
  const scheme = overrides.scheme ?? 'https'

  // Two full branches, deliberately, rather than one shared options object
  // fed to a chosen `requestFn`: `http.request`'s options type has no `ca`
  // key at all, so building one shared literal that could carry it (even
  // conditionally) would either widen the http branch's options to accept a
  // key it can never use, or need an `as` cast to force the two SDKs'
  // incompatible `RequestOptions` shapes together -- this repo's own rule
  // against `any`/`@ts-ignore` reads the same way for a cast that exists
  // only to paper over a type mismatch the two branches don't actually
  // share. The response handler below (reading the socket, resolving,
  // `res.resume()`) still cannot usefully be factored out either: an
  // `http.IncomingMessage`'s `.socket` is a plain `net.Socket` with no
  // `getPeerCertificate`, so the shared `typeof socket.getPeerCertificate
  // === 'function'` guard already does the right thing (falls through to
  // `certExpiresAt: null`) without needing a second code path -- it is only
  // the REQUEST construction that has to branch.
  if (scheme === 'http') {
    return new Promise((resolve, reject) => {
      const req = httpRequest(
        {
          host: hostname,
          port: overrides.port ?? 80,
          path: '/',
          method: 'GET',
          headers: {
            'User-Agent': 'bevora-ops-external-probe/1',
          },
          signal,
        },
        (res) => {
          resolve({ status: res.statusCode ?? 0, certExpiresAt: null })
          res.resume()
        },
      )
      req.on('error', reject)
      req.end()
    })
  }

  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      {
        host: hostname,
        port: overrides.port ?? 443,
        path: '/',
        method: 'GET',
        headers: {
          'User-Agent': 'bevora-ops-external-probe/1',
        },
        signal,
        // Omitted entirely (not present-with-undefined) when no test
        // override is given, so `exactOptionalPropertyTypes` is satisfied
        // and a real probe's `RequestOptions` carries no `ca` key at all --
        // Node's own default trust store governs every live request.
        ...(overrides.ca !== undefined ? { ca: overrides.ca } : {}),
      },
      (res) => {
        const socket = res.socket as TLSSocket
        const cert = typeof socket.getPeerCertificate === 'function' ? socket.getPeerCertificate() : undefined
        const certExpiresAt = cert?.valid_to ? new Date(cert.valid_to) : null
        resolve({ status: res.statusCode ?? 0, certExpiresAt })
        res.resume()
      },
    )
    req.on('error', reject)
    req.end()
  })
}
