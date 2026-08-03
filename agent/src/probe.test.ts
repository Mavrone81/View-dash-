import { describe, it, expect, vi } from 'vitest'
import { worstOf, probeUrl, hostnamesForSystem, probeHostnameOnBox, type FetchLike } from './probe.js'

/** A fetch stand-in that answers with a fixed status and records what it was called with. */
function respondWith(status: number): FetchLike & { calls: string[] } {
  const calls: string[] = []
  const f: FetchLike = async (url) => {
    calls.push(url)
    return { status }
  }
  return Object.assign(f, { calls })
}

describe('worstOf', () => {
  it('downgrades a healthy container set when the public URL is failing', () => {
    // The spec's own example: "A container can be Up while the app 502s --
    // both, or it is not green."
    expect(worstOf('healthy', 'down')).toBe('down')
  })

  it('keeps the worse container state when the probe is fine', () => {
    expect(worstOf('down', 'healthy')).toBe('down')
    expect(worstOf('degraded', 'healthy')).toBe('degraded')
  })

  it('reports healthy only when BOTH sides are healthy', () => {
    expect(worstOf('healthy', 'healthy')).toBe('healthy')
  })

  it('does NOT downgrade a system that has no known URL, so an unprobeable system is never wrongly reddened', () => {
    // `null` means "no probe was performed", which must be reported as
    // whatever the containers said -- not as a failure. Otherwise "we were
    // never told where this app lives" would look identical to "we looked
    // and it is broken".
    expect(worstOf('healthy', null)).toBe('healthy')
    expect(worstOf('degraded', null)).toBe('degraded')
    expect(worstOf('down', null)).toBe('down')
  })
})

describe('probeUrl', () => {
  it('reports down for a 502, which is the exact case a container-only health check renders green', async () => {
    expect(await probeUrl('https://app.example.invalid/', respondWith(502))).toBe('down')
  })

  it('reports down for any 5xx', async () => {
    expect(await probeUrl('https://app.example.invalid/', respondWith(500))).toBe('down')
    expect(await probeUrl('https://app.example.invalid/', respondWith(503))).toBe('down')
  })

  it('reports healthy for a 2xx', async () => {
    expect(await probeUrl('https://app.example.invalid/', respondWith(200))).toBe('healthy')
  })

  it('reports healthy for a redirect: the app answered, and the redirect is not followed to another host', async () => {
    const f = respondWith(302)
    expect(await probeUrl('https://app.example.invalid/', f)).toBe('healthy')
    expect(f.calls).toEqual(['https://app.example.invalid/'])
  })

  it('reports degraded for a 4xx that is not a login wall: something answered, but this URL is not evidence the app works', async () => {
    expect(await probeUrl('https://app.example.invalid/', respondWith(404))).toBe('degraded')
  })

  // Reconciled with classifyHttpStatus (Task 1): this used to fold ALL 4xx,
  // including 401/403, into 'degraded'. A login wall is an application
  // working -- measured across the live host, an all-4xx-is-degraded rule
  // would have marked 19 of 42 hostnames broken while they were fine. This
  // is the deliberate behaviour CHANGE task-4-report.md documents: the old
  // assertion here was `expect(...401...).toBe('degraded')`.
  it('reports healthy for 401/403: a login wall is the app working, not the app degraded', async () => {
    expect(await probeUrl('https://app.example.invalid/', respondWith(401))).toBe('healthy')
    expect(await probeUrl('https://app.example.invalid/', respondWith(403))).toBe('healthy')
  })

  it('reports down, and does not throw, when the connection fails outright', async () => {
    const failing: FetchLike = async () => {
      throw new Error('connect ECONNREFUSED')
    }
    await expect(probeUrl('https://app.example.invalid/', failing)).resolves.toBe('down')
  })

  it('is bounded in time: a URL that accepts the connection and never replies aborts and reports down', async () => {
    // Without an enforced abort this promise would never settle, and
    // because collection awaits every system's probe, one such host would
    // hold the entire snapshot open indefinitely.
    const neverReplies: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error('aborted')))
      })
    const startedAt = Date.now()
    await expect(probeUrl('https://app.example.invalid/', neverReplies, 50)).resolves.toBe('down')
    expect(Date.now() - startedAt).toBeLessThan(2_000)
  })

  it('passes an abort signal that is actually wired to the timeout', async () => {
    let seen: AbortSignal | undefined
    const capture: FetchLike = async (_url, init) => {
      seen = init.signal
      return { status: 200 }
    }
    await probeUrl('https://app.example.invalid/', capture, 50)
    expect(seen).toBeInstanceOf(AbortSignal)
    expect(seen?.aborted).toBe(false)
  })

  it('leaves no pending timer behind after a fast success', async () => {
    // A probe that resolved immediately but left its timeout armed would
    // keep the Node event loop alive for the full timeout on every tick.
    const spy = vi.spyOn(globalThis, 'clearTimeout')
    try {
      await probeUrl('https://app.example.invalid/', respondWith(200), 30_000)
      expect(spy).toHaveBeenCalled()
    } finally {
      spy.mockRestore()
    }
  })
})

