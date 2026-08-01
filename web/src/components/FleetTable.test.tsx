// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { FleetTable } from './FleetTable.js'

const row = (over = {}) => ({
  id: 'host-1:alpha', hostName: 'host-1',
  key: 'alpha', displayName: 'alpha', state: 'healthy' as const,
  containersRunning: 3, containersTotal: 3,
  deployedSha: 'abcdef1234567890abcdef1234567890abcdef12',
  deployedSubject: 'fix: the thing', deployedAt: new Date('2026-08-01T10:00:00Z'),
  driftCommits: 0, receivedAt: new Date('2026-08-01T12:00:00Z'),
  lastSeenAt: new Date('2026-08-01T12:00:00Z'), ...over,
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

  it('shows an em dash for container counts on a system that has never reported', () => {
    render(<FleetTable rows={[row({ containersRunning: null, containersTotal: null })]} />)
    // Singular getByText: every other field in this fixture is non-null, so
    // this dash can only be coming from the Containers column — if the
    // fabricated-`0/0` bug were present, this dash would not exist at all.
    expect(screen.getByText('—')).toBeTruthy()
    expect(screen.queryByText('0/0')).toBeNull()
  })

  it('renders 0/0 for a system that genuinely reports zero containers, distinct from never having reported', () => {
    render(<FleetTable rows={[row({ containersRunning: 0, containersTotal: 0 })]} />)
    expect(screen.getByText('0/0')).toBeTruthy()
    // Every other field in this fixture is non-null, so a dash appearing
    // here would mean the zero-container case is being confused with the
    // never-reported case rather than kept distinct from it.
    expect(screen.queryByText('—')).toBeNull()
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
              row({ id: 'host-1:web', hostName: 'host-1', key: 'web', containersRunning: 1, containersTotal: 1 }),
              row({ id: 'host-2:web', hostName: 'host-2', key: 'web', containersRunning: 2, containersTotal: 2 }),
            ]}
          />,
        )
        const complaints = spy.mock.calls.map((c) => c.map(String).join(' ')).join('\n')
        expect(complaints).not.toMatch(/same key/i)
        expect(container.querySelectorAll('tbody tr')).toHaveLength(2)
        expect(screen.getByText('1/1')).toBeTruthy()
        expect(screen.getByText('2/2')).toBeTruthy()
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
