import { afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'

// Unmounts anything rendered by @testing-library/react after each test.
// Without this, jsdom's `document` (shared for the whole test FILE, not
// reset per test) accumulates every previous test's markup, so a later
// `getByText`/`queryByText` can match stale elements left over from an
// earlier case. This is a no-op for test files that never call `render`
// (mountedRootEntries is simply empty), so it is safe to register globally
// rather than only for component tests.
afterEach(() => {
  cleanup()
})
