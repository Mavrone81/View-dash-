import { enrolAgent, revokeAgent } from './auth-agent.js'
import { prisma } from '../lib/db.js'

export const USAGE = [
  'usage:',
  '  node enrol-cli.mjs <host-name>            enrol a host and mint its token (revokes any previous one)',
  '  node enrol-cli.mjs --revoke <host-name>   revoke this host\'s token, minting nothing',
].join('\n')

const REVOKE_FLAG = '--revoke'

/**
 * Operator entrypoint for minting an agent token, per `enrolAgent`'s own
 * contract (see auth-agent.ts): the raw token is returned to the caller
 * EXACTLY ONCE and only its hash is ever persisted. There is no "show it
 * again" command -- if this output is lost, the fix is to run this again
 * (which also revokes the host's previous token; see enrolAgent) and
 * install the new one, never to go looking for the old one anywhere.
 *
 * This is a standalone script, bundled by `npm run build:enrol` into
 * web/dist/enrol-cli.mjs, and run the same way `deploy/README.md`
 * documents: inside the `web` container (or any container built from the
 * same image), with `DATABASE_URL` already set by
 * `deploy/with-database-url.sh` -- see that script and the
 * docker-compose.yml comment on the `web` service for the mechanism.
 *
 * `argv`/`out` are injectable (defaulting to the real `process.argv` and
 * `console`) so `enrol-cli.test.ts` can exercise this directly -- calling
 * `main()`, rather than only ever spawning this file as a subprocess --
 * without capturing real stdout/stderr streams. Returns the process exit
 * code rather than setting `process.exitCode` itself, for the same
 * reason: a test asserts on a return value, not a process-global side
 * effect. The `import.meta.url` guard at the bottom (the same pattern
 * `web/src/server/ingest-server.ts` uses) is what keeps this from running
 * itself the instant a test file imports it.
 */
export async function main(
  argv: readonly string[] = process.argv,
  out: { log: (s: string) => void; error: (s: string) => void } = console,
): Promise<number> {
  // Decommissioning a host. `revokeAgent` was implemented and tested from
  // the start but had NO operator-facing entry point, which meant the only
  // way to invalidate a host's credential was to re-enrol it -- i.e. to
  // mint a replacement token for a machine you are trying to take away.
  // This is that entry point.
  if (argv[2] === REVOKE_FLAG) {
    const hostName = argv[3]
    if (!hostName) {
      out.error(USAGE)
      return 1
    }
    // Checked explicitly rather than relying on `revokeAgent`'s silent
    // no-op for an unknown host. `revokeAgent` is deliberately idempotent
    // so that re-running it is safe -- but an operator who MISTYPES a host
    // name must not be told "revoked" about a machine that was never
    // touched. Believing a credential is dead when it is still live is the
    // one outcome this command must never produce.
    const host = await prisma.host.findUnique({ where: { name: hostName } })
    if (!host) {
      out.error(`no such host: ${hostName} -- nothing was revoked`)
      return 1
    }
    // Still a no-op-and-succeed for a host whose tokens are ALREADY
    // revoked: that is the case idempotency is actually for (a first
    // attempt whose output was lost), and failing it would push an
    // operator toward re-enrolling instead.
    await revokeAgent(hostName)
    out.error(`revoked every active enrolment for host: ${hostName} (id: ${host.id})`)
    out.error('that host\'s agent can no longer report; its rows will go stale, then unknown.')
    return 0
  }

  const hostName = argv[2]
  if (!hostName) {
    out.error(USAGE)
    return 1
  }
  const { token, hostId } = await enrolAgent(hostName)
  // Everything EXCEPT the token itself goes through the ordinary log --
  // the token is written straight to stdout on its own line, once, so a
  // human piping this into a file (or their password manager) captures
  // exactly the bytes to write to AGENT_TOKEN_FILE and nothing else.
  out.error(`enrolled host: ${hostName} (id: ${hostId})`)
  out.error('token below -- shown ONCE, never recoverable. Copy it now:')
  out.log(token)
  return 0
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main()
    .then((code) => {
      process.exitCode = code
    })
    .catch((err: unknown) => {
      console.error('enrolment failed:', err)
      process.exitCode = 1
    })
    .finally(() => {
      void prisma.$disconnect()
    })
}
