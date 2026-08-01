import { readFileSync } from 'node:fs'
import { DEFAULT_PROBE_TIMEOUT_MS } from './probe.js'

/** All environment-specific values arrive here at runtime. None are literals. */
export type AgentConfig = {
  /**
   * What this host BELIEVES it is called. It is NOT this agent's identity:
   * identity comes entirely from the bearer token, which `authenticateAgent`
   * resolves to a host row on the dashboard side, and nothing this process
   * says can change that.
   *
   * It is kept (rather than deleted as unused) because it is now sent once,
   * at connection time, purely so the dashboard can compare it against the
   * host the token actually belongs to and LOG a mismatch. That mismatch is
   * a real, reachable misconfiguration with a genuinely bad failure mode:
   * install host B's token on host A, and the board silently files host A's
   * systems under host B while host B's own agent files its own -- two
   * machines writing into one host row, producing a board that flaps
   * between two realities with nothing anywhere saying why. Detecting that
   * is worth one string on the wire.
   *
   * The dashboard LOGS the mismatch; it does not reject the connection. The
   * token stays authoritative, so a typo in this variable can never take a
   * host off the board -- see web/src/server/ingest-server.ts.
   */
  hostName: string
  dashboardUrl: string
  token: string
  deployLogGlob: string
  repoRoot: string
  intervalMs: number
  /**
   * Optional map of system key -> public URL, for the spec §4.1 HTTP probe.
   * A system absent from this map is NOT probed, and is reported exactly as
   * its containers describe it (see agent/src/probe.ts's `worstOf`).
   *
   * Empty by default, and empty in every deployment today: nothing in this
   * slice discovers or supplies a system's public URL, so the probe is
   * inert until an operator populates this. That is a known, deliberate gap
   * -- the probe MECHANISM ships now so health is worst-of by construction
   * the moment a URL source exists, rather than green-by-omission with a
   * plan to fix it later.
   */
  systemUrls: Record<string, string>
  probeTimeoutMs: number
}

/**
 * Parses `AGENT_SYSTEM_URLS`: comma-separated `key=url` pairs, e.g.
 * `alpha=https://alpha.example.test/,beta=https://beta.example.test/health`.
 *
 * Split on the FIRST `=` only, so a URL carrying a query string
 * (`?a=1&b=2`) survives intact.
 *
 * A malformed entry THROWS rather than being skipped. Silently dropping one
 * would leave a system unprobed while the operator believes it is being
 * probed -- the same "looks checked, isn't" failure this probe exists to
 * remove. Config errors on this agent are already loud (every required
 * variable throws when absent); this matches.
 */
export function parseSystemUrls(raw: string | undefined): Record<string, string> {
  if (!raw || raw.trim() === '') return {}
  const out: Record<string, string> = {}
  for (const entry of raw.split(',')) {
    const trimmed = entry.trim()
    if (trimmed === '') continue
    const eq = trimmed.indexOf('=')
    const key = eq === -1 ? '' : trimmed.slice(0, eq).trim()
    const url = eq === -1 ? '' : trimmed.slice(eq + 1).trim()
    if (!key || !url) {
      throw new Error(`invalid AGENT_SYSTEM_URLS entry (expected key=url): ${trimmed}`)
    }
    out[key] = url
  }
  return out
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
    systemUrls: parseSystemUrls(env.AGENT_SYSTEM_URLS),
    probeTimeoutMs: Number(env.AGENT_PROBE_TIMEOUT_MS ?? DEFAULT_PROBE_TIMEOUT_MS),
  }
}
