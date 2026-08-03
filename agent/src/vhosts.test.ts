import { describe, it, expect } from 'vitest'
import { parseVhost, discoverHostnamesByPort, parseUpstreams } from './vhosts.js'

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
    const v = parseVhost(VHOST)
    expect(v.hostnames).toEqual(['alpha.example.invalid', 'www.alpha.example.invalid'])
    expect(v.upstreamPort).toBe(8081)
    expect(v.listensTls).toBe(true)
  })

  it('ignores the catch-all server_name, which names no system', () => {
    expect(parseVhost('server { server_name _; listen 80; }').hostnames).toEqual([])
  })

  it('reports a vhost that listens for TLS but proxies nowhere', () => {
    const v = parseVhost('server { listen 443 ssl; server_name beta.example.invalid; }')
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
    const v = parseVhost(MULTI_LOCATION)
    expect(v.hostnames).toEqual(['multi.example.invalid'])
    expect(v.upstreamPort).toBe(9100)
  })

  it('reports null when a vhost has locations but none of them is root, rather than falling back to the first', () => {
    const v = parseVhost(
      'server { server_name noroot.example.invalid; location /api { proxy_pass http://127.0.0.1:9200; } }',
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
    const v = parseVhost(COMMENTED)
    expect(v.hostnames).toEqual(['real.example.invalid'])
    expect(v.upstreamPort).toBe(9300)
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

describe('parseUpstreams', () => {
  it('maps an upstream name to its first loopback server port', () => {
    const upstreams = parseUpstreams([{ text: 'upstream backend { server 127.0.0.1:8700; }' }])
    expect(upstreams.get('backend')).toBe(8700)
  })

  it('ignores a commented-out upstream declaration', () => {
    const upstreams = parseUpstreams([{ text: '# upstream ghost { server 127.0.0.1:8800; }' }])
    expect(upstreams.has('ghost')).toBe(false)
  })
})
