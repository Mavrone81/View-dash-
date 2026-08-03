import { describe, it, expect } from 'vitest'
import {
  parseVhost,
  parseServerBlocks,
  discoverHostnamesByPort,
  discoverTlsByHostname,
  parseUpstreams,
  readVhostDir,
  nodeVhostFs,
  discoverVhostsFromDir,
} from './vhosts.js'
import { mkdtemp, mkdir, writeFile, symlink, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const NONE = new Map<string, number>()

const VHOST = `
server {
    listen 443 ssl;
    server_name alpha.example.invalid www.alpha.example.invalid;
    location / {
        proxy_pass http://127.0.0.1:8081;
    }
}
`

describe('vhost parsing', () => {
  it('extracts every hostname and the upstream port', () => {
    const v = parseVhost(VHOST, NONE)
    expect(v.hostnames).toEqual(['alpha.example.invalid', 'www.alpha.example.invalid'])
    expect(v.upstreamPort).toBe(8081)
    expect(v.listensTls).toBe(true)
  })

  it('ignores the catch-all server_name, which names no system', () => {
    expect(parseVhost('server { server_name _; listen 80; }', NONE).hostnames).toEqual([])
  })

  it('reports a vhost that listens for TLS but proxies nowhere', () => {
    const v = parseVhost('server { listen 443 ssl; server_name beta.example.invalid; }', NONE)
    expect(v.hostnames).toEqual(['beta.example.invalid'])
    expect(v.upstreamPort).toBeNull()
    expect(v.listensTls).toBe(true)
  })

  it('groups hostnames by the port they proxy to', () => {
    const byPort = discoverHostnamesByPort([
      { text: VHOST },
      { text: 'server { server_name gamma.example.invalid; location / { proxy_pass http://127.0.0.1:9001; } }' },
      { text: 'server { server_name delta.example.invalid; location / { proxy_pass http://127.0.0.1:8081; } }' },
    ])
    expect(byPort.get(8081)).toEqual(['alpha.example.invalid', 'www.alpha.example.invalid', 'delta.example.invalid'])
    expect(byPort.get(9001)).toEqual(['gamma.example.invalid'])
  })

  it('drops a vhost with no upstream from the port map rather than inventing one', () => {
    const byPort = discoverHostnamesByPort([{ text: 'server { listen 443 ssl; server_name beta.example.invalid; }' }])
    expect(byPort.size).toBe(0)
  })

  // The live host has six vhosts that proxy to more than one port, and in
  // every one of them the FIRST proxy_pass in the block is not the one the
  // root location ("/") uses. Only the root location's target can be
  // reported: a probe of https://host/ never touches the others.
  const MULTI_LOCATION = `
server {
    listen 443 ssl;
    server_name multi.example.invalid;
    location /api {
        proxy_pass http://127.0.0.1:9101;
    }
    location / {
        proxy_pass http://127.0.0.1:9100;
    }
}
`

  it('reports the root location\'s port, not the first proxy_pass in the block', () => {
    const v = parseVhost(MULTI_LOCATION, NONE)
    expect(v.hostnames).toEqual(['multi.example.invalid'])
    expect(v.upstreamPort).toBe(9100)
  })

  it('reports null when a vhost has locations but none of them is root, rather than falling back to the first', () => {
    const v = parseVhost(
      'server { server_name noroot.example.invalid; location /api { proxy_pass http://127.0.0.1:9200; } }',
      NONE,
    )
    expect(v.upstreamPort).toBeNull()
  })

  it('ignores a commented-out server_name and a commented-out proxy_pass', () => {
    const COMMENTED = `
server {
    listen 443 ssl;
    # server_name ghost.example.invalid;
    server_name real.example.invalid;
    location / {
        # proxy_pass http://127.0.0.1:9301;
        proxy_pass http://127.0.0.1:9300;
    }
}
`
    const v = parseVhost(COMMENTED, NONE)
    expect(v.hostnames).toEqual(['real.example.invalid'])
    expect(v.upstreamPort).toBe(9300)
  })

  it('captures a root location whose body itself contains a nested brace (an if block)', () => {
    // Coverage for extractLocations' balanced-brace counting, which this
    // suite otherwise never exercises with a body containing its own `{ }`.
    const NESTED = `
server {
    listen 443 ssl;
    server_name nested.example.invalid;
    location / {
        if ($request_method = POST) {
            return 405;
        }
        proxy_pass http://127.0.0.1:9500;
    }
}
`
    const v = parseVhost(NESTED, NONE)
    expect(v.upstreamPort).toBe(9500)
  })

  it('resolves a proxy_pass to a named upstream, given the upstream map', () => {
    const upstreams = new Map([['backend', 8500]])
    const v = parseVhost(
      'server { server_name viaupstream.example.invalid; location / { proxy_pass http://backend; } }',
      upstreams,
    )
    expect(v.upstreamPort).toBe(8500)
  })

  it('reports null for a named upstream it cannot resolve, rather than guessing', () => {
    const v = parseVhost(
      'server { server_name unresolved.example.invalid; location / { proxy_pass http://backend; } }',
      NONE,
    )
    expect(v.upstreamPort).toBeNull()
  })

  it('resolves a named upstream declared in a different file when discovering by port', () => {
    const byPort = discoverHostnamesByPort([
      { text: 'upstream backend { server 127.0.0.1:8600; }' },
      { text: 'server { server_name crossfile.example.invalid; location / { proxy_pass http://backend; } }' },
    ])
    expect(byPort.get(8600)).toEqual(['crossfile.example.invalid'])
  })
})

describe('parseServerBlocks', () => {
  // Mirrors the live host's shape: one file, two complete server blocks,
  // each with its own server_name and its own root location proxying to a
  // DIFFERENT port. A file is not the unit of parsing -- scanning the whole
  // file's text as one block would take the first root location found
  // (block one's) and wrongly attach block two's hostname to it as well.
  const TWO_BLOCKS = `
server {
    listen 443 ssl;
    server_name blockone.example.invalid;
    location / {
        proxy_pass http://127.0.0.1:9400;
    }
}
server {
    listen 443 ssl;
    server_name blocktwo.example.invalid;
    location / {
        proxy_pass http://127.0.0.1:9401;
    }
}
`

  it('parses each server block independently, keeping one block\'s hostnames off another block\'s port', () => {
    const blocks = parseServerBlocks(TWO_BLOCKS, NONE)
    expect(blocks).toHaveLength(2)
    expect(blocks[0]?.hostnames).toEqual(['blockone.example.invalid'])
    expect(blocks[0]?.upstreamPort).toBe(9400)
    expect(blocks[1]?.hostnames).toEqual(['blocktwo.example.invalid'])
    expect(blocks[1]?.upstreamPort).toBe(9401)
  })

  it('keeps each block\'s hostnames on only its own port when discovering by port across a multi-block file', () => {
    const byPort = discoverHostnamesByPort([{ text: TWO_BLOCKS }])
    expect(byPort.get(9400)).toEqual(['blockone.example.invalid'])
    expect(byPort.get(9401)).toEqual(['blocktwo.example.invalid'])
  })

  // A directive value carrying ONE unbalanced literal brace inside a quoted
  // string -- here, "{oops" -- makes a naive (non-quote-aware) depth counter
  // run one level short. It then consumes the SECOND block's own closing
  // brace to rebalance, silently merging two blocks into one: server_name
  // matching sees both hostnames in one blob, and the first `location /`
  // wins for both. Two blocks must still come back, and each hostname must
  // stay on its own block's port.
  const UNBALANCED_QUOTE = `
server {
    listen 443 ssl;
    server_name quoteone.example.invalid;
    add_header X-Test "{oops";
    location / {
        proxy_pass http://127.0.0.1:9700;
    }
}
server {
    listen 443 ssl;
    server_name quotetwo.example.invalid;
    location / {
        proxy_pass http://127.0.0.1:9701;
    }
}
`

  it('does not let a literal brace inside a quoted directive value merge two server blocks', () => {
    const blocks = parseServerBlocks(UNBALANCED_QUOTE, NONE)
    expect(blocks).toHaveLength(2)
    expect(blocks[0]?.hostnames).toEqual(['quoteone.example.invalid'])
    expect(blocks[0]?.upstreamPort).toBe(9700)
    expect(blocks[1]?.hostnames).toEqual(['quotetwo.example.invalid'])
    expect(blocks[1]?.upstreamPort).toBe(9701)
  })

  it('keeps a quoted unbalanced brace from cross-attributing hostnames when discovering by port', () => {
    const byPort = discoverHostnamesByPort([{ text: UNBALANCED_QUOTE }])
    expect(byPort.get(9700)).toEqual(['quoteone.example.invalid'])
    expect(byPort.get(9701)).toEqual(['quotetwo.example.invalid'])
  })

  // The first block is missing its own closing brace entirely -- not hidden
  // inside a quote this time, just genuinely absent, the shape a collector
  // can catch a file in mid-save. A non-fail-closed scanner swallows the
  // second (well-formed) block while hunting for a brace to rebalance
  // against, merging both hostnames into one blob with the FIRST block's
  // root location winning for both -- trunctwo would wrongly acquire
  // truncone's port. Neither block can be trusted once one of them is
  // unterminated: there is no reliable place to draw the boundary between
  // "block one's missing close" and "block two starts here" without
  // guessing, so both are dropped.
  const UNTERMINATED_FIRST = `
server {
    listen 443 ssl;
    server_name truncone.example.invalid;
    location / {
        proxy_pass http://127.0.0.1:9800;
    }
server {
    listen 443 ssl;
    server_name trunctwo.example.invalid;
    location / {
        proxy_pass http://127.0.0.1:9801;
    }
}
`

  it('drops an unterminated first block rather than letting the second block\'s hostname acquire its port', () => {
    const blocks = parseServerBlocks(UNTERMINATED_FIRST, NONE)
    expect(blocks.some((b) => b.hostnames.includes('trunctwo.example.invalid') && b.upstreamPort === 9800)).toBe(false)
    expect(blocks).toEqual([])
  })

  it('keeps an unterminated first block from cross-attributing the second block\'s hostname when discovering by port', () => {
    const byPort = discoverHostnamesByPort([{ text: UNTERMINATED_FIRST }])
    expect(byPort.get(9800)).toBeUndefined()
    expect([...byPort.values()].flat()).not.toContain('trunctwo.example.invalid')
  })
})

describe('parseUpstreams', () => {
  it('maps an upstream name to its first loopback server port', () => {
    const upstreams = parseUpstreams([{ text: 'upstream backend { server 127.0.0.1:8700; }' }])
    expect(upstreams.get('backend')).toBe(8700)
  })

  it('ignores a commented-out upstream declaration', () => {
    const upstreams = parseUpstreams([{ text: '# upstream ghost { server 127.0.0.1:8800; }' }])
    expect(upstreams.has('ghost')).toBe(false)
  })

  it('resolves a duplicate upstream name to the last declaration processed (documented, not enforced by nginx here)', () => {
    const upstreams = parseUpstreams([
      { text: 'upstream backend { server 127.0.0.1:8900; }' },
      { text: 'upstream backend { server 127.0.0.1:8901; }' },
    ])
    expect(upstreams.get('backend')).toBe(8901)
  })
})

describe('reading the vhost directory', () => {
  it('follows symlinks, because the enabled directory is nothing but symlinks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vhosts-'))
    try {
      const available = join(root, 'available')
      const enabled = join(root, 'enabled')
      await mkdir(available)
      await mkdir(enabled)
      await writeFile(join(available, 'a.conf'), 'server { server_name a.example.invalid; }')
      await symlink(join(available, 'a.conf'), join(enabled, 'a.conf'))

      const files = await readVhostDir(enabled, {
        readdir: (d) => readdir(d),
        readFile: (p) => readFile(p, 'utf8'),
      })

      expect(files).toHaveLength(1)
      expect(files[0]!.text).toContain('a.example.invalid')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('skips a file it cannot read rather than failing the whole scan', async () => {
    const files = await readVhostDir('/enabled', {
      readdir: async () => ['ok.conf', 'gone.conf'],
      readFile: async (p) => {
        if (p.endsWith('gone.conf')) throw new Error('ENOENT')
        return 'server { server_name ok.example.invalid; }'
      },
    })
    expect(files).toHaveLength(1)
  })

  it('returns empty when the directory does not exist, without throwing', async () => {
    const files = await readVhostDir('/nope', {
      readdir: async () => {
        throw new Error('ENOENT')
      },
      readFile: async () => '',
    })
    expect(files).toEqual([])
  })
})

describe('discoverTlsByHostname', () => {
  it('maps a hostname to true when its server block listens for TLS', () => {
    const tls = discoverTlsByHostname([{ text: VHOST }])
    expect(tls.get('alpha.example.invalid')).toBe(true)
    expect(tls.get('www.alpha.example.invalid')).toBe(true)
  })

  it('maps a hostname to false when its server block does not listen for TLS', () => {
    const tls = discoverTlsByHostname([
      { text: 'server { listen 80; server_name plain.example.invalid; location / { proxy_pass http://127.0.0.1:8090; } }' },
    ])
    expect(tls.get('plain.example.invalid')).toBe(false)
  })

  // Deliberately unlike discoverHostnamesByPort: a vhost that listens for
  // TLS but proxies nowhere still belongs in THIS MAP -- discoverHostnamesByPort
  // would drop it entirely for having no resolvable upstream. This only
  // pins that the map CONTAINS the entry; it does not claim anything reaches
  // the wire from it -- see discoverTlsByHostname's docstring ("ORPHAN TLS
  // VHOSTS") for why nothing downstream currently enumerates this map's own
  // keys, so an orphan hostname (one with no upstream, hence never a
  // collect.ts target) is collected here but reaches nobody today.
  it('includes a hostname that listens for TLS but resolves to no upstream at all, even though nothing downstream looks it up today', () => {
    const tls = discoverTlsByHostname([{ text: 'server { listen 443 ssl; server_name beta.example.invalid; }' }])
    expect(tls.get('beta.example.invalid')).toBe(true)
    expect(discoverHostnamesByPort([{ text: 'server { listen 443 ssl; server_name beta.example.invalid; }' }]).size).toBe(0)
  })

  it('has no entry at all for a hostname never declared anywhere', () => {
    const tls = discoverTlsByHostname([{ text: VHOST }])
    expect(tls.has('nowhere.example.invalid')).toBe(false)
  })

  // Fix round 1's Critical: 26 of 28 files on the live host declare the SAME
  // server_name in more than one block -- the dominant layout, not an edge
  // case -- typically a bare port-80 redirect block paired with the real TLS
  // block. Last-write-wins (plain Map.set, the ORIGINAL implementation) makes
  // the answer depend on file/block PROCESSING ORDER: whichever block is
  // seen last decides the hostname's TLS bit, and a naive readdir with no
  // sort guarantee makes that order effectively arbitrary. The question this
  // map answers is "does ANY server block for this name listen for TLS",
  // which is OR-accumulation, not last-write-wins -- and `false` from the
  // wrong order is strictly worse than a miss: the hostname IS present in
  // byPort (the TLS block still has the real proxy_pass), so collect.ts's
  // `?? null` fallback never fires, and `false` ships as a POSITIVE claim
  // that a TLS-configured hostname is plain HTTP by design.
  it('reports true (OR-accumulated), never false, when a duplicate server_name has ONE TLS block and one plain block, TLS block FIRST', () => {
    const tls = discoverTlsByHostname([
      { text: 'server { listen 443 ssl; server_name dup.example.invalid; location / { proxy_pass http://127.0.0.1:8200; } }' },
      { text: 'server { listen 80; server_name dup.example.invalid; }' },
    ])
    expect(tls.get('dup.example.invalid')).toBe(true)
  })

  it('reports true (OR-accumulated) when the SAME duplicate pair is processed in the OPPOSITE order, plain block first', () => {
    const tls = discoverTlsByHostname([
      { text: 'server { listen 80; server_name dup.example.invalid; }' },
      { text: 'server { listen 443 ssl; server_name dup.example.invalid; location / { proxy_pass http://127.0.0.1:8200; } }' },
    ])
    expect(tls.get('dup.example.invalid')).toBe(true)
  })

  it('reports true (OR-accumulated) when both duplicate blocks are in the SAME file, TLS block first', () => {
    const tls = discoverTlsByHostname([
      {
        text: `
server { listen 443 ssl; server_name samefile.example.invalid; location / { proxy_pass http://127.0.0.1:8300; } }
server { listen 80; server_name samefile.example.invalid; }
`,
      },
    ])
    expect(tls.get('samefile.example.invalid')).toBe(true)
  })

  it('still reports false when EVERY block for a hostname is plain HTTP -- OR-accumulation does not manufacture a true from nothing', () => {
    const tls = discoverTlsByHostname([
      { text: 'server { listen 80; server_name allplain.example.invalid; }' },
      { text: 'server { listen 80; server_name allplain.example.invalid; }' },
    ])
    expect(tls.get('allplain.example.invalid')).toBe(false)
  })
})

describe('discoverVhostsFromDir', () => {
  it('discovers hostnames by port AND the TLS bit per hostname, from one reachable read', async () => {
    const discovery = await discoverVhostsFromDir('/enabled', {
      readdir: async () => ['a.conf'],
      readFile: async () =>
        'server { listen 443 ssl; server_name found.example.invalid; location / { proxy_pass http://127.0.0.1:8081; } }',
    })
    expect(discovery?.byPort.get(8081)).toEqual(['found.example.invalid'])
    expect(discovery?.tlsByHostname.get('found.example.invalid')).toBe(true)
  })

  it('reports an empty discovery (not null) when the directory can be listed but genuinely holds no vhosts', async () => {
    const discovery = await discoverVhostsFromDir('/enabled', {
      readdir: async () => [],
      readFile: async () => '',
    })
    expect(discovery).toEqual({ byPort: new Map(), tlsByHostname: new Map() })
  })

  it('reads the directory listing exactly ONCE -- no separate reachability check before it, which would open a TOCTOU window', async () => {
    let readdirCalls = 0
    await discoverVhostsFromDir('/enabled', {
      readdir: async () => {
        readdirCalls++
        return []
      },
      readFile: async () => '',
    })
    expect(readdirCalls).toBe(1)
  })

  // The discriminating case: a directory that cannot be listed must come
  // back as null, never as an empty discovery -- readVhostDir alone cannot
  // tell the two apart (both are `[]`), so a naive implementation that skips
  // the reachability check and just calls readVhostDir + the two pure
  // derivations would silently produce an empty discovery here instead,
  // which is indistinguishable downstream from "this host genuinely has no
  // vhosts".
  it('returns null, not an empty discovery, when the directory cannot be read at all', async () => {
    const discovery = await discoverVhostsFromDir('/enabled', {
      readdir: async () => {
        throw new Error('EACCES')
      },
      readFile: async () => '',
    })
    expect(discovery).toBeNull()
  })

  // Fix round 2's Critical: proves the SINGLE-READ property structurally.
  // `discoverHostnamesByPort` and `discoverTlsByHostname` must be derived
  // from the exact SAME `files` array, produced by exactly ONE pass of
  // `readNamedFiles` -- never from two independent passes (the shape the
  // predecessor functions `discoverHostnamesFromDir`/`discoverTlsFromDir`
  // had). Counting `readFile` invocations per name is a direct, mechanical
  // way to prove that: two independent composed reads would call `readFile`
  // TWICE for every name (once per axis); a single combined read calls it
  // once.
  //
  // MUTATION-VERIFIED AGAINST TODAY'S (PRE-FIX) TWO-READ ARRANGEMENT: this
  // test was run against a version of `discoverVhostsFromDir` implemented as
  // a thin wrapper composing the OLD `discoverHostnamesFromDir(dir, fs)` and
  // `discoverTlsFromDir(dir, fs)` (each doing its own independent
  // readdir+readFile pass) and FAILED with `expected [ 2, 2 ] to deeply
  // equal [ 1, 1 ]` -- see task-5-report.md, fix round 2, for the exact
  // transcript. Restored to the real single-read implementation below and
  // verified passing before this suite was finalised.
  it('reads each named file exactly ONCE per invocation, not once per axis', async () => {
    const readCounts = new Map<string, number>()
    await discoverVhostsFromDir('/enabled', {
      readdir: async () => ['a.conf', 'b.conf'],
      readFile: async (p) => {
        readCounts.set(p, (readCounts.get(p) ?? 0) + 1)
        return 'server { listen 443 ssl; server_name x.example.invalid; }'
      },
    })
    expect([...readCounts.values()]).toEqual([1, 1])
  })

  // Fix round 2's Critical, the concrete consequence of the property above:
  // the reviewer reproduced this live through a real `collectSnapshot` --
  // the TLS block's own file mid-write during the (former) SECOND
  // (TLS-axis) read, while the (former) FIRST (hostname-axis) read moments
  // earlier had seen it fine. That produced a hostname present in `byPort`
  // (mapped to a real port, via the TLS block's own `proxy_pass`, seen by
  // the read that succeeded) with a WRONG confident `false` in
  // `tlsByHostname` (derived only from the plain redirect block, because
  // the OTHER read never saw the TLS block at all) -- a wrong claim that
  // WAS wire-visible, because `byPort` having the hostname is what makes it
  // become a real probe target and enter a system's `hostnames` list.
  //
  // REVISED, final whole-branch review, I3 -- this test used to assert that
  // a partial read (one of two listed files unreadable) still produced a
  // non-null discovery, with `byPort.size === 0` and a `false` TLS entry,
  // reasoned as "inert" because nothing downstream looks the entry up once
  // the hostname is absent from `byPort`. That reasoning held ONE layer
  // down (`discoverVhostsFromDir`'s own two maps genuinely cannot
  // disagree), but not the layer above it: a system whose ONLY vhost file
  // happens to be the one that failed to read here ends up with a
  // genuinely EMPTY `byPort`, which `agent/src/collect.ts` cannot tell
  // apart from "this host was scanned in full and genuinely has no vhost
  // for this system" -- and that ships to the wire as `hostnames: []`, the
  // CONFIRMED-empty claim, when the truth is a miss. Same shape as Task 5's
  // Critical: a miss must degrade to absence, never to a wrong positive.
  //
  // `discoverVhostsFromDir` now refuses to distinguish "genuinely no
  // upstream" from "the file that would have had one failed to read" by
  // returning `null` for the WHOLE tick's discovery the moment ANY listed
  // file could not be read -- so this scenario (2 names listed, 1 file
  // read) now returns `null`, not a partial discovery.
  it('returns null (no opinion this tick), not a partial discovery, when one of several LISTED files fails to read', async () => {
    const discovery = await discoverVhostsFromDir('/enabled', {
      readdir: async () => ['a-redirect.conf', 'b-tls-block.conf'],
      readFile: async (p) => {
        if (p.endsWith('b-tls-block.conf')) throw new Error('EBUSY: file is being written')
        // The plain port-80 redirect block: declares the SAME hostname, no
        // TLS, no proxy_pass -- a redirect has nothing to proxy to, the
        // live host's dominant pairing for this exact hostname.
        return 'server { listen 80; server_name racy.example.invalid; return 301 https://$host$request_uri; }'
      },
    })
    expect(discovery).toBeNull()
  })
})

describe('the production VhostFs', () => {
  // This runs the EXACT object agent-deps.ts hands to readVhostDir on a
  // real host (via buildVhostDiscovery -> discoverVhostsFromDir) -- not a
  // lookalike lambda written inline in a test. The earlier
  // "follows symlinks" suite above proves node:fs/promises' readFile
  // follows a symlink (an OS guarantee, not something this module decides);
  // this suite proves the shipped nodeVhostFs object itself doesn't
  // reintroduce the grep -r failure through a plausible-looking rewrite
  // (readdir with withFileTypes + an isFile() filter), which would return
  // false for every symlinked entry even though its target is an ordinary
  // file.
  it('reads a real vhost file through a real symlink using the shipped production adapter', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vhosts-prod-fs-'))
    try {
      const available = join(root, 'available')
      const enabled = join(root, 'enabled')
      await mkdir(available)
      await mkdir(enabled)
      await writeFile(join(available, 'a.conf'), 'server { server_name prodfs.example.invalid; }')
      await symlink(join(available, 'a.conf'), join(enabled, 'a.conf'))

      const files = await readVhostDir(enabled, nodeVhostFs)

      expect(files).toHaveLength(1)
      expect(files[0]!.text).toContain('prodfs.example.invalid')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
