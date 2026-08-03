/**
 * Derives which hostnames serve which system, by reading the host's
 * reverse-proxy configuration rather than a maintained list.
 *
 * A maintained list is why slice 1's probe never ran: the code shipped, the
 * configuration to feed it never did. Derivation means a new stack is
 * probed the day it deploys, with nobody editing anything -- which is the
 * property the operator asked for when they said this must stay "robust and
 * expendable".
 *
 * The chain is: server_name -> proxy_pass loopback port -> published
 * container port -> compose project. This module owns the first two links.
 */

export type VhostEntry = {
  hostnames: string[]
  upstreamPort: number | null
  listensTls: boolean
}

// `_` is nginx's catch-all: it names no system and must never become a
// probe target.
const CATCH_ALL = '_'

export function parseVhost(text: string): VhostEntry {
  const hostnames: string[] = []
  for (const m of text.matchAll(/server_name\s+([^;]+);/g)) {
    for (const name of (m[1] ?? '').trim().split(/\s+/)) {
      if (name && name !== CATCH_ALL && name.includes('.')) hostnames.push(name)
    }
  }
  const port = text.match(/proxy_pass\s+https?:\/\/127\.0\.0\.1:(\d+)/)
  const tls = /listen[^;]*\b443\b/.test(text) || /listen[^;]*\bssl\b/.test(text)
  return {
    hostnames,
    upstreamPort: port?.[1] !== undefined ? Number(port[1]) : null,
    listensTls: tls,
  }
}

export function discoverHostnamesByPort(files: Array<{ text: string }>): Map<number, string[]> {
  const byPort = new Map<number, string[]>()
  for (const f of files) {
    const v = parseVhost(f.text)
    // A vhost with no upstream is real and worth reporting elsewhere, but it
    // maps to no system, so it contributes nothing here rather than being
    // guessed onto one.
    if (v.upstreamPort === null || v.hostnames.length === 0) continue
    const existing = byPort.get(v.upstreamPort) ?? []
    byPort.set(v.upstreamPort, [...existing, ...v.hostnames])
  }
  return byPort
}
