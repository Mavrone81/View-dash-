import { enrolAgent } from './auth-agent.js'
import { prisma } from '../lib/db.js'

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
 */
async function main(): Promise<void> {
  const hostName = process.argv[2]
  if (!hostName) {
    console.error('usage: node enrol-cli.mjs <host-name>')
    process.exitCode = 1
    return
  }
  const { token, hostId } = await enrolAgent(hostName)
  // Everything EXCEPT the token itself goes through the ordinary log --
  // the token is written straight to stdout on its own line, once, so a
  // human piping this into a file (or their password manager) captures
  // exactly the bytes to write to AGENT_TOKEN_FILE and nothing else.
  console.error(`enrolled host: ${hostName} (id: ${hostId})`)
  console.error('token below -- shown ONCE, never recoverable. Copy it now:')
  console.log(token)
}

main()
  .catch((err: unknown) => {
    console.error('enrolment failed:', err)
    process.exitCode = 1
  })
  .finally(() => {
    void prisma.$disconnect()
  })
