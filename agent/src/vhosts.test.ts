import { describe, it, expect } from 'vitest'
import { parseVhost, parseServerBlocks, discoverHostnamesByPort, parseUpstreams, readVhostDir } from './vhosts.js'
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
