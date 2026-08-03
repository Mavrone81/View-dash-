import { join } from 'node:path'
import { readdir as fsReaddir, readFile as fsReadFile } from 'node:fs/promises'

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
  /**
   * Whether this server block listens for TLS (`listen 443` or `listen
   * ... ssl`).
   *
   * Was produced here and consumed by nothing through fix round 2 -- the
   * on-box probe never touches TLS or a scheme at all (see
   * `agent/src/probe.ts`'s `probeHostnameOnBox`), so nothing in this tree
   * read it. Task 5 closed that: `discoverTlsByHostname` (below) reads it
   * off every parsed block and carries it onto `SystemState.hostnames` in
   * `shared/src/wire.ts` (`HostnameConfigSchema.listensTls`), because spec
   * §8 requires "No certificate where TLS is configured without one" and
   * §7's finding of three such hostnames depends on exactly this bit
   * reaching the board (Task 8) somehow. This field itself still has no
   * DIRECT consumer -- `discoverTlsByHostname` reads it while iterating
   * `parseServerBlocks`' output, not by name from outside this module --
   * but the fact it carries is no longer orphaned.
   */
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
 *
 * QUOTE-AWARENESS: a directive value can carry a literal, UNBALANCED brace
 * inside a quoted string (e.g. `add_header X-Test "{oops";`), and counting
 * that brace as structural makes the depth run one level short -- the
 * scanner then consumes the *next* `server { }` block's own closing brace
 * to rebalance, silently merging two blocks into one. `server_name`
 * matching then sees both blocks' hostnames in a single blob and the first
 * `location /` wins, so the second block's hostname gets attributed to the
 * first block's port -- the exact cross-block mis-attribution the
 * server-block split exists to prevent, reopened through a brace hidden
 * inside a string instead of a missing split. A brace inside an open quote
 * is therefore never counted.
 *
 * This tracks quotes the same way `stripComments` does, but NOT with the
 * same scope: `stripComments` resets `inSingle`/`inDouble` at every line
 * break (it operates line by line), while this function carries quote
 * state continuously across the whole text with no per-line reset. An
 * nginx quoted value CAN legitimately span multiple lines, so
 * `stripComments` can wrongly delete a continuation line that happens to
 * contain a `#` inside that still-open quote. That gap is not reachable
 * through anything this module actually reads -- `server_name`,
 * `proxy_pass` and `listen` are always single-line directives -- so it is
 * not a live bug, but the two functions are not equivalent and a future
 * directive spanning lines could expose the difference.
 *
 * Neither this function nor `stripComments` handles a backslash-escaped
 * quote (`\"`) inside a quoted value -- both would treat it as closing the
 * string early. Pre-existing, shared identically by both (so they can't
 * disagree with each other about where a string ends), and not reachable
 * by any directive this module parses. Noted rather than fixed: nginx
 * directive values that need this are rare, and adding escape-handling to
 * one function without the other would make them inconsistent instead of
 * both simply incomplete in the same way.
 *
 * FAIL-CLOSED ON MALFORMED INPUT: an unterminated `server`/`location`
 * block missing its final `}` makes the loop run to the end of `text` with
 * `depth` still above 0. `complete: false` signals exactly that case, and
 * every caller below drops the block rather than trusting the body the
 * slice would otherwise produce.
 *
 * This used to be treated as unreachable, on the reasoning that a config
 * the host is actually running was necessarily accepted by nginx, which
 * itself refuses to (re)load an unbalanced file. That reasoning does not
 * hold for what THIS module reads: `readVhostDir` pulls raw files off disk
 * on the collector's own poll cycle, with no relationship to nginx's
 * validated in-memory state. A file mid-save by a human editor, or
 * mid-write by a deploy step, can sit on disk transiently unbalanced at
 * the exact instant the collector scans it, before `nginx -t` has ever
 * seen that content -- a real caller today, not a hypothetical future one.
 * Silently returning a truncated body in that case reproduces the same
 * cross-block mis-attribution as the quote bug above, arriving via a race
 * instead of a hidden brace: an unterminated block swallows whatever
 * follows it, and a hostname from a LATER, well-formed block can land on
 * the truncated block's (wrong, or entirely fictitious) port.
 */
function balancedBody(text: string, bodyStart: number): { body: string; end: number; complete: boolean } {
  let depth = 1
  let i = bodyStart
  let inSingle = false
  let inDouble = false
  while (i < text.length && depth > 0) {
    const ch = text[i]
    if (ch === "'" && !inDouble) inSingle = !inSingle
    else if (ch === '"' && !inSingle) inDouble = !inDouble
    else if (!inSingle && !inDouble) {
      if (ch === '{') depth++
      else if (ch === '}') depth--
    }
    i++
  }
  return { body: text.slice(bodyStart, i - 1), end: i, complete: depth === 0 }
}

