import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// Final whole-branch review, I1 -- a GOVERNANCE test, not a behavioural one,
// for the same reason `probe-scheduler.test.ts`'s "the interval is imported,
// not redefined" describe block is one: the property this fix depends on
// (`lastExternalSweep` being a REQUIRED prop on `FleetTable`) is a
// compile-time guarantee that `tsc -b` enforces, not something a rendered
// component can be made to fail at runtime -- there is no prop value that
// makes `<FleetTable rows={rows} />` (with the attribute missing entirely)
// compile. What CAN be pinned here, by inspecting the source directly, is
// the shape that guarantee depends on staying true:
//
//   1. `FleetTable`'s own prop type declares `lastExternalSweep` WITHOUT a
//      `?` -- reverting that one character is exactly what silently
//      re-opens the seam this fix closes.
//   2. `page.tsx`, the board's only production render, actually supplies
//      the prop at its one call site -- so this test also catches the
//      seam's OTHER half: `tsc -b` cannot save the board if the type goes
//      back to optional at the same time the wiring is dropped.
//
// Manually verified (final whole-branch review): reverting `page.tsx`'s
// `<FleetTable rows={rows} lastExternalSweep={lastExternalSweep} />` to
// `<FleetTable rows={rows} />` and running `tsc -b` produces exactly:
//   web/src/app/page.tsx(11,8): error TS2741: Property 'lastExternalSweep'
//   is missing in type '{ rows: FleetRow[]; }' but required in type
//   '{ rows: FleetRow[]; lastExternalSweep: { reachedAnything: boolean;
//   ageMs: number; } | null; }'.
describe('page.tsx supplies FleetTable.lastExternalSweep (final whole-branch review, I1)', () => {
  it('declares lastExternalSweep as a REQUIRED prop on FleetTable, not optional', () => {
    const path = fileURLToPath(new URL('../components/FleetTable.tsx', import.meta.url))
    const source = readFileSync(path, 'utf8')
    expect(source).toMatch(/lastExternalSweep:\s*\{\s*reachedAnything: boolean; ageMs: number\s*\}\s*\|\s*null/)
    expect(source).not.toMatch(/lastExternalSweep\?:/)
  })

  it('actually passes lastExternalSweep at its one production call site', () => {
    const path = fileURLToPath(new URL('./page.tsx', import.meta.url))
    const source = readFileSync(path, 'utf8')
    expect(source).toMatch(/<FleetTable[^/]*lastExternalSweep=\{lastExternalSweep\}/s)
  })
})
