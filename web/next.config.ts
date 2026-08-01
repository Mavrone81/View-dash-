import type { NextConfig } from 'next'

const config: NextConfig = {
  // Produces .next/standalone -- a self-contained server (server.js plus a
  // dependency-traced node_modules subset) that the Dockerfile's runtime
  // stage copies whole, instead of shipping the full monorepo
  // node_modules into the image.
  output: 'standalone',

  webpack(config) {
    // This app's own source is written the NodeNext way -- relative
    // imports end in `.js` even though the file on disk is `.ts`/`.tsx`
    // (e.g. `src/app/page.tsx` imports `../lib/fleet-query.js`). vitest
    // (used by every test in this repo) and esbuild (used by
    // scripts/build/bundle-*.mjs) both resolve that pattern out of the
    // box. Next's bundlers do not, by default, in EITHER mode: confirmed
    // by running `next build` here -- both Turbopack (this app's default)
    // and plain webpack fail with `Module not found: Can't resolve
    // '../lib/fleet-query.js'` without this. `extensionAlias` is
    // webpack's own documented mechanism for exactly this TypeScript
    // convention. There is no equivalent, working Turbopack option as of
    // Next 16.2.12 -- see deploy/Dockerfile's comment on why its build
    // stage passes `--webpack` explicitly rather than using the default.
    config.resolve.extensionAlias = {
      '.js': ['.js', '.ts', '.tsx'],
    }
    return config
  },
}

export default config
