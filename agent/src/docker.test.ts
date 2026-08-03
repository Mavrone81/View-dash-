import { describe, it, expect } from 'vitest'
import { discoverSystems, toSummary } from './docker.js'

const c = (project: string | null, state: string, health: string | null = null, publishedPorts: number[] = []) =>
  ({ names: ['/x'], project, state, health, publishedPorts })

describe('discoverSystems', () => {
  it('groups containers by compose project', () => {
    const out = discoverSystems([c('alpha', 'running'), c('alpha', 'running'), c('beta', 'running')])
    expect(out.map((s) => s.key).sort()).toEqual(['alpha', 'beta'])
    expect(out.find((s) => s.key === 'alpha')!.containers).toEqual({ total: 2, running: 2 })
  })

  it('is healthy only when every container runs and none is unhealthy', () => {
    expect(discoverSystems([c('a', 'running', 'healthy'), c('a', 'running')])[0]!.health).toBe('healthy')
  })

  it('is degraded when some containers are down', () => {
    expect(discoverSystems([c('a', 'running'), c('a', 'exited')])[0]!.health).toBe('degraded')
  })

  it('is down when no container runs', () => {
    expect(discoverSystems([c('a', 'exited'), c('a', 'exited')])[0]!.health).toBe('down')
  })

  it('is degraded when a container reports unhealthy even though it runs', () => {
    expect(discoverSystems([c('a', 'running', 'unhealthy')])[0]!.health).toBe('degraded')
  })

  it('ignores containers with no compose project rather than inventing one', () => {
    expect(discoverSystems([c(null, 'running')])).toEqual([])
  })

  it('is degraded, not healthy, when a container is still starting its healthcheck', () => {
    expect(discoverSystems([c('a', 'running', 'starting')])[0]!.health).toBe('degraded')
  })

  it('is degraded, not healthy, when a container health string is unrecognised', () => {
    expect(discoverSystems([c('a', 'running', 'unknown')])[0]!.health).toBe('degraded')
  })

  it('treats non-running states (restarting/paused/created) the same as any other non-running container', () => {
    expect(discoverSystems([c('a', 'running'), c('a', 'restarting')])[0]!.health).toBe('degraded')
    expect(discoverSystems([c('a', 'paused'), c('a', 'paused')])[0]!.health).toBe('down')
    expect(discoverSystems([c('a', 'created'), c('a', 'created')])[0]!.health).toBe('down')
  })

  it('returns systems sorted by key regardless of input order', () => {
    const out = discoverSystems([c('zeta', 'running'), c('alpha', 'running'), c('mid', 'running')])
    expect(out.map((s) => s.key)).toEqual(['alpha', 'mid', 'zeta'])
  })

  it('unions published ports across every container in the same system, deduplicated', () => {
    // A compose project's web and worker containers can each publish their
    // own port; a hostname mapped to either must reach this one system.
    const out = discoverSystems([c('a', 'running', null, [8081]), c('a', 'running', null, [8081, 9001])])
    expect(out[0]!.publishedPorts).toEqual([8081, 9001])
  })

  it('reports no published ports for a system whose containers publish none', () => {
    expect(discoverSystems([c('a', 'running')])[0]!.publishedPorts).toEqual([])
  })
})

