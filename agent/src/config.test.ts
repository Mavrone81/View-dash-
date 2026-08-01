import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from './config.js'

function validEnv(over: Partial<NodeJS.ProcessEnv> = {}): NodeJS.ProcessEnv {
  const dir = mkdtempSync(join(tmpdir(), 'agent-config-'))
  const tokenFile = join(dir, 'token')
  writeFileSync(tokenFile, 'sekret-token-value\n')
  return {
    AGENT_HOST_NAME: 'proj-a',
    AGENT_DASHBOARD_URL: 'https://dashboard.example.test',
    AGENT_TOKEN_FILE: tokenFile,
    AGENT_DEPLOY_LOG_GLOB: '/var/log/deploy-*.log',
    AGENT_REPO_ROOT: '/srv/repos',
    ...over,
  }
}

describe('loadConfig', () => {
  it('loads a full config from env plus a file-mounted token', () => {
    const cfg = loadConfig(validEnv())
    expect(cfg).toMatchObject({
      hostName: 'proj-a',
      dashboardUrl: 'https://dashboard.example.test',
      token: 'sekret-token-value',
      deployLogGlob: '/var/log/deploy-*.log',
      repoRoot: '/srv/repos',
      intervalMs: 30_000,
    })
  })

  it('parses a custom interval', () => {
    const cfg = loadConfig(validEnv({ AGENT_INTERVAL_MS: '5000' }))
    expect(cfg.intervalMs).toBe(5000)
  })

  it('reads the token from the file, not from an env var', () => {
    // The token must never be a literal in the environment (it would show up in
    // `ps`/logs); AGENT_TOKEN (a plain env var) must be ignored even if present.
    const cfg = loadConfig(validEnv({ AGENT_TOKEN: 'should-be-ignored' }))
    expect(cfg.token).toBe('sekret-token-value')
  })

  it('rejects a config missing the host name', () => {
    const env = validEnv()
    delete env.AGENT_HOST_NAME
    expect(() => loadConfig(env)).toThrow('missing required config: AGENT_HOST_NAME')
  })

  it('rejects a config missing the dashboard url', () => {
    const env = validEnv()
    delete env.AGENT_DASHBOARD_URL
    expect(() => loadConfig(env)).toThrow('missing required config: AGENT_DASHBOARD_URL')
  })

  it('rejects a config missing the token file path', () => {
    const env = validEnv()
    delete env.AGENT_TOKEN_FILE
    expect(() => loadConfig(env)).toThrow('missing required config: AGENT_TOKEN_FILE')
  })

  it('rejects a config missing the deploy log glob', () => {
    const env = validEnv()
    delete env.AGENT_DEPLOY_LOG_GLOB
    expect(() => loadConfig(env)).toThrow('missing required config: AGENT_DEPLOY_LOG_GLOB')
  })

  it('rejects a config missing the repo root', () => {
    const env = validEnv()
    delete env.AGENT_REPO_ROOT
    expect(() => loadConfig(env)).toThrow('missing required config: AGENT_REPO_ROOT')
  })

  it('does not silently accept a token file that cannot be read', () => {
    // A missing/unreadable secret file must fail loudly, not fall back to an
    // empty or undefined token.
    const env = validEnv({ AGENT_TOKEN_FILE: join(tmpdir(), 'does-not-exist-token-file') })
    expect(() => loadConfig(env)).toThrow()
  })
})
