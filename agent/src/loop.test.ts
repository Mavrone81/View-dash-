import { describe, it, expect, vi } from 'vitest'
import { createTickRunner } from './loop.js'

function fakeLog() {
  return { warn: vi.fn(), error: vi.fn() }
}

/** A promise plus the handles to settle it from outside, so a test can hold a tick open. */
function deferred<T = void>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('createTickRunner', () => {
  it('runs the tick', async () => {
    const tick = vi.fn().mockResolvedValue(undefined)
    await createTickRunner(tick, fakeLog())()
    expect(tick).toHaveBeenCalledTimes(1)
  })

  it('never rejects when the tick rejects: a transient Docker failure must not kill the agent', async () => {
    const log = fakeLog()
    const run = createTickRunner(async () => {
      throw new Error('connect ENOENT /var/run/docker.sock')
    }, log)
    await expect(run()).resolves.toBeUndefined()
    expect(log.error).toHaveBeenCalled()
  })

  it('produces NO unhandled rejection when driven exactly the way the interval drives it', async () => {
    // This is the actual failure mode, measured rather than reasoned about:
    // `main.ts` schedules ticks as `void run()`, and `void` does not handle
    // a rejection -- it only stops a linter complaining. An unhandled
    // rejection terminates the Node process by default, so a rejected
    // `docker.listContainers()` took the agent down (masked by systemd's
    // Restart=always). Registering a listener here both detects the event
    // and, per Node's documented behaviour, suppresses the default
    // terminate -- so this test can observe the bug without dying of it.
    const seen: unknown[] = []
    const onUnhandled = (reason: unknown) => seen.push(reason)
    process.on('unhandledRejection', onUnhandled)
    try {
      const run = createTickRunner(async () => {
        throw new Error('docker daemon went away')
      }, fakeLog())
      // Deliberately NOT awaited -- exactly as `setInterval(() => { void
      // run() })` calls it.
      void run()
      // Two macrotask turns: enough for a rejection to be reported as
      // unhandled if it were going to be.
      await new Promise((r) => setTimeout(r, 0))
      await new Promise((r) => setTimeout(r, 0))
      expect(seen).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })

  it('logs the failure so a contained error is still visible to an operator', async () => {
    const log = fakeLog()
    const boom = new Error('deploy log unreadable')
    await createTickRunner(async () => {
      throw boom
    }, log)()
    const logged = log.error.mock.calls.flat()
    expect(logged).toContain(boom)
  })

  it('skips a tick that would overlap one still in flight, rather than stacking them', async () => {
    const gate = deferred()
    const tick = vi.fn().mockImplementation(() => gate.promise)
    const log = fakeLog()
    const run = createTickRunner(tick, log)

    const first = run()
    expect(tick).toHaveBeenCalledTimes(1)

    // Two further interval firings while the first is still running.
    await run()
    await run()
    expect(tick).toHaveBeenCalledTimes(1)
    expect(log.warn).toHaveBeenCalledTimes(2)

    gate.resolve()
    await first
  })

  it('runs again once the in-flight tick finishes, so skipping is never a permanent stop', async () => {
    const gate = deferred()
    const tick = vi.fn().mockImplementationOnce(() => gate.promise).mockResolvedValue(undefined)
    const run = createTickRunner(tick, fakeLog())

    const first = run()
    await run()
    expect(tick).toHaveBeenCalledTimes(1)

    gate.resolve()
    await first
    await run()
    expect(tick).toHaveBeenCalledTimes(2)
  })

  it('releases the overlap guard when a tick throws, so one failure cannot wedge the loop forever', async () => {
    const tick = vi
      .fn()
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValue(undefined)
    const run = createTickRunner(tick, fakeLog())

    await run()
    await run()
    expect(tick).toHaveBeenCalledTimes(2)
  })
})
