import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

// Only loopback, unspecified, and the RFC-5737 documentation ranges may appear.
const ALLOWED_IP = /^(127\.0\.0\.1|0\.0\.0\.0|192\.0\.2\.\d{1,3}|198\.51\.100\.\d{1,3}|203\.0\.113\.\d{1,3})$/
// Require a non-dot, non-digit boundary so "v1.2.3.4" and "10.0.0" are not IPs.
const IPV4 = /(?<![\w.])(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})(?![\w.])/g

// IPv6 loopback (::1), the unspecified address (::, the v6 analogue of
// 0.0.0.0), and the 2001:db8::/32 documentation prefix (RFC 3849) may appear.
// Exact-match the first two so a real address that merely starts with "::1"
// (e.g. "::123", which is NOT the loopback) isn't wrongly waved through. // leak-gate:allow
function isAllowedIPv6(candidate) {
  const lower = candidate.toLowerCase()
  if (lower === '::' || lower === '::1') return true
  return /^2001:0?db8(:|$)/.test(lower)
}
// Candidate tokens: runs of hex digits and colons with 2-7 colon separators, so
// a single ":" (common in code, e.g. object literals, "a:1:b" style test
// fixtures) can't match — real IPv6 needs either 8 groups or one "::" run.
const IPV6_CANDIDATE = /(?<![\w:.])((?:[0-9A-Fa-f]{1,4})?(?::(?:[0-9A-Fa-f]{1,4})?){2,7})(?![\w:.])/g

// Documentation and the gate's own tests must be able to show a bad address
// without tripping it. The opt-out is per LINE and greppable, so every use is
// visible in review — never a whole-directory exemption, because docs are
// exactly where environment data tends to leak.
const OPT_OUT = /leak-gate:allow/

// Validates the shape a real IPv6 address must have, so arbitrary
// colon-delimited hex-looking text (timestamps, AAD strings like "a:1:b",
// nonce/IV encodings) isn't mistaken for an address: with no "::" compression
// there must be exactly 8 groups; with exactly one "::" there may be at most 7
// explicit groups (the compression stands in for the rest). More than one "::"
// is never valid.
function isPlausibleIPv6(candidate) {
  const compressions = candidate.match(/::/g) ?? []
  if (compressions.length > 1) return false
  const groups = candidate.split(':')
  const nonEmpty = groups.filter((g) => g !== '')
  if (!nonEmpty.every((g) => /^[0-9A-Fa-f]{1,4}$/.test(g))) return false
  return compressions.length === 1 ? nonEmpty.length <= 7 : groups.length === 8
}

export function scanForLeakage(files, patterns) {
  const extra = patterns.filter(Boolean).map((p) => new RegExp(p, 'gi'))
  const hits = []
  for (const { path, content } of files) {
    content.split('\n').forEach((text, i) => {
      if (OPT_OUT.test(text)) return
      for (const m of text.matchAll(IPV4)) {
        const ip = m[1]
        if (ip.split('.').every((o) => Number(o) <= 255) && !ALLOWED_IP.test(ip)) {
          hits.push({ path, line: i + 1, match: ip })
        }
      }
      for (const m of text.matchAll(IPV6_CANDIDATE)) {
        const candidate = m[1]
        if (isPlausibleIPv6(candidate) && !isAllowedIPv6(candidate)) {
          hits.push({ path, line: i + 1, match: candidate })
        }
      }
      for (const re of extra) {
        re.lastIndex = 0
        for (const m of text.matchAll(re)) hits.push({ path, line: i + 1, match: m[0] })
      }
    })
  }
  return hits
}

// Loads the extra-pattern denylist from a file (never an env var — secrets are
// file-mounted). Returns [] when no file is configured, which is the documented
// transitional state: the IPv4/IPv6 rules still run unconditionally either way.
// Throws if a path WAS given but can't be read — that must fail the build, not
// silently fall back to "no extra patterns".
export function loadPatternsFromFile(filePath) {
  if (!filePath) return []
  return readFileSync(filePath, 'utf8').split('\n')
}

// The denylist of our own domains and system names is supplied by CI as a
// file-mounted secret (LEAKAGE_PATTERNS_FILE points at it), never an env var
// and never committed — otherwise the gate would itself disclose what it
// protects, and a secret in an env var can leak into a crash dump or a child
// process's environment.
if (import.meta.url === `file://${process.argv[1]}`) {
  const files = execFileSync('git', ['ls-files'], { encoding: 'utf8' })
    .split('\n')
    .filter((f) => f && !f.startsWith('scripts/ci/leakage.test.'))
    .map((path) => ({ path, content: readFileSync(path, 'utf8') }))
  const patternsFile = process.env.LEAKAGE_PATTERNS_FILE
  let patterns
  try {
    patterns = loadPatternsFromFile(patternsFile)
  } catch {
    // Never log the error object or file contents — only the path, which is
    // not itself sensitive.
    console.error(`Cannot read LEAKAGE_PATTERNS_FILE: ${patternsFile}`)
    process.exit(1)
  }
  const hits = scanForLeakage(files, patterns)
  if (hits.length) {
    for (const h of hits) console.error(`LEAK ${h.path}:${h.line}  ${h.match}`)
    console.error(`\n${hits.length} disclosure violation(s). This repo is public.`)
    process.exit(1)
  }
  console.log('no environment data disclosed')
}
