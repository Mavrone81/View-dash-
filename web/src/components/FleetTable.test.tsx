// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { FleetTable } from './FleetTable.js'
import type { Beat } from '../lib/beats.js'

/** A trace with every slot reporting a clean beat -- the "fully reporting" fixture. */
const goodBeats = (n = 40): Beat[] => Array.from({ length: n }, () => ({ state: 'good' as const }))

const row = (over = {}) => ({
  id: 'host-1:alpha', hostName: 'host-1',
  key: 'alpha', displayName: 'alpha', state: 'healthy' as const,
  containersRunning: 3, containersTotal: 3,
  deployedSha: 'abcdef1234567890abcdef1234567890abcdef12',
  deployedSubject: 'fix: the thing', deployedAt: new Date('2026-08-01T10:00:00Z'),
  driftCommits: 0, receivedAt: new Date('2026-08-01T12:00:00Z'),
  lastSeenAt: new Date('2026-08-01T12:00:00Z'), beats: goodBeats(), ...over,
})

describe('FleetTable', () => {
  it('shows the short sha and the change description', () => {
    render(<FleetTable rows={[row()]} />)
    expect(screen.getByText('abcdef1')).toBeTruthy()
    expect(screen.getByText('fix: the thing')).toBeTruthy()
  })

  it('shows an em dash rather than a blank when nothing is known', () => {
    render(<FleetTable rows={[row({ deployedSha: null, deployedSubject: null })]} />)
    expect(screen.getAllByText('—').length).toBeGreaterThan(0)
  })

  it('labels a stale row as stale, not healthy', () => {
    render(<FleetTable rows={[row({ state: 'stale' })]} />)
    expect(screen.getByText(/stale/i)).toBeTruthy()
    expect(screen.queryByText(/^healthy$/i)).toBeNull()
  })

  it('flags drift when the deployed sha is behind', () => {
    render(<FleetTable rows={[row({ driftCommits: 4 })]} />)
    expect(screen.getByText(/4 behind/i)).toBeTruthy()
  })

  it('renders an empty state rather than an empty table', () => {
    render(<FleetTable rows={[]} />)
    expect(screen.getByText(/no systems reported/i)).toBeTruthy()
  })

  // Restored after the "Heartbeat" redesign dropped this column: the spec's
  // column list omitted it by mistake, not by decision, and the product
  // owner asked for it back between State and Last 40 beats. Scoped to
  // `.col-containers` throughout -- other cells on the row (state, sha,
  // deployed timestamp, drift) render their own em dashes for their own
  // unknowns, so an unscoped `getAllByText('—')` would pass whether or not
  // this column renders anything at all.
  describe('the Containers column', () => {
    it('renders a real zero-container count as 0/0, not a dash', () => {
      const { container } = render(
        <FleetTable rows={[row({ containersRunning: 0, containersTotal: 0 })]} />,
      )
      const cell = container.querySelector('.col-containers')
      expect(cell?.textContent).toBe('0/0')
      expect(cell?.textContent).not.toContain('—')
    })

    it('renders an em dash, not a fabricated 0/0, for a system that has never reported', () => {
      const { container } = render(
        <FleetTable rows={[row({ containersRunning: null, containersTotal: null })]} />,
      )
      const cell = container.querySelector('.col-containers')
      expect(cell?.textContent).toBe('—')
      expect(cell?.textContent).not.toContain('0/0')
    })

    it('renders a genuine non-zero count plainly', () => {
      const { container } = render(
        <FleetTable rows={[row({ containersRunning: 2, containersTotal: 3 })]} />,
      )
      expect(container.querySelector('.col-containers')?.textContent).toBe('2/3')
    })

    it('marks the never-reported dash as muted, distinct from a real count', () => {
      const { container } = render(
        <FleetTable rows={[row({ containersRunning: null, containersTotal: null })]} />,
      )
      expect(container.querySelector('.col-containers')?.classList.contains('col-containers--unknown')).toBe(true)
    })

    it('does not mark a genuine 0/0 as the muted unknown state', () => {
      const { container } = render(
        <FleetTable rows={[row({ containersRunning: 0, containersTotal: 0 })]} />,
      )
      expect(container.querySelector('.col-containers')?.classList.contains('col-containers--unknown')).toBe(false)
    })
  })

  describe('the trace strip (Last 40 beats)', () => {
    // Scoped to `.beat-trace` (the strip itself), NOT the whole rendered
    // container: `BeatLegend` below the table reuses the same `data-beat`
    // attribute on its swatches, so an unscoped query over-counts by
    // whatever the legend happens to render -- confirmed by first writing
    // these unscoped and watching them fail with counts off by exactly the
    // legend's one swatch per state.
    it('renders a visible gap for a silent slot, not just a colour', () => {
      const beats: Beat[] = [...goodBeats(39), { state: 'absent' }]
      const { container } = render(<FleetTable rows={[row({ beats })]} />)
      expect(container.querySelectorAll('.beat-trace [data-beat="absent"]')).toHaveLength(1)
    })

    it('renders no gaps at all for a fully-reporting system', () => {
      const { container } = render(<FleetTable rows={[row({ beats: goodBeats() })]} />)
      expect(container.querySelectorAll('.beat-trace [data-beat="absent"]')).toHaveLength(0)
      expect(container.querySelectorAll('.beat-trace [data-beat="good"]')).toHaveLength(40)
    })

    it('colours a beat that reported a fault distinctly from a merely missed one', () => {
      const beats: Beat[] = [...goodBeats(38), { state: 'absent' }, { state: 'alarm' }]
      const { container } = render(<FleetTable rows={[row({ beats })]} />)
      expect(container.querySelectorAll('.beat-trace [data-beat="alarm"]')).toHaveLength(1)
      expect(container.querySelectorAll('.beat-trace [data-beat="absent"]')).toHaveLength(1)
    })

    it('gives the trace a text alternative naming how many beats were missed -- not colour-only', () => {
      const beats: Beat[] = [...goodBeats(38), { state: 'absent' }, { state: 'absent' }]
      render(<FleetTable rows={[row({ beats })]} />)
      // A screen-reader user gets the same fact ("2 missed") a sighted user
      // reads off the grey gaps in the strip -- this must be real text, not
      // conveyed by colour/CSS alone.
      expect(screen.getByRole('img', { name: /2 missed/i })).toBeTruthy()
    })

    it('renders an em dash rather than a fabricated full trace when there is no beat data at all', () => {
      render(<FleetTable rows={[row({ beats: [] })]} />)
      // Every other field on this fixture is non-empty, so this dash can
      // only be coming from the trace column.
      expect(screen.getAllByText('—').length).toBeGreaterThan(0)
      // No trace widget at all -- rendering 40 absent slots here would be
      // inventing a "totally silent for 20 minutes" claim this row never
      // made (it simply carries no beat data, e.g. the "no systems enrolled
      // on this host" placeholder row).
      expect(screen.queryByRole('img')).toBeNull()
    })

    it('is keyboard-focusable, so the trace can carry a visible focus state', () => {
      const { container } = render(<FleetTable rows={[row()]} />)
      const trace = container.querySelector('.beat-trace')
      expect(trace).not.toBeNull()
      expect(trace?.getAttribute('tabindex')).toBe('0')
    })
  })

  describe('host scoping', () => {
    it('renders two same-named systems on different hosts as two distinct, labelled rows', () => {
      // `System.key` is unique per host by design, so this is a legal and
      // expected state -- and it used to produce two identical-looking rows
      // sharing one React key.
      const { container } = render(
        <FleetTable
          rows={[
            row({ id: 'host-1:web', hostName: 'host-1', key: 'web', displayName: 'web' }),
            row({ id: 'host-2:web', hostName: 'host-2', key: 'web', displayName: 'web' }),
          ]}
        />,
      )
      expect(container.querySelectorAll('tbody tr')).toHaveLength(2)
      // Which machine each row is about must be visible, or the two rows
      // are indistinguishable to the person reading them.
      expect(screen.getByText('host-1')).toBeTruthy()
      expect(screen.getByText('host-2')).toBeTruthy()
    })

    it('gives every row a distinct React key, so two same-named systems cannot collapse into one', () => {
      // MEASURED, not assumed. The first version of this test counted
      // rendered <tr> elements -- and it did NOT discriminate: verified by
      // reverting the component to `key={r.key}` and re-running, React 19
      // still renders both rows, so the test passed against the bug.
      //
      // What React actually does with duplicate sibling keys is emit
      // "Encountered two children with the same key" via console.error and
      // declare the resulting behaviour UNSUPPORTED -- children "may be
      // duplicated and/or omitted", and identity is not maintained across
      // updates, which on this board means row state attaching to the wrong
      // machine on re-render. That warning is the observable symptom, so
      // that is what this asserts on. Confirmed to fire against
      // `key={r.key}` and not to fire against `key={r.id}`.
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        const { container } = render(
          <FleetTable
            rows={[
              row({ id: 'host-1:web', hostName: 'host-1', key: 'web', deployedSubject: 'change on host-1' }),
              row({ id: 'host-2:web', hostName: 'host-2', key: 'web', deployedSubject: 'change on host-2' }),
            ]}
          />,
        )
        const complaints = spy.mock.calls.map((c) => c.map(String).join(' ')).join('\n')
        expect(complaints).not.toMatch(/same key/i)
        expect(container.querySelectorAll('tbody tr')).toHaveLength(2)
        expect(screen.getByText('change on host-1')).toBeTruthy()
        expect(screen.getByText('change on host-2')).toBeTruthy()
      } finally {
        spy.mockRestore()
      }
    })
  })

  // Spec §9: "If the agent connection drops, every row renders 'agent
  // unreachable, last seen HH:MM' -- greyed, not green." `receivedAt` was
  // computed and passed into this component and then never rendered, and
  // `Host.lastSeenAt` was written on every ingest and never read, so this
  // requirement was not delivered at all.
  describe('last seen (spec §9)', () => {
    it('tells an operator when a stale row was last any good', () => {
      render(<FleetTable rows={[row({ state: 'stale', receivedAt: new Date('2026-08-01T10:07:00Z') })]} />)
      expect(screen.getByText(/agent unreachable/i)).toBeTruthy()
      expect(screen.getByText(/last seen 10:07 UTC/i)).toBeTruthy()
    })

    it('falls back to the host last-seen time when the row has no observation of its own', () => {
      render(
        <FleetTable
          rows={[row({ state: 'unknown', receivedAt: null, lastSeenAt: new Date('2026-08-01T09:30:00Z') })]}
        />,
      )
      expect(screen.getByText(/last seen 09:30 UTC/i)).toBeTruthy()
    })

    it('says "never seen" rather than inventing a time for a host that has never reported', () => {
      render(<FleetTable rows={[row({ state: 'unknown', receivedAt: null, lastSeenAt: null })]} />)
      expect(screen.getByText(/never seen/i)).toBeTruthy()
    })

    it('does not clutter a live row with a last-seen time', () => {
      render(<FleetTable rows={[row({ state: 'healthy' })]} />)
      expect(screen.queryByText(/last seen/i)).toBeNull()
      expect(screen.queryByText(/agent unreachable/i)).toBeNull()
    })
  })
})
