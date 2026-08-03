// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
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
  lastSeenAt: new Date('2026-08-01T12:00:00Z'), beats: goodBeats(),
  // The neutral "no evidence at all" shape -- deliberately NOT a healthy
  // hostname by default. Every pre-existing test above overrides only the
  // fields it cares about (state, sha, drift, beats...) and several of them
  // assert `queryByText(/^healthy$/i)).toBeNull()` -- if this fixture
  // defaulted to a healthy verdict, the new Answers column would render the
  // literal word "healthy" on every one of those rows and break them, for a
  // reason that has nothing to do with what they are testing.
  hostnames: null,
  onBoxProbes: null,
  primaryHostname: null,
  verdict: 'unprobed' as const,
  tlsConfigured: null,
  certDaysRemaining: null,
  hostnameAnswers: [],
  unnamedOnBoxProbes: [],
  ...over,
})

/** A single, healthy, named hostname -- the fixture the URL/Answers/Cert
 * tests below build on, since testing those columns requires internally
 * consistent hostnames/hostnameAnswers/primaryHostname, not just one
 * overridden field at a time. */
const healthyHostnameAnswer = (over = {}) => ({
  hostname: 'alpha.example.invalid',
  verdict: 'healthy' as const,
  onBoxOutcome: 'answering' as const,
  externalOutcome: 'answering' as const,
  externalAgeMs: 60_000,
  listensTls: true,
  certExpiresAt: new Date('2026-10-01T00:00:00Z'),
  certDaysRemaining: 60,
  ...over,
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

  // task-8-brief.md Resolution 3: the board is the way IN to the credential
  // vault for a specific system, so every row -- including one with no
  // credentials stored yet -- must link somewhere useful rather than
  // nowhere.
  describe('the link into the vault', () => {
    it('links a system row to the vault, scoped to its host and system key', () => {
      render(<FleetTable rows={[row({ id: 'host-1:web', hostName: 'host-1', key: 'web', displayName: 'web' })]} />)
      const link = screen.getByRole('link', { name: 'web' })
      expect(link.getAttribute('href')).toBe('/vault?host=host-1&system=web')
    })

    it('links even when a real system key would need URL-encoding', () => {
      render(
        <FleetTable
          rows={[row({ id: 'host-1:my system', hostName: 'host-1', key: 'my system', displayName: 'my system' })]}
        />,
      )
      const link = screen.getByRole('link', { name: 'my system' })
      expect(link.getAttribute('href')).toBe('/vault?host=host-1&system=my%20system')
    })
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

  // Spec §8: "URL -- the system's primary hostname, linked. A system with
  // no vhost reads 'no HTTP surface', never a bare dash." Task 5 also
  // handed this task the obligation that `hostnames: null` (no opinion this
  // tick) must read differently from `hostnames: []` (confirmed empty).
  describe('the URL column (spec §8)', () => {
    it('renders "no HTTP surface" for a system with confirmed zero hostnames, never a dash', () => {
      const { container } = render(
        <FleetTable rows={[row({ hostnames: [], primaryHostname: null, hostnameAnswers: [] })]} />,
      )
      const cell = container.querySelector<HTMLElement>('.col-url-cell')!
      expect(within(cell).getByText(/no http surface/i)).toBeTruthy()
      expect(cell.textContent).not.toContain('—')
    })

    it('renders a DIFFERENT sentence, still never a dash, when hostnames is null (no opinion this tick)', () => {
      const { container } = render(
        <FleetTable rows={[row({ hostnames: null, primaryHostname: null, hostnameAnswers: [] })]} />,
      )
      const cell = container.querySelector<HTMLElement>('.col-url-cell')!
      expect(cell.textContent).not.toContain('—')
      expect(within(cell).queryByText(/no http surface/i)).toBeNull()
      expect(cell.textContent?.toLowerCase()).toContain('not available')
    })

    it('links the primary hostname out to its real (external) address', () => {
      render(
        <FleetTable
          rows={[
            row({
              hostnames: [{ hostname: 'alpha.example.invalid', listensTls: true }],
              primaryHostname: 'alpha.example.invalid',
              hostnameAnswers: [healthyHostnameAnswer()],
            }),
          ]}
        />,
      )
      const link = screen.getByRole('link', { name: 'alpha.example.invalid' })
      expect(link.getAttribute('href')).toBe('https://alpha.example.invalid/')
    })

    it('reveals every other hostname on expansion, not just the primary', () => {
      const { container } = render(
        <FleetTable
          rows={[
            row({
              hostnames: [
                { hostname: 'alpha.example.invalid', listensTls: true },
                { hostname: 'beta.example.invalid', listensTls: true },
              ],
              primaryHostname: 'alpha.example.invalid',
              hostnameAnswers: [
                healthyHostnameAnswer(),
                healthyHostnameAnswer({ hostname: 'beta.example.invalid' }),
              ],
            }),
          ]}
        />,
      )
      const cell = container.querySelector<HTMLElement>('.col-url-cell')!
      // Collapsed by default -- a real `<details>` disclosure, not already
      // expanded, so a sighted user sees only the primary until they choose
      // to look further.
      const details = cell.querySelector('details.hostname-expand')
      expect(details).not.toBeNull()
      expect(details?.hasAttribute('open')).toBe(false)
      expect(within(cell).getByText(/\+1 more/i)).toBeTruthy()
      // ...but the sibling hostname is genuinely present in the markup, not
      // silently dropped -- reachable by anyone who expands the summary.
      expect(within(cell).getByRole('link', { name: 'beta.example.invalid' })).toBeTruthy()
    })
  })

  // Spec §8: "Answers -- the two-axis state ... where they disagree, which
  // side failed. The wording names the fault, not a colour."
  describe('the Answers column (spec §8)', () => {
    it('says the route is broken, in words, not just a colour', () => {
      render(<FleetTable rows={[row({ verdict: 'route-broken' })]} />)
      expect(within(screen.getByTestId('answers-cell')).getByText(/route broken/i)).toBeTruthy()
    })

    it('says the app itself is down', () => {
      render(<FleetTable rows={[row({ verdict: 'app-down' })]} />)
      expect(within(screen.getByTestId('answers-cell')).getByText(/app down/i)).toBeTruthy()
    })

    it('names a contradiction rather than silently picking a side', () => {
      render(<FleetTable rows={[row({ verdict: 'contradiction' })]} />)
      expect(within(screen.getByTestId('answers-cell')).getByText(/contradiction/i)).toBeTruthy()
    })

    // Task 7's addition to the brief's five verdicts. Must read as "we do
    // not know yet" -- neither an alarm nor reassurance -- because it will
    // be the MOST COMMON verdict on first deploy, before the external
    // axis's first five-minute cycle completes.
    it('reads "unconfirmed" as a neutral "we do not know yet", never as healthy or as an alarm', () => {
      render(<FleetTable rows={[row({ verdict: 'unconfirmed' })]} />)
      const cell = screen.getByTestId('answers-cell')
      expect(cell.getAttribute('data-verdict')).toBe('unconfirmed')
      expect(within(cell).queryByText(/^healthy$/i)).toBeNull()
      expect(within(cell).queryByText(/down|broken|contradiction/i)).toBeNull()
    })

    // `unprobed` ("neither axis ran") must read as a DIFFERENT sentence
    // from `unconfirmed` ("exactly one axis has an opinion") -- they are
    // different facts, per answers.ts's own docstring.
    it('reads "unprobed" distinctly from "unconfirmed" -- different facts, different words', () => {
      render(<FleetTable rows={[row({ verdict: 'unprobed' })]} />)
      const cell = screen.getByTestId('answers-cell')
      expect(within(cell).getByText(/not probed/i)).toBeTruthy()
      expect(within(cell).queryByText(/not yet confirmed/i)).toBeNull()
    })

    it('names the proxy specifically when the failing axis is a 502/504', () => {
      render(
        <FleetTable
          rows={[
            row({
              verdict: 'route-broken',
              primaryHostname: 'alpha.example.invalid',
              hostnameAnswers: [
                healthyHostnameAnswer({
                  verdict: 'route-broken',
                  externalOutcome: 'proxy-no-upstream',
                }),
              ],
            }),
          ]}
        />,
      )
      expect(within(screen.getByTestId('answers-cell')).getByText(/proxy up, app not responding/i)).toBeTruthy()
    })

    it('names a TLS handshake failure as its own thing, not folded silently into "app down"', () => {
      render(
        <FleetTable
          rows={[
            row({
              verdict: 'route-broken',
              primaryHostname: 'alpha.example.invalid',
              hostnameAnswers: [healthyHostnameAnswer({ verdict: 'route-broken', externalOutcome: 'tls-failed' })],
            }),
          ]}
        />,
      )
      expect(within(screen.getByTestId('answers-cell')).getByText(/tls handshake failed/i)).toBeTruthy()
    })

    it('shows the age of the last external result, so a stale one cannot pass as fresh (spec §5.1)', () => {
      render(
        <FleetTable
          rows={[
            row({
              primaryHostname: 'alpha.example.invalid',
              hostnameAnswers: [healthyHostnameAnswer({ externalAgeMs: 7 * 60_000 })],
            }),
          ]}
        />,
      )
      expect(within(screen.getByTestId('answers-cell')).getByText(/7m ago/)).toBeTruthy()
    })

    it('renders "a port with no name answered", never a blank, for an unnamed on-box probe', () => {
      render(
        <FleetTable
          rows={[
            row({
              hostnames: [],
              primaryHostname: null,
              hostnameAnswers: [],
              unnamedOnBoxProbes: [{ hostname: null, outcome: 'answering', status: 200 }],
            }),
          ]}
        />,
      )
      expect(within(screen.getByTestId('answers-cell')).getByText(/a port with no name answered/i)).toBeTruthy()
    })

    // THE DENIAL TEST spec §8 exists for: a multi-hostname system where one
    // hostname is fully healthy and another is fully down must not read as
    // "healthy" in the Answers cell. The component trusts the precomputed
    // `verdict` (fleet-query.ts's `worstVerdict` is what must get this
    // right; see fleet-query.test.ts's own denial test) -- this test proves
    // the component renders that correctly-computed verdict rather than
    // fabricating its own "healthy" from, say, the primary hostname alone.
    it('does not average a failing hostname into a green row', () => {
      render(
        <FleetTable
          rows={[
            row({
              hostnames: [
                { hostname: 'alpha.example.invalid', listensTls: true },
                { hostname: 'beta.example.invalid', listensTls: true },
              ],
              primaryHostname: 'alpha.example.invalid', // the healthy one, chosen for the link
              hostnameAnswers: [
                healthyHostnameAnswer(),
                healthyHostnameAnswer({
                  hostname: 'beta.example.invalid',
                  verdict: 'app-down',
                  onBoxOutcome: 'not-answering',
                  externalOutcome: 'not-answering',
                }),
              ],
              verdict: 'app-down', // the row's own worst-of, as fleet-query.ts computes it
            })]}
        />,
      )
      const cell = screen.getByTestId('answers-cell')
      // The row's SUMMARY word (the one always visible, before any
      // expansion) must be the worst-of verdict, not "healthy" -- scoped to
      // `.answer-word` specifically, since the per-hostname expansion below
      // legitimately says "app down" a second time for beta and an
      // unscoped query would find two matches instead of discriminating
      // between them.
      expect(cell.querySelector('.answer-word')?.textContent).toBe('app down')
      expect(within(cell).queryByText(/^healthy$/i)).toBeNull()
      // ...and the failing hostname must still be visible somewhere, not
      // simply dropped because the summary reads badly already.
      expect(within(cell).getByText(/beta\.example\.invalid/)).toBeTruthy()
    })
  })

  // Spec §6/§8: "Cert -- days remaining, amber under 21, red under 7. 'No
  // certificate' where TLS is configured without one."
  describe('the Cert column (spec §6/§8)', () => {
    it('shows a certificate under 7 days as red, not amber', () => {
      render(
        <FleetTable
          rows={[
            row({
              primaryHostname: 'alpha.example.invalid',
              tlsConfigured: true,
              certDaysRemaining: 3,
              hostnameAnswers: [healthyHostnameAnswer({ certDaysRemaining: 3 })],
            }),
          ]}
        />,
      )
      expect(screen.getByTestId('cert-cell').getAttribute('data-severity')).toBe('red')
    })

    it('shows a certificate under 21 but at least 7 days as amber, not red', () => {
      render(
        <FleetTable
          rows={[
            row({
              primaryHostname: 'alpha.example.invalid',
              tlsConfigured: true,
              certDaysRemaining: 15,
              hostnameAnswers: [healthyHostnameAnswer({ certDaysRemaining: 15 })],
            }),
          ]}
        />,
      )
      expect(screen.getByTestId('cert-cell').getAttribute('data-severity')).toBe('amber')
    })

    it('shows a certificate with 21 or more days as ok, not amber', () => {
      render(
        <FleetTable
          rows={[
            row({
              primaryHostname: 'alpha.example.invalid',
              tlsConfigured: true,
              certDaysRemaining: 21,
              hostnameAnswers: [healthyHostnameAnswer({ certDaysRemaining: 21 })],
            }),
          ]}
        />,
      )
      expect(screen.getByTestId('cert-cell').getAttribute('data-severity')).toBe('ok')
    })

    it('says "no certificate" where TLS is configured without one', () => {
      render(
        <FleetTable
          rows={[
            row({
              primaryHostname: 'alpha.example.invalid',
              tlsConfigured: true,
              certDaysRemaining: null,
              hostnameAnswers: [healthyHostnameAnswer({ certDaysRemaining: null, certExpiresAt: null })],
            }),
          ]}
        />,
      )
      const cell = screen.getByTestId('cert-cell')
      expect(within(cell).getByText(/no certificate/i)).toBeTruthy()
      expect(cell.getAttribute('data-severity')).toBe('red')
    })

    it('does not conflate "TLS not configured" with "no certificate" -- they are different facts', () => {
      render(
        <FleetTable
          rows={[
            row({
              primaryHostname: 'alpha.example.invalid',
              tlsConfigured: false,
              certDaysRemaining: null,
              hostnameAnswers: [healthyHostnameAnswer({ listensTls: false, certDaysRemaining: null, certExpiresAt: null })],
            }),
          ]}
        />,
      )
      const cell = screen.getByTestId('cert-cell')
      expect(within(cell).queryByText(/no certificate/i)).toBeNull()
      expect(within(cell).getByText(/no tls configured/i)).toBeTruthy()
      expect(cell.getAttribute('data-severity')).toBe('none')
    })

    // Obligation #2 handed to this task: `listensTls: null` (the vhost
    // config could not be determined this tick) must render distinctly
    // from both "no TLS" and "no certificate" -- it is a THIRD fact.
    it('renders a null listensTls (config undetermined this tick) as its own distinct state', () => {
      render(
        <FleetTable
          rows={[
            row({
              primaryHostname: 'alpha.example.invalid',
              tlsConfigured: null,
              certDaysRemaining: null,
              hostnameAnswers: [healthyHostnameAnswer({ listensTls: null, certDaysRemaining: null, certExpiresAt: null })],
            }),
          ]}
        />,
      )
      const cell = screen.getByTestId('cert-cell')
      expect(within(cell).queryByText(/no certificate/i)).toBeNull()
      expect(within(cell).queryByText(/no tls configured/i)).toBeNull()
      expect(within(cell).getByText(/unknown/i)).toBeTruthy()
      expect(cell.getAttribute('data-severity')).toBe('unknown')
    })

    it('shows "no HTTP surface" in the Cert column too, when there is no hostname to have a certificate at all', () => {
      render(<FleetTable rows={[row({ hostnames: [], primaryHostname: null, hostnameAnswers: [] })]} />)
      expect(within(screen.getByTestId('cert-cell')).getByText(/no http surface/i)).toBeTruthy()
    })
  })

  // Spec §9: "A fleet-wide external failure is a probe fault, not twenty
  // outages ... the board says the dashboard could not reach anything and
  // falls back to displaying on-box results -- it must NOT turn every row
  // red."
  describe('the fleet-wide external-failure banner (spec §9)', () => {
    it('shows a probe-side banner instead of reddening every row', () => {
      render(<FleetTable rows={[row({ verdict: 'healthy' })]} externalProbeFailedFleetWide />)
      expect(screen.getByText(/could not reach/i)).toBeTruthy()
      // The banner does not itself repaint a row -- a healthy row (as
      // fleet-query.ts would have ALREADY computed it, falling back to
      // on-box evidence) still reads healthy underneath the banner.
      expect(within(screen.getByTestId('answers-cell')).getByText(/^healthy$/i)).toBeTruthy()
    })

    it('shows no banner at all when the flag is absent', () => {
      render(<FleetTable rows={[row({ verdict: 'healthy' })]} />)
      expect(screen.queryByText(/could not reach/i)).toBeNull()
    })
  })
})
