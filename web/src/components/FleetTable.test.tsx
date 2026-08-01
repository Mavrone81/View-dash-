// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { FleetTable } from './FleetTable.js'

const row = (over = {}) => ({
  key: 'alpha', displayName: 'alpha', state: 'healthy' as const,
  containersRunning: 3, containersTotal: 3,
  deployedSha: 'abcdef1234567890abcdef1234567890abcdef12',
  deployedSubject: 'fix: the thing', deployedAt: new Date('2026-08-01T10:00:00Z'),
  driftCommits: 0, receivedAt: new Date('2026-08-01T12:00:00Z'), ...over,
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
})
