import type { ReactNode } from 'react'

// The App Router requires a root layout for every route -- this is that
// minimal, required wrapper, not a design decision. `next build` fails
// outright without one ("page.tsx doesn't have a root layout"), which is
// how this gap was found while building the Dockerfile in deploy/Dockerfile
// (task 14, fix round 1).
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