describe('mapping ports to hostnames', () => {
  it('pairs every hostname with the port it belongs to, across all of a system\'s published ports', () => {
    const byPort = new Map([
      [8081, ['alpha.example.invalid']],
      [9001, ['gamma.example.invalid']],
    ])
    expect(hostnamesForSystem([8081, 9001], byPort)).toEqual([
      { hostname: 'alpha.example.invalid', port: 8081 },
      { hostname: 'gamma.example.invalid', port: 9001 },
    ])
  })

  // Fix round 1's explicit call: a published port with NO vhost mapping is
  // still worth probing -- just with no Host header to claim, since none is
  // known. This used to return nothing at all for such a port; the change
  // is deliberate (see hostnamesForSystem's docstring) and this is the test
  // that pins the new behaviour, replacing the old "returns nothing"
  // assertion.
  it('still yields a target for a published port with no vhost mapping, with hostname null rather than guessed or omitted', () => {
    expect(hostnamesForSystem([7777], new Map([[8081, ['alpha.example.invalid']]]))).toEqual([
      { hostname: null, port: 7777 },
    ])
  })

  it('yields nothing at all for a port that is not even published', () => {
    // Contrast with the above: 7777 above WAS published (it's in the caller's
    // publishedPorts list) but had no vhost. A port that was never published
    // in the first place is simply never iterated.
    expect(hostnamesForSystem([], new Map([[8081, ['alpha.example.invalid']]]))).toEqual([])
  })

  // Fix round 1: a stray duplicate symlink in the enabled-vhost directory
  // makes the same (port, hostname) pair appear twice in `byPort`'s array
  // for that port. Without dedupe here, that doubles a real request against
  // a production root every tick for zero new information, and would
  // double the wire entry once Task 5 carries these results.
  it('deduplicates a (port, hostname) pair that appears twice for the same port', () => {
    const byPort = new Map([[8081, ['alpha.example.invalid', 'alpha.example.invalid']]])
    expect(hostnamesForSystem([8081], byPort)).toEqual([{ hostname: 'alpha.example.invalid', port: 8081 }])
  })

  it('does NOT dedupe the same hostname on two different ports -- that is two different backends claiming the same name, not one duplicate request', () => {
    const byPort = new Map([
      [8081, ['alpha.example.invalid']],
      [9001, ['alpha.example.invalid']],
    ])
    expect(hostnamesForSystem([8081, 9001], byPort)).toEqual([
      { hostname: 'alpha.example.invalid', port: 8081 },
      { hostname: 'alpha.example.invalid', port: 9001 },
    ])
  })
})

describe('on-box probing', () => {
  it('addresses the published container port directly, on loopback, with the hostname carried ONLY as a Host header', async () => {
    let seenUrl: string | undefined
    let seenHeaders: Record<string, string> | undefined
    const r = await probeHostnameOnBox('alpha.example.invalid', 8081, async (url, init) => {
      seenUrl = url
      seenHeaders = init.headers
      return { status: 301 }
    })
    expect(seenUrl).toBe('http://127.0.0.1:8081/')
    expect(seenHeaders).toEqual({ Host: 'alpha.example.invalid' })
    expect(r).toEqual({ hostname: 'alpha.example.invalid', outcome: 'answering', status: 301 })
  })

  it('sends no Host header at all for a null hostname, rather than a literal "null"', async () => {
    let seenHeaders: Record<string, string> | undefined
    let sawHeadersKey = false
    const r = await probeHostnameOnBox(null, 8081, async (_url, init) => {
      seenHeaders = init.headers
      sawHeadersKey = 'headers' in init
      return { status: 200 }
    })
    expect(sawHeadersKey).toBe(false)
    expect(seenHeaders).toBeUndefined()
    expect(r).toEqual({ hostname: null, outcome: 'answering', status: 200 })
  })

  it('names a 502 as the proxy having no upstream (classifyHttpStatus is one shared rule, even though this axis has no proxy in its own path)', async () => {
    const r = await probeHostnameOnBox('alpha.example.invalid', 8081, async () => ({ status: 502 }))
    expect(r.outcome).toBe('proxy-no-upstream')
  })

  it('never throws, whatever the fetch does', async () => {
    const r = await probeHostnameOnBox('alpha.example.invalid', 8081, async () => {
      throw new Error('boom')
    })
    expect(r.outcome).toBe('not-answering')
    expect(r.status).toBeNull()
  })

  it('is bounded in time, does not hang the collection loop', async () => {
    const neverReplies: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error('aborted')))
      })
    const startedAt = Date.now()
    const r = await probeHostnameOnBox('alpha.example.invalid', 8081, neverReplies, 50)
    expect(r.outcome).toBe('not-answering')
    expect(Date.now() - startedAt).toBeLessThan(2_000)
  })
})
