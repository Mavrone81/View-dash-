import { describe, it, expect } from 'vitest'
import { discoverSystems } from './docker.js'

const c = (project: string | null, state: string, health: string | null = null) =>
  ({ names: ['/x'], project, state, health })

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
})
