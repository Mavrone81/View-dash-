/**
 * Derives which hostnames serve which system, by reading the host's
 * reverse-proxy configuration rather than a maintained list.
 *
 * A maintained list is why slice 1's probe never ran: the code shipped, the
 * configuration to feed it never did. Derivation means a new stack is
 * probed the day it deploys, with nobody editing anything -- which is the
 * property the operator asked for when they said this must stay "robust and
 * expendable".
 *
 * The chain is: server_name -> proxy_pass loopback port -> published
 * container port -> compose project. This module owns the first two links.
 */

export type VhostEntry = {
  hostnames: string[]
  upstreamPort: number | null
  listensTls: boolean
}

// `_` is nginx's catch-all: it names no system and must never become a
// probe target.
const CATCH_ALL = '_'

/**
 * Strips nginx comments -- from an unquoted `#` to end of line -- before any
 * other parsing runs. Commenting a directive out instead of deleting it is a
 * common habit, and two live directives on the monitored host are exactly
 * that; without this, a disabled `server_name` or `proxy_pass` line reads as
 * live configuration.
 *
 * "Unquoted" is tracked per line because an nginx string value can contain a
 * literal `#` (e.g. `add_header X "a#b";`); only a `#` outside any quote
 * starts a comment.
 */
function stripComments(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      let inSingle = false
      let inDouble = false
      for (let i = 0; i < line.length; i++) {
        const ch = line[i]
        if (ch === "'" && !inDouble) inSingle = !inSingle
        else if (ch === '"' && !inSingle) inDouble = !inDouble
        else if (ch === '#' && !inSingle && !inDouble) return line.slice(0, i)
      }
      return line
    })
    .join('\n')
}

/**
 * Given the index just past an opening `{`, returns the body up to its
 * matching `}` (found by counting brace depth, not by a `[^}]*` regex) and
 * the index just past that closing brace. Shared by `extractLocations` and
 * `extractServerBlocks`, whose bodies can each contain their own nested
 * `{ }` -- an `if` or a second `location` inside a location, a second
 * `server` block inside a file -- that a non-greedy match would stop at
 * prematurely.
 */
function balancedBody(text: string, bodyStart: number): { body: string; end: number } {
  let depth = 1
  let i = bodyStart
  while (i < text.length && depth > 0) {
    if (text[i] === '{') depth++
    else if (text[i] === '}') depth--
    i++
  }
  return { body: text.slice(bodyStart, i - 1), end: i }
}

