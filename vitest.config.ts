import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['**/*.test.ts', '**/*.test.tsx'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/.next/**'],
    // Multiple test files now share one live Postgres instance (web/src/lib/db.test.ts,
    // web/src/server/auth-agent.test.ts, and more to come) and each resets shared
    // tables in its own beforeEach. Running files in parallel interleaves one file's
    // deleteMany with another's create/update, producing intermittent FK-violation
    // and unique-constraint failures that have nothing to do with the code under
    // test. Serializing file execution trades a little wall-clock time for a
    // deterministic suite against real, shared infrastructure.
    fileParallelism: false,
    // Component tests declare `// @vitest-environment jsdom` at the top of
    // the file to opt into a DOM; everything else keeps the default 'node'
    // environment.
    setupFiles: ['./vitest.setup.ts'],
  },
})
