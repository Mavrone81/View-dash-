import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

// Only loopback, unspecified, and the RFC-5737 documentation ranges may appear.
const ALLOWED_IP = /^(127\.0\.0\.1|0\.0\.0\.0|192\.0\.2\.\d{1,3}|198\.51\.100\.\d{1,3}|203\.0\.113\.\d{1,3})$/
// Require a non-dot, non-digit boundary so "v1.2.3.4" and "10.0.0" are not IPs.
const IPV4 = /(?<![\w.])(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})(?![\w.])/g

// Documentation and the gate's own tests must be able to show a bad address
// without tripping it. The opt-out is per LINE and greppable, so every use is
// visible in review — never a whole-directory exemption, because docs are
// exactly where environment data tends to leak.
const OPT_OUT = /leak-gate:allow/

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
      for (const re of extra) {
        re.lastIndex = 0
        for (const m of text.matchAll(re)) hits.push({ path, line: i + 1, match: m[0] })
      }
    })
  }
  return hits
}

// The denylist of our own domains and system names is supplied by CI secret,
// never committed — otherwise the gate would itself disclose what it protects.
if (import.meta.url === `file://${process.argv[1]}`) {
  const files = execFileSync('git', ['ls-files'], { encoding: 'utf8' })
    .split('\n')
    .filter((f) => f && !f.startsWith('scripts/ci/leakage.test.'))
    .map((path) => ({ path, content: readFileSync(path, 'utf8') }))
  const patterns = (process.env.LEAKAGE_PATTERNS ?? '').split('\n')
  const hits = scanForLeakage(files, patterns)
  if (hits.length) {
    for (const h of hits) console.error(`LEAK ${h.path}:${h.line}  ${h.match}`)
    console.error(`\n${hits.length} disclosure violation(s). This repo is public.`)
    process.exit(1)
  }
  console.log('no environment data disclosed')
}