/**
 * Extracts every `location <selector> { ... }` block from a server block's
 * text.
 *
 * A location whose body is unterminated (see `balancedBody`'s
 * FAIL-CLOSED note) is dropped rather than returned with a truncated body:
 * it contributes no entry, so `.find((loc) => loc.selector === '/')` in
 * `parseBlockEntry` cannot find it and resolves the same `upstreamPort:
 * null` as a server block that never declared a root location at all. See
 * the comment on that lookup for why this collapse is accepted rather than
 * distinguished.
 */
function extractLocations(text: string): Array<{ selector: string; body: string }> {
  const out: Array<{ selector: string; body: string }> = []
  const re = /location\s+([^{]+?)\s*\{/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const selector = (m[1] ?? '').trim()
    const { body, end, complete } = balancedBody(text, re.lastIndex)
    if (complete) out.push({ selector, body })
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
    const { body, end, complete } = balancedBody(text, re.lastIndex)
    // An unterminated block (see balancedBody's FAIL-CLOSED note) is
    // dropped, not returned truncated: it contributes no VhostEntry at
    // all, which is unambiguous at this layer -- there is no "entry that
    // means unparseable" to confuse with a real one, only an absent one.
    // `end` is always text.length here (the scan ran out of text without
    // closing), so no further match can be found in this text either way.
    if (complete) out.push(body)
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
  //
  // `loc.selector === '/'` matches only a PLAIN root declaration
  // (`location / { ... }`). A modifier form -- `location = /`,
  // `location ~ /`, `location ^~ /` -- captures as `'= /'`, `'~ /'`,
  // `'^~ /'` etc., none of which equals `'/'`, so a root declared with a
  // modifier is silently read as "no root location" and reports null, the
  // same as a genuinely rootless vhost. Measured live: 29 `location /`
  // declarations, zero of any modifier form, and none among the six
  // multi-port vhosts that made the root-vs-first distinction matter in
  // the first place -- inert today, and silently wrong the day someone
  // adds one. Recorded here rather than only in the slice's design doc,
  // because a report nobody opens does not stop a modifier from shipping.
  //
  // `VhostEntry` cannot distinguish, and this lookup does not try to:
  // (a) no root location was ever declared, (b) a root location was
  // declared but its own body was unterminated and dropped by
  // `extractLocations`, and (c) a root location exists and resolves but to
  // no reachable upstream. All three collapse to `upstreamPort: null`.
  // (b) is a genuinely different situation from (a)/(c) -- it means "this
  // block's config could not be parsed," not "this block declares no
  // proxy" -- but adding a way to tell them apart would mean growing
  // `VhostEntry` for a case with no live evidence (unlike the disk-race
  // truncation this same file now fails closed on at the whole-block
  // level, which does have one). Recorded here rather than papered over.
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

/** The two filesystem calls this module needs, so a test needs no mocking of node:fs. */
export type VhostFs = {
  readdir(d: string): Promise<string[]>
  readFile(p: string): Promise<string>
}

/**
 * The production `VhostFs`, wired directly to `node:fs/promises`. This is
 * the exact object handed to `readVhostDir` on a real host -- see
 * `agent/src/agent-deps.ts` -- and it is deliberately NOT
 * `readdir(dir, { withFileTypes: true })` filtered on `dirent.isFile()`,
 * which looks like the more careful, "only list real files" version.
 *
 * `isFile()` returns false for a directory ENTRY that is itself a symlink,
 * even when the symlink's TARGET is an ordinary file -- and every enabled
 * vhost on the monitored host is a symlink into an adjacent `available`
 * directory (the standard nginx `sites-available` / `sites-enabled` split).
 * That filter would make `readdir` report zero entries, `readVhostDir`
 * would return `[]`, and that is indistinguishable from "this host
 * genuinely has no vhosts" -- the exact silent-empty-scan failure this
 * module exists to prevent, reintroduced one call deeper than the `grep -r`
 * bug it was originally written to fix.
 *
 * The plain `readdir(d)` below returns bare names with no per-entry type to
 * wrongly filter on, and `readFile` follows the symlink itself when handed
 * that name -- which is exactly what makes it correct here. See
 * `vhosts.test.ts`'s "the production VhostFs" suite, which runs this exact
 * object (not a lookalike lambda) through a real symlink.
 */
export const nodeVhostFs: VhostFs = {
  readdir: (d) => fsReaddir(d),
  readFile: (p) => fsReadFile(p, 'utf8'),
}

/**
 * Reads the text of every name in `names`, resolved against `dir`, skipping
 * (not failing on) any single one that cannot be read. Shared by
 * `readVhostDir` and `discoverHostnamesFromDir`, both of which need this
 * exact "read what you can, drop what you can't" loop after their own,
 * DIFFERENT handling of the initial `readdir`.
 */
async function readNamedFiles(dir: string, names: string[], fs: VhostFs): Promise<Array<{ text: string }>> {
  const out: Array<{ text: string }> = []
  for (const n of names) {
    try {
      out.push({ text: await fs.readFile(join(dir, n)) })
    } catch {
      // One unreadable file must not blind the scan to the rest.
    }
  }
  return out
}

/**
 * Reads every vhost file in a directory.
 *
 * `readFile` follows symlinks; this is load-bearing rather than incidental.
 * The enabled-vhost directory is entirely symlinks into an adjacent
 * directory, and a scan that does not follow them returns nothing while
 * looking exactly like a scan of a host with no vhosts. That happened
 * twice during the survey for this slice, using `grep -r`, which skips
 * symlinks where `grep -R` follows them. Do not "optimise" this by
 * filtering entries on file type or resolving links yourself -- the
 * plain, unfiltered `readFile` call below is the fix, not an accident.
 *
 * Never throws: a missing directory or an unreadable file yields fewer
 * entries, not a failed collection cycle. A probe is a diagnostic; if it
 * cannot see, it must report less, never crash the collection loop.
 *
 * This function cannot distinguish "the directory does not exist" from
 * "the directory exists and is empty" -- both return `[]`. That is a real
 * gap: a host with genuinely zero vhosts and a misconfigured probe path
 * look identical here. Whatever calls this must not treat an empty result
 * as "this system serves nothing" without also checking that the
 * directory itself is reachable -- see `discoverHostnamesFromDir` below,
 * which is the composed call that actually makes that distinction, in one
 * `readdir`, rather than this function plus a second check.
 */
export async function readVhostDir(dir: string, fs: VhostFs): Promise<Array<{ text: string }>> {
  let names: string[]
  try {
    names = await fs.readdir(dir)
  } catch {
    return []
  }
  return readNamedFiles(dir, names, fs)
}

/**
 * Composes a directory listing + file reads + `discoverHostnamesByPort`
 * into the single call `agent/src/collect.ts`'s `CollectDeps.hostnamesByPort`
 * needs -- this is the actual seam that joins vhost discovery to the
 * collection loop; see `agent/src/agent-deps.ts`.
 *
 * Returns `null`, NOT an empty `Map`, when the directory itself could not be
 * listed. Collapsing "unreadable" into "empty" here would let a
 * misconfigured or temporarily-inaccessible vhost path render as "no system
 * on this host has an HTTP surface" -- a false claim about every system on
 * the board, not merely a gap in one collection tick.
 *
 * Deliberately does ONE `readdir`, not `readVhostDir`'s own `readdir` after
 * a separate reachability check: an earlier version of this function called
 * a standalone `isVhostDirReachable` and then `readVhostDir`, which issued
 * two `readdir` syscalls with a real (if small) TOCTOU window between
 * them -- the directory could vanish or reappear between the two calls,
 * making the "reachable" answer stale by the time the second call ran.
 * Reading the names once and branching on whether THAT read succeeded
 * removes the window entirely, rather than narrowing it.
 */
export async function discoverHostnamesFromDir(dir: string, fs: VhostFs): Promise<Map<number, string[]> | null> {
  let names: string[]
  try {
    names = await fs.readdir(dir)
  } catch {
    return null
  }
  const files = await readNamedFiles(dir, names, fs)
  return discoverHostnamesByPort(files)
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

/**
 * Maps each hostname declared anywhere in the vhost config to whether ANY
 * of its server blocks listens for TLS.
 *
 * Deliberately does NOT filter on `upstreamPort` the way `discoverHostnamesByPort`
 * does: `listensTls` is a fact about the vhost DECLARATION, not about
 * whether it proxies anywhere. A vhost with NO `server_name` at all
 * contributes nothing (there is no hostname to key the map on), which is
 * the same "real and worth noting elsewhere, but not this map's problem"
 * shape `discoverHostnamesByPort` already applies to an unresolved
 * upstream.
 *
 * FIX ROUND 1's CRITICAL: this used to be last-write-wins (plain
 * `Map.set(h, v.listensTls)`), on the reasoning that it mirrored
 * `parseUpstreams`' own documented, arbitrary-but-deterministic tie-break
 * for a duplicate name. That reasoning does not transfer here.
 * `parseUpstreams` picks between two candidate PORTS, where only one can be
 * right and neither answer is worse than the other. This map answers "does
 * ANY server block for this name listen for TLS" -- a yes/no question where
 * the two inputs are not peers to arbitrate between, they are evidence to
 * combine. The live host's dominant layout (measured: 26 of 28 files, not
 * an edge case) is a bare port-80 redirect block paired with the real TLS
 * block, BOTH declaring the same `server_name` -- and last-write-wins made
 * the answer depend on file/block PROCESSING ORDER (position within a file,
 * and an unsorted `readdir` across files), which is not something this
 * function's caller controls or can rely on. A `false` produced by
 * unlucky ordering is not a harmless coin-flip: the hostname is present in
 * `byPort` via the TLS block's own `proxy_pass`, so `collect.ts`'s `?? null`
 * miss-fallback never fires -- `false` ships as a POSITIVE claim that a
 * TLS-configured hostname is plain HTTP by design, which is strictly worse
 * than a `null` gap. The same wrong answer is also reachable via a race,
 * not just static ordering: `readNamedFiles` silently skips a file it
 * cannot read, so if the TLS block's own file is mid-write while the
 * redirect file reads fine, the hostname is PRESENT with `false` for a
 * completely different reason.
 *
 * Fixed by OR-accumulating across every block that declares the hostname,
 * which is the actual semantics the question asks and is order-independent
 * by construction: once any block for a hostname sets it to `true`, no
 * later (or earlier) plain block can un-set it.
 *
 * ORPHAN TLS VHOSTS -- RECORDED HONESTLY, NOT FIXED HERE: this map is
 * deliberately unfiltered by upstream resolution (see above), so it DOES
 * collect a hostname that listens for TLS but resolves to no live backend
 * (spec §7's exact finding: on the live host, measured, 2 of the 3
 * TLS-without-certificate hostnames have no upstream at all). But nothing
 * downstream currently ENUMERATES this map's own keys -- `collect.ts` only
 * looks up a TLS bit for hostnames it already reached via `targets`
 * (derived from `discoverHostnamesByPort`'s PORT-filtered map), so an
 * orphan hostname that exists only here is looked up by nobody and never
 * reaches the wire. Collecting it here is necessary but not sufficient;
 * fix round 1's review is explicit that surfacing an orphan vhost needs a
 * HOST-LEVEL channel on the wire (it attaches to no system, so no
 * per-system field can carry it), and that this is separate, scoped-out
 * work, not something to build as part of this fix.
 */
export function discoverTlsByHostname(files: Array<{ text: string }>): Map<string, boolean> {
  const upstreams = parseUpstreams(files)
  const tlsByHostname = new Map<string, boolean>()
  for (const f of files) {
    for (const v of parseServerBlocks(f.text, upstreams)) {
      for (const h of v.hostnames) tlsByHostname.set(h, (tlsByHostname.get(h) ?? false) || v.listensTls)
    }
  }
  return tlsByHostname
}

/**
 * Composes a directory listing + file reads + `discoverTlsByHostname` into
 * the single call `agent/src/collect.ts`'s `CollectDeps.onBoxProbing.tlsByHostname`
 * needs -- the TLS-axis sibling of `discoverHostnamesFromDir` immediately
 * above, same discipline for the same reason: ONE `readdir` (no separate
 * reachability check, no TOCTOU window), `null` (never an empty `Map`) when
 * the directory itself could not be listed, because collapsing "unreadable"
 * into "found no TLS vhosts" would render every TLS-configured hostname on
 * this host as plain HTTP -- the exact false claim spec §8 exists to catch,
 * reappearing one axis over.
 *
 * A separate directory read from `discoverHostnamesFromDir`'s, not a shared
 * one: the two axes are independent facts (hostname→port vs hostname→TLS)
 * computed from the same on-disk files, and reading twice per tick trades a
 * second small `readdir` + a handful of file reads (this project's own
 * survey counted 28 files on the live host) for not perturbing
 * `discoverHostnamesFromDir`'s already-hardened, already-reviewed contract.
 * See task-5-report.md for the reasoning against consolidating them.
 */
export async function discoverTlsFromDir(dir: string, fs: VhostFs): Promise<Map<string, boolean> | null> {
  let names: string[]
  try {
    names = await fs.readdir(dir)
  } catch {
    return null
  }
  const files = await readNamedFiles(dir, names, fs)
  return discoverTlsByHostname(files)
}
