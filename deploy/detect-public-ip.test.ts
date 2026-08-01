import { describe, it, expect, beforeAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'detect-public-ip.sh')

/**
 * Runs detect-public-ip.sh with a STUB `ip` command first on PATH, so the
 * script's interface parsing is exercised against controlled output rather
 * than against whatever this machine happens to have. `ip` does not exist
 * on macOS at all, which is the other reason this has to be stubbed.
 */
function runWithFakeIp(
  ipOutput: string | null,
  env: Record<string, string> = {},
): { code: number; stdout: string; stderr: string } {
  const dir = mkdtempSync(join(tmpdir(), 'detect-ip-'))
  if (ipOutput !== null) {
    const stub = join(dir, 'ip')
    // Ignores its arguments and prints the fixture: the script always
    // invokes it the same way (`ip -4 -o addr show scope global`).
    writeFileSync(stub, `#!/bin/sh\ncat <<'FIXTURE'\n${ipOutput}\nFIXTURE\n`)
    chmodSync(stub, 0o755)
  }
  try {
    const stdout = execFileSync('bash', [SCRIPT], {
      encoding: 'utf8',
      // `dir` FIRST so the stub wins; the rest of PATH is still present so
      // awk/cut/grep/head resolve normally. With ipOutput === null the dir
      // is empty, which is how "no `ip` command" is simulated -- note that
      // a real `ip` elsewhere on PATH would then be found instead, so that
      // case is only meaningful on a host without one (macOS, here).
      env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ''}`, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { code: 0, stdout, stderr: '' }
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string }
    return { code: e.status ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' }
  }
}

// `ip -4 -o addr show scope global` output, 4th whitespace field is the
// CIDR address. Real shape, trimmed to what this script reads.
//
// The `brd` value is an RFC-5737 documentation address rather than the
// all-ones broadcast address a real interface would show: the repo's own
// disclosure gate rejects any non-allowlisted IPv4 literal, and a fixture
// is not worth a per-line opt-out when an allowlisted address reads just as
// clearly. Nothing here parses past field 4 anyway.
const line = (iface: string, cidr: string, idx: number) =>
  `${idx}: ${iface}    inet ${cidr} brd 203.0.113.255 scope global ${iface}\\       valid_lft forever preferred_lft forever`

describe('detect-public-ip.sh', () => {
  beforeAll(() => {
    chmodSync(SCRIPT, 0o755)
  })

  it('picks the globally-routable address even when a private NIC is listed FIRST', () => {
    // This is the actual bug. `hostname -I | awk '{print $1}'` returns the
    // private address here, and the exposure checks then probe a private
    // address, find nothing, and report PASS -- certifying the very thing
    // they exist to catch.
    const out = runWithFakeIp(
      [
        line('eth1', '10.104.0.7/20', 3), // leak-gate:allow
        line('eth0', '203.0.113.42/20', 2),
      ].join('\n'),
    )
    expect(out.code).toBe(0)
    expect(out.stdout.trim()).toBe('203.0.113.42')
    expect(out.stdout).not.toContain('10.104.0.7') // leak-gate:allow
  })

  it('skips every RFC 1918 range, not just one of them', () => {
    for (const priv of ['10.0.0.5/8', '172.16.4.9/12', '172.31.9.9/12', '192.168.1.20/24']) { // leak-gate:allow
      const out = runWithFakeIp([line('eth1', priv, 3), line('eth0', '198.51.100.8/24', 2)].join('\n'))
      expect(out.code).toBe(0)
      expect(out.stdout.trim()).toBe('198.51.100.8')
    }
  })

  it('does not mistake 172.32.x for a private address, since the private block stops at 172.31', () => {
    // An over-broad `172\.` filter would silently discard a real public
    // address in 172.32-172.255 and then fail the whole check.
    const out = runWithFakeIp(line('eth0', '172.32.5.5/24', 2)) // leak-gate:allow
    expect(out.code).toBe(0)
    expect(out.stdout.trim()).toBe('172.32.5.5') // leak-gate:allow
  })

  it('FAILS LOUDLY when every address is private, rather than returning one of them', () => {
    // The core requirement: no answer is far better than a wrong answer
    // that makes an exposure check pass.
    const out = runWithFakeIp([line('eth1', '10.104.0.7/20', 3), line('docker0', '172.17.0.1/16', 4)].join('\n')) // leak-gate:allow
    expect(out.code).toBe(1)
    expect(out.stdout.trim()).toBe('')
    expect(out.stderr).toMatch(/no globally-routable/i)
  })

  it('FAILS LOUDLY when there are no addresses at all', () => {
    const out = runWithFakeIp('')
    expect(out.code).toBe(1)
    expect(out.stdout.trim()).toBe('')
    expect(out.stderr).not.toBe('')
  })

  it('honours an explicit override, for a host behind NAT that has no public address of its own', () => {
    const out = runWithFakeIp(line('eth1', '10.104.0.7/20', 3), { BEVORA_PUBLIC_IP: '203.0.113.77' }) // leak-gate:allow
    expect(out.code).toBe(0)
    expect(out.stdout.trim()).toBe('203.0.113.77')
  })

  it('prints the address and nothing else on stdout, so a caller can capture it directly', () => {
    const out = runWithFakeIp(line('eth0', '203.0.113.42/20', 2))
    expect(out.stdout).toBe('203.0.113.42\n')
  })
})
