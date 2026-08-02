import type { ReactNode } from 'react'
import './globals.css'

// The App Router requires a root layout for every route -- this is that
// minimal, required wrapper, not a design decision. `next build` fails
// outright without one ("page.tsx doesn't have a root layout"), which is
// how this gap was found while building the Dockerfile in deploy/Dockerfile
// (task 14, fix round 1).
//
// `globals.css` is imported here (not per-page) so the "Heartbeat" design
// tokens and typography apply to every route this app ever grows -- there's
// only one page today, but the tokens are the single source of truth for
// both themes and must not depend on which page happens to import them.
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
