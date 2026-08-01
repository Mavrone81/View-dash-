import { readFileSync } from 'node:fs'

/** All environment-specific values arrive here at runtime. None are literals. */
export type AgentConfig = {
  hostName: string
  dashboardUrl: string
  token: string
  deployLogGlob: string
  repoRoot: string
  intervalMs: number
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AgentConfig {
  const need = (k: string): string => {
    const v = env[k]
    if (!v) throw new Error(`missing required config: ${k}`)
    return v
  }
  return {
    hostName: need('AGENT_HOST_NAME'),
    dashboardUrl: need('AGENT_DASHBOARD_URL'),
    // File-mounted, never an env value: the token must not appear in `ps` or logs.
    token: readFileSync(need('AGENT_TOKEN_FILE'), 'utf8').trim(),
    deployLogGlob: need('AGENT_DEPLOY_LOG_GLOB'),
    repoRoot: need('AGENT_REPO_ROOT'),
    intervalMs: Number(env.AGENT_INTERVAL_MS ?? 30_000),
  }
}
