import { describe, it, expect, vi } from 'vitest'
import { worstOf, probeUrl, type FetchLike } from './probe.js'

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

  it('reports degraded for a 4xx: something answered, but this URL is not evidence the app works', async () => {
    expect(await probeUrl('https://app.example.invalid/', respondWith(404))).toBe('degraded')
    expect(await probeUrl('https://app.example.invalid/', respondWith(401))).toBe('degraded')
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