/** Extracts every `location <selector> { ... }` block from a server block's text. */
function extractLocations(text: string): Array<{ selector: string; body: string }> {
  const out: Array<{ selector: string; body: string }> = []
  const re = /location\s+([^{]+?)\s*\{/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const selector = (m[1] ?? '').trim()
    const { body, end } = balancedBody(text, re.lastIndex)
    out.push({ selector, body })
    re.lastIndex = end
  }
  return out
}

/**
 * Extracts the interior of every top-level `server { ... }` block from a
 * config file's text.
 *
 * A file is not the unit of parsing -- a server block is. 26 of 28 files on
 * the live host contain more than one `server {` block (most commonly a
 * bare port-80 redirect paired with the real TLS block), and 3 of those
 * files declare a root location in each of two different blocks. Scanning
 * a whole file as though it were one block -- as this module used to --
 * takes the first root location found anywhere in the file and attaches
 * every hostname in the file to it, including hostnames declared in a
 * different block for a different backend. That is the same defect class
 * as taking the first `proxy_pass` instead of the root location's: a
 * hostname bound to a backend that does not serve it, so the board reports
 * a system as answering because a different system's app replied.
 *
 * `\bserver\s*\{` will not match `server_name` (no `{` follows) or a
 * `server 127.0.0.1:PORT;` line inside an `upstream` block (a digit, not
 * `{`, follows), so only genuine server blocks are found.
 */
function extractServerBlocks(text: string): string[] {
  const out: string[] = []
  const re = /\bserver\s*\{/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const { body, end } = balancedBody(text, re.lastIndex)
    out.push(body)
    re.lastIndex = end
  }
  return out
}

const PROXY_PASS = /proxy_pass\s+https?:\/\/([^:/\s;]+)(?::(\d+))?/

/**
 * Resolves a single proxy_pass target to a loopback port.
 *
 * A target of `127.0.0.1:<port>` resolves directly. A bare name
 * (`proxy_pass http://backend;`) is a reference to a named `upstream` block
 * declared elsewhere; it resolves only if that block was found and put into
 * `upstreams`, and reports null -- never a guess -- if it was not.
 */
function resolveProxyPort(body: string, upstreams: ReadonlyMap<string, number>): number | null {
  const m = body.match(PROXY_PASS)
  if (!m) return null
  const host = m[1] ?? ''
  const explicitPort = m[2]
  if (host === '127.0.0.1' && explicitPort !== undefined) return Number(explicitPort)
  return upstreams.get(host) ?? null
}

/**
 * Collects `upstream NAME { server 127.0.0.1:PORT; ... }` declarations from
 * a set of config files.
 *
 * These commonly live in a file separate from the vhost that references
 * them by name (a shared upstreams.conf is the usual layout), so this runs
 * as its own pass over every file before any vhost is parsed -- see
 * `discoverHostnamesByPort`, which is the only caller that can see all the
 * files at once.
 *
 * Only the first loopback `server` line in a block is used: a pool fronting
 * more than one instance on one host is not this module's problem to solve,
 * it just needs one reachable member to probe.
 *
 * If the same upstream name is declared more than once across the provided
 * files, the LAST declaration processed wins (plain `Map.set` semantics) --
 * a deliberate, if arbitrary, choice: real nginx treats a duplicate
 * `upstream` name as a config error and refuses to reload at all, so this
 * situation should not exist on a live, currently-loaded config. The rule
 * exists only so behaviour on a stale or mid-edit file is deterministic
 * rather than order-dependent-by-accident.
 *
 * `[^}]*` (not brace-balanced, unlike `extractLocations` /
 * `extractServerBlocks` above) is safe here because nginx's `upstream { }`
 * grammar cannot itself contain a nested block -- only directives like
 * `server`, `keepalive`, `least_conn;` -- so there is no inner `}` for a
 * non-greedy match to stop at prematurely.
 */
export function parseUpstreams(files: Array<{ text: string }>): Map<string, number> {
  const upstreams = new Map<string, number>()
  for (const f of files) {
    const text = stripComments(f.text)
    for (const m of text.matchAll(/upstream\s+([^\s{]+)\s*\{([^}]*)\}/g)) {
      const name = m[1]
      const body = m[2] ?? ''
      const server = body.match(/server\s+127\.0\.0\.1:(\d+)/)
      if (name && server?.[1] !== undefined) upstreams.set(name, Number(server[1]))
    }
  }
  return upstreams
}

/** The shared parsing logic for one already-isolated server block's interior text. */
function parseBlockEntry(clean: string, upstreams: ReadonlyMap<string, number>): VhostEntry {
  const hostnames: string[] = []
  for (const m of clean.matchAll(/server_name\s+([^;]+);/g)) {
    for (const name of (m[1] ?? '').trim().split(/\s+/)) {
      if (name && name !== CATCH_ALL && name.includes('.')) hostnames.push(name)
    }
  }

  // A hostname is only honestly answered for by the port its ROOT location
  // proxies to: a probe hits `https://host/`, nothing else. Six vhosts on
  // the live host proxy to more than one port, and in every one of them the
  // FIRST proxy_pass in the block is not the one root ("/") uses -- so
  // taking the first (as this module used to) would attach a hostname to
  // the wrong backend, which is worse than attaching it to none: the board
  // would show a false green because a *different* system answered instead.
  // A server block with no root location at all proxies nothing a plain
  // probe can reach, which is the same faithful null as a vhost with no
  // proxy_pass -- there is no fallback to the first location either.
  const root = extractLocations(clean).find((loc) => loc.selector === '/')
  const upstreamPort = root ? resolveProxyPort(root.body, upstreams) : null

  const tls = /listen[^;]*\b443\b/.test(clean) || /listen[^;]*\bssl\b/.test(clean)

  return { hostnames, upstreamPort, listensTls: tls }
}

/**
 * Parses ONE server block's text (the interior, or the whole `server { ... }`
 * wrapper -- either works, since none of the regexes above care about the
 * outer braces).
 *
 * `upstreams` has no default: an omitted argument is invisible at the call
 * site, and a caller who forgets it would see every named-upstream vhost
 * silently resolve to `upstreamPort: null` -- the same shape as a genuinely
 * dead vhost, with nothing to distinguish the two. Requiring the argument
 * forces every call site to make that decision visibly, even when the
 * answer is "no upstreams exist here, pass an empty map."
 *
 * For text that may contain MORE THAN ONE server block, use
 * `parseServerBlocks` instead -- see its docstring for why the file is not
 * a safe unit to hand to this function.
 */
export function parseVhost(text: string, upstreams: ReadonlyMap<string, number>): VhostEntry {
  return parseBlockEntry(stripComments(text), upstreams)
}

/**
 * Parses every server block in a config file's text independently, so that
 * `server_name`, `listen` and the root location found in one block can
 * never be associated with another block's -- see `extractServerBlocks` for
 * why the file as a whole is not a safe parsing unit.
 */
export function parseServerBlocks(text: string, upstreams: ReadonlyMap<string, number>): VhostEntry[] {
  const clean = stripComments(text)
  return extractServerBlocks(clean).map((block) => parseBlockEntry(block, upstreams))
}

export function discoverHostnamesByPort(files: Array<{ text: string }>): Map<number, string[]> {
  // Two passes over the same file list: upstream blocks may be declared in
  // a different file than the vhost that references them by name, so every
  // upstream on the host must be known before any vhost's proxy_pass is
  // resolved.
  const upstreams = parseUpstreams(files)
  const byPort = new Map<number, string[]>()
  for (const f of files) {
    for (const v of parseServerBlocks(f.text, upstreams)) {
      // A vhost with no resolvable upstream is real and worth reporting
      // elsewhere, but it maps to no system, so it contributes nothing here
      // rather than being guessed onto one.
      if (v.upstreamPort === null || v.hostnames.length === 0) continue
      const existing = byPort.get(v.upstreamPort) ?? []
      byPort.set(v.upstreamPort, [...existing, ...v.hostnames])
    }
  }
  return byPort
}