describe('toSummary', () => {
  // `labels: null` means "omit the Labels key entirely" (a container with no compose
  // labels at all), distinct from the default (a container labelled into 'alpha').
  // Built conditionally because `exactOptionalPropertyTypes` forbids assigning
  // `undefined` to an optional key -- the key must be absent, not present-as-undefined.
  const raw = (status: string | undefined, labels: Record<string, string> | null = { 'com.docker.compose.project': 'alpha' }) => {
    const out: { Names: string[]; State: string; Labels?: Record<string, string>; Status?: string } = {
      Names: ['/x'],
      State: 'running',
    }
    if (labels !== null) out.Labels = labels
    if (status !== undefined) out.Status = status
    return out
  }

  it('reports no healthcheck (null) when the Status has no parenthetical', () => {
    expect(toSummary(raw('Up 2 hours')).health).toBeNull()
  })

  it('reports healthy when the Status says (healthy)', () => {
    expect(toSummary(raw('Up 2 hours (healthy)')).health).toBe('healthy')
  })

  it('reports unhealthy when the Status says (unhealthy)', () => {
    expect(toSummary(raw('Up 2 hours (unhealthy)')).health).toBe('unhealthy')
  })

  it('reports starting -- not null, not healthy -- when the Status says (health: starting)', () => {
    expect(toSummary(raw('Up 2 hours (health: starting)')).health).toBe('starting')
  })

  it('reports unknown -- never null -- for a parenthetical it does not recognise', () => {
    expect(toSummary(raw('Up 2 hours (some future docker phrasing)')).health).toBe('unknown')
  })

  it('reports null when Status is absent entirely', () => {
    expect(toSummary(raw(undefined)).health).toBeNull()
  })

  it('reports project null when the compose project label is absent', () => {
    expect(toSummary(raw('Up 2 hours', null)).project).toBeNull()
  })

  it('reports the compose project label when present', () => {
    expect(toSummary(raw('Up 2 hours', { 'com.docker.compose.project': 'beta' })).project).toBe('beta')
  })

  it('passes Names and State through unchanged', () => {
    const out = toSummary({ Names: ['/beta-web-1'], State: 'exited', Status: 'Exited (0) 3 minutes ago' })
    expect(out.names).toEqual(['/beta-web-1'])
    expect(out.state).toBe('exited')
  })

  it('reports no published ports when Ports is absent', () => {
    expect(toSummary(raw('Up 2 hours')).publishedPorts).toEqual([])
  })

  it('keeps only entries that carry a PublicPort, dropping an internal-only port', () => {
    // A port with no PublicPort is not reachable from outside the daemon at
    // all -- attaching a hostname to it would be worse than reporting none,
    // because nothing a probe does could ever reach it.
    const out = toSummary({
      ...raw('Up 2 hours'),
      Ports: [
        { PrivatePort: 80, PublicPort: 8088, Type: 'tcp' },
        { PrivatePort: 9000, Type: 'tcp' }, // internal only -- no PublicPort
      ],
    })
    expect(out.publishedPorts).toEqual([8088])
  })

  it('deduplicates a PublicPort reported twice, once per IPv4 and IPv6 host binding', () => {
    const out = toSummary({
      ...raw('Up 2 hours'),
      Ports: [
        { IP: '0.0.0.0', PrivatePort: 80, PublicPort: 8088, Type: 'tcp' },
        { IP: '::', PrivatePort: 80, PublicPort: 8088, Type: 'tcp' },
      ],
    })
    expect(out.publishedPorts).toEqual([8088])
  })

  // Fix round 2, C2: an unmapped published port is now probed on-box with
  // no evidence from nginx that it is loopback-bound TCP HTTP -- these two
  // filters are what makes that safe. Measured against real listeners: a
  // line-protocol service on a UDP-shaped port threw HPE_INVALID_CONSTANT,
  // and a silent TCP one burned the full probe timeout every tick before
  // ECONNREFUSED/AbortError -- both would render a perfectly healthy
  // database/cache/mail-relay/UDP stack permanently down.
  it('drops a udp port entirely -- an HTTP probe cannot even open a TCP connection to one', () => {
    const out = toSummary({
      ...raw('Up 2 hours'),
      Ports: [{ IP: '0.0.0.0', PrivatePort: 53, PublicPort: 8053, Type: 'udp' }],
    })
    expect(out.publishedPorts).toEqual([])
  })

  it('drops a port bound to a specific non-loopback address -- 127.0.0.1 on THIS host cannot reach it', () => {
    // Docker's userland proxy / iptables rule for a port bound to one
    // specific address only forwards traffic that arrives at THAT address;
    // dialing 127.0.0.1 for a port published at, say, a droplet's own
    // public IP gets a plain connection refusal regardless of the
    // container's health.
    const out = toSummary({
      ...raw('Up 2 hours'),
      Ports: [{ IP: '203.0.113.5', PrivatePort: 80, PublicPort: 8080, Type: 'tcp' }],
    })
    expect(out.publishedPorts).toEqual([])
  })

  it('keeps a port explicitly bound to 127.0.0.1', () => {
    const out = toSummary({
      ...raw('Up 2 hours'),
      Ports: [{ IP: '127.0.0.1', PrivatePort: 80, PublicPort: 8080, Type: 'tcp' }],
    })
    expect(out.publishedPorts).toEqual([8080])
  })

  it('keeps a tcp port with no IP reported at all, the same as 0.0.0.0', () => {
    const out = toSummary({
      ...raw('Up 2 hours'),
      Ports: [{ PrivatePort: 80, PublicPort: 8080, Type: 'tcp' }],
    })
    expect(out.publishedPorts).toEqual([8080])
  })
})
