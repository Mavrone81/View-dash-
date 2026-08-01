// Produces web/dist/ingest-server.mjs: the file the `ingest` service in
// docker-compose.yml actually runs (see docker-compose.yml's comment on
// that service for why a build step is needed at all).
//
// Unlike the agent bundle (scripts/build/bundle-agent.mjs), this file runs
// INSIDE the same Docker image as the Next.js `web` service -- the full
// monorepo, with `npm ci` already run. So it does not need to be fully
// standalone in the sense the agent bundle does. But `ws` is bundled IN
// anyway (not left external): Next's own production build only traces
// and ships the dependencies ITS pages actually import (see
// deploy/Dockerfile's runtime stage, which copies `.next/standalone`) --
// `ws` is never reachable from any Next page, so it would silently be
// MISSING from the runtime image's node_modules if left external here.
// `ws` has zero required native dependencies (its `bufferutil` and
// `utf-8-validate` peers are optional accelerators it `try/require`s
// itself -- see ws/lib/buffer-util.js and ws/lib/validation.js), so
// bundling it in is safe; those two are still marked `external` below so
// esbuild does not fail trying to resolve packages this repo never
// installs.
//
// `@prisma/client` is the one dependency that MUST stay external and
// resolved from that image's node_modules at runtime instead: its
// generated code locates the native query-engine binary relative to its
// own on-disk location, which breaks if esbuild inlines it into a
// different file. The runtime image's `.next/standalone/node_modules`
// (traced by `next build` for the `web` service, since it DOES import
// `@prisma/client`) already contains it.
//
// What else needs bundling: every relative import under web/src/server
// and web/src/lib (ingest-server.ts, auth-agent.ts, ingest.ts,
// agent-socket.ts, db.ts, ingest-server-config.ts, staleness.ts, ...) is
// written the NodeNext way -- `from './auth-agent.js'` pointing at a
// sibling `auth-agent.ts` -- which only a bundler or `tsc` resolves;
// plain Node cannot (confirmed empirically: see the compose file's
// comment on the `ingest` command). The workspace package
// `@bevora-ops/shared` has the same problem one level up: its
// `package.json` points `main`/`types` straight at `shared/src/index.ts`,
// so `require('@bevora-ops/shared')` in a plain Node process would try to
// load TypeScript source directly. Leaving it external would just move
// today's failure from "ingest-server.ts" to "@bevora-ops/shared" instead
// of fixing it, so it is bundled IN rather than externalised, along with
// its own dependency `zod`.
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '../..')

await build({
  entryPoints: [path.join(repoRoot, 'web/src/server/ingest-server.ts')],
  outfile: path.join(repoRoot, 'web/dist/ingest-server.mjs'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  // ESM, unlike the agent bundle: ingest-server.ts gates its own
  // self-start (`if (import.meta.url === \`file://${process.argv[1]}\`)`)
  // on `import.meta.url`, which esbuild leaves EMPTY when the output
  // format is "cjs" (confirmed by building this bundle: esbuild warns
  // `"import.meta" is not available with the "cjs" output format` and the
  // guard silently never fires, so the listener never starts). Node's
  // native ESM support gives `import.meta.url` its real value, so the
  // guard behaves exactly as it does today under `tsx`/vitest. The
  // `.mjs` extension forces ESM interpretation regardless of any ancestor
  // `package.json`'s `"type"` field (web/package.json sets none).
  format: 'esm',
  sourcemap: false,
  minify: false,
  logLevel: 'info',
  external: ['@prisma/client', '.prisma/client', 'bufferutil', 'utf-8-validate'],
  banner: {
    // Two things, both required for the bundled-in `ws` (a CommonJS
    // package) to work under ESM output:
    //
    // 1. esbuild's own CJS-interop shim for a `require(...)` call it
    //    finds INSIDE a bundled CommonJS module's body (as opposed to a
    //    top-level import it can rewrite) falls back, at runtime, to
    //    whatever `require` is in scope -- and a real ESM module has none
    //    by default. Without this line, `ws`'s own `require('events')` /
    //    `require('http')` (see ws/lib/websocket.js, ws/lib/stream.js)
    //    throw `Dynamic require of "events" is not supported` the moment
    //    the listener starts -- confirmed by building and running this
    //    bundle without the line below, then fixed by adding it. This is
    //    esbuild's own documented workaround for exactly this ESM+CJS
    //    combination, not a hand-rolled polyfill.
    // 2. The do-not-edit banner text itself.
    js: [
      "import { createRequire as __bevoraCreateRequire } from 'node:module';",
      'const require = __bevoraCreateRequire(import.meta.url);',
      '// Generated by `npm run build:ingest` from web/src/server/ingest-server.ts -- do not edit by hand.',
    ].join('\n'),
  },
})
