// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
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
  leadHostnameAnswer: null,
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

    // Fix round 1 (Task 8 review), I3, scoped exactly as asked: only the
    // link SCHEME, not the prober itself (that half is Task 9's job, since
    // it owns the hostname list the runner receives).
    it('links a deliberately plain-HTTP vhost with http://, not a permanently-wrong https://', () => {
      render(
        <FleetTable
          rows={[
            row({
              hostnames: [{ hostname: 'alpha.example.invalid', listensTls: false }],
              primaryHostname: 'alpha.example.invalid',
              hostnameAnswers: [healthyHostnameAnswer({ listensTls: false })],
            }),
          ]}
        />,
      )
      const link = screen.getByRole('link', { name: 'alpha.example.invalid' })
      expect(link.getAttribute('href')).toBe('http://alpha.example.invalid/')
    })

    it('still defaults to https:// when listensTls is undetermined this tick (null)', () => {
      render(
        <FleetTable
          rows={[
            row({
              hostnames: [{ hostname: 'alpha.example.invalid', listensTls: null }],
              primaryHostname: 'alpha.example.invalid',
              hostnameAnswers: [healthyHostnameAnswer({ listensTls: null })],
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
      expect(within(cell).getByText(/2 hostnames/i)).toBeTruthy()
      // ...but the sibling hostname is genuinely present in the markup, not
      // silently dropped -- reachable by anyone who expands the summary.
      expect(within(cell).getByRole('link', { name: 'beta.example.invalid' })).toBeTruthy()
    })

    // Fix round 4 (Task 8 review), I3: the expansion lists EVERY hostname,
    // including the one already shown collapsed -- `CertCell` had the acute
    // version of this defect (a hostname's own figure becoming unreachable
    // from the whole row); `UrlCell` is made consistent with `AnswersCell`
    // for the same reason even though its own defect was less severe.
    it('lists the primary hostname too inside the expansion, not just the siblings', () => {
      render(
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
      const cell = document.querySelector<HTMLElement>('.col-url-cell')!
      const expansion = cell.querySelector<HTMLElement>('details.hostname-expand')!
      // Both hostnames -- alpha (the primary, already shown collapsed above)
      // AND beta -- appear inside the expansion's own link list.
      expect(within(expansion).getByRole('link', { name: 'alpha.example.invalid' })).toBeTruthy()
      expect(within(expansion).getByRole('link', { name: 'beta.example.invalid' })).toBeTruthy()
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
      // POSITIVE presence check, not just the two negatives below --
      // `VERDICT_COPY.unconfirmed = ''` left every one of those 47 tests
      // green in fix round 1, because nothing anywhere pinned the actual
      // text this state renders. `.answer-word` is scoped so this cannot
      // accidentally match copy belonging to a different verdict.
      expect(cell.querySelector('.answer-word')?.textContent).toBe('not yet confirmed')
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
      const answer = healthyHostnameAnswer({ verdict: 'route-broken', externalOutcome: 'proxy-no-upstream' })
      render(
        <FleetTable
          rows={[
            row({
              verdict: 'route-broken',
              primaryHostname: 'alpha.example.invalid',
              hostnameAnswers: [answer],
              leadHostnameAnswer: answer,
            }),
          ]}
        />,
      )
      expect(within(screen.getByTestId('answers-cell')).getByText(/proxy up, app not responding/i)).toBeTruthy()
    })

    it('names a TLS handshake failure as its own thing, not folded silently into "app down"', () => {
      const answer = healthyHostnameAnswer({ verdict: 'route-broken', externalOutcome: 'tls-failed' })
      render(
        <FleetTable
          rows={[
            row({
              verdict: 'route-broken',
              primaryHostname: 'alpha.example.invalid',
              hostnameAnswers: [answer],
              leadHostnameAnswer: answer,
            }),
          ]}
        />,
      )
      expect(within(screen.getByTestId('answers-cell')).getByText(/tls handshake failed/i)).toBeTruthy()
    })

    it('shows the age of the last external result, so a stale one cannot pass as fresh (spec §5.1)', () => {
      const answer = healthyHostnameAnswer({ externalAgeMs: 7 * 60_000 })
      render(
        <FleetTable
          rows={[
            row({
              verdict: 'healthy',
              primaryHostname: 'alpha.example.invalid',
              hostnameAnswers: [answer],
              leadHostnameAnswer: answer,
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
      const failing = healthyHostnameAnswer({
        hostname: 'beta.example.invalid',
        verdict: 'app-down',
        onBoxOutcome: 'not-answering',
        externalOutcome: 'not-answering',
      })
      render(
        <FleetTable
          rows={[
            row({
              hostnames: [
                { hostname: 'alpha.example.invalid', listensTls: true },
                { hostname: 'beta.example.invalid', listensTls: true },
              ],
              primaryHostname: 'alpha.example.invalid', // the healthy one, chosen for the link
              hostnameAnswers: [healthyHostnameAnswer(), failing],
              verdict: 'app-down', // the row's own worst-of, as fleet-query.ts computes it
              leadHostnameAnswer: failing, // the hostname that actually produced that verdict
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

    // THE DENIAL TEST for fix round 1's I2: the summary's parenthetical
    // detail and age must come from `leadHostnameAnswer` (the hostname that
    // actually produced the row's verdict), NEVER from the primary
    // hostname -- which can legitimately be a DIFFERENT, healthy one. Using
    // the primary's evidence here would produce a sentence contradicting
    // itself (the verdict names one fault, the parenthetical describes a
    // different, unrelated hostname's evidence).
    it('takes the Answers summary detail from the hostname that produced the verdict, never from a different, healthy primary', () => {
      const primaryAnswer = healthyHostnameAnswer() // alpha: healthy, no detail, no proxy/TLS failure
      const lead = healthyHostnameAnswer({
        hostname: 'beta.example.invalid',
        verdict: 'route-broken',
        externalOutcome: 'proxy-no-upstream',
        externalAgeMs: 3 * 60_000,
      })
      render(
        <FleetTable
          rows={[
            row({
              hostnames: [
                { hostname: 'alpha.example.invalid', listensTls: true },
                { hostname: 'beta.example.invalid', listensTls: true },
              ],
              primaryHostname: 'alpha.example.invalid', // the healthy one -- deliberately NOT the lead
              hostnameAnswers: [primaryAnswer, lead],
              verdict: 'route-broken',
              leadHostnameAnswer: lead,
            }),
          ]}
        />,
      )
      const cell = screen.getByTestId('answers-cell')
      // Scoped to `.answer-detail`/`.answer-age` SPECIFICALLY -- the
      // per-hostname expansion below independently renders beta's own
      // detail and age a second time regardless of which hostname the
      // SUMMARY actually used, so an unscoped query over the whole cell
      // would pass even if the summary read the wrong hostname's evidence.
      const summaryDetail = cell.querySelector('.answer-detail')
      const summaryAge = cell.querySelector('.answer-age')
      expect(summaryDetail?.textContent).toMatch(/proxy up, app not responding/i)
      expect(summaryAge?.textContent).toMatch(/3m ago/)
    })

    // M2 (fix round 2): the per-hostname expansion's OWN age for each
    // hostname survived only by accident -- nothing pinned it, so deleting
    // it (C3's own claimed fix) left the full suite green. A system with
    // several hostnames must not have only the arbitrary summary's age
    // visible; each hostname's own row in the expansion needs its own.
    it('shows each hostname\'s OWN age in the per-hostname expansion, not just the summary\'s', () => {
      render(
        <FleetTable
          rows={[
            row({
              hostnames: [
                { hostname: 'alpha.example.invalid', listensTls: true },
                { hostname: 'beta.example.invalid', listensTls: true },
              ],
              primaryHostname: 'alpha.example.invalid',
              hostnameAnswers: [
                healthyHostnameAnswer({ externalAgeMs: 2 * 60_000 }),
                healthyHostnameAnswer({ hostname: 'beta.example.invalid', externalAgeMs: 8 * 60_000 }),
              ],
              verdict: 'healthy',
              leadHostnameAnswer: healthyHostnameAnswer({ externalAgeMs: 2 * 60_000 }),
            }),
          ]}
        />,
      )
      const expansion = screen.getByTestId('answers-cell').querySelector<HTMLElement>('.answer-expand')!
      const items = within(expansion).getAllByRole('listitem')
      expect(items.find((li) => li.textContent?.includes('alpha'))?.textContent).toMatch(/2m ago/)
      expect(items.find((li) => li.textContent?.includes('beta'))?.textContent).toMatch(/8m ago/)
    })

    // M2 (fix round 2): `ageDetail(null)`'s exact wording was unpinned --
    // changing it to an outright lie about evidence age ('checked just
    // now' instead of the neutral 'never checked') passed the full suite.
    // This is the phrase that appears on nearly every row on first deploy
    // (before any external result exists at all), so it matters more than
    // most.
    //
    // Fix round 4 (Task 8 review), M7: the string is now just "never
    // checked", not "never checked externally" -- every call site already
    // prefixes the result with the literal word "external" (see
    // `AnswersCell`'s own `— external {ageDetail(...)}`), so the old wording
    // rendered "not yet confirmed — external never checked externally",
    // saying "external" twice. This test's own substring match used to miss
    // that duplication entirely.
    it('says "never checked", not a fabricated recency or a doubled "external", when no external result exists at all', () => {
      render(
        <FleetTable
          rows={[
            row({
              hostnames: [{ hostname: 'alpha.example.invalid', listensTls: true }],
              primaryHostname: 'alpha.example.invalid',
              verdict: 'unconfirmed',
              hostnameAnswers: [healthyHostnameAnswer({ verdict: 'unconfirmed', externalOutcome: null, externalAgeMs: null })],
              leadHostnameAnswer: healthyHostnameAnswer({ verdict: 'unconfirmed', externalOutcome: null, externalAgeMs: null }),
            }),
          ]}
        />,
      )
      const cell = screen.getByTestId('answers-cell')
      const age = cell.querySelector('.answer-age')
      expect(age?.textContent).toMatch(/— external never checked$/)
      expect(within(cell).queryByText(/checked just now/i)).toBeNull()
      // THE regression M7 found: the old wording said "external" twice.
      expect(age?.textContent?.match(/external/gi)).toHaveLength(1)
    })
  })

  // Spec §6/§8: "Cert -- days remaining, amber under 21, red under 7. 'No
  // certificate' where TLS is configured without one."
  describe('the Cert column (spec §6/§8)', () => {
    // Every fixture below needs a non-null, non-empty `hostnames` --
    // `CertCell` (fix round 1, I1) checks that FIRST, before ever looking
    // at `primaryHostname`/`hostnameAnswers`, so leaving it at row()'s
    // default `null` would make every one of these tests exercise the
    // "hostname data not available" branch instead of the severity logic
    // they mean to test.
    const oneHostname = [{ hostname: 'alpha.example.invalid', listensTls: true }]

    it('shows a certificate under 7 days as red, not amber', () => {
      render(
        <FleetTable
          rows={[
            row({
              hostnames: oneHostname,
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
              hostnames: oneHostname,
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
              hostnames: oneHostname,
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

    it('says "no certificate" where TLS is configured and the handshake itself reached and failed', () => {
      render(
        <FleetTable
          rows={[
            row({
              hostnames: oneHostname,
              primaryHostname: 'alpha.example.invalid',
              tlsConfigured: true,
              certDaysRemaining: null,
              hostnameAnswers: [
                healthyHostnameAnswer({ certDaysRemaining: null, certExpiresAt: null, externalOutcome: 'tls-failed' }),
              ],
            }),
          ]}
        />,
      )
      const cell = screen.getByTestId('cert-cell')
      expect(within(cell).getByText(/no certificate/i)).toBeTruthy()
      expect(cell.getAttribute('data-severity')).toBe('red')
    })

    // Fix round 1 (Task 8 review), C1: an ABSENCE of a days-remaining
    // figure must not, on its own, read as red. Only when the evidence
    // says the handshake was reached and failed (`tls-failed`, tested
    // above) is that a supported claim -- a hostname the external axis has
    // simply never reached yet (Task 9 not deployed, or the check failed
    // before ever reaching TLS) must read as "not observed", not "missing".
    it('does NOT say "no certificate" when the external axis has simply never reached this hostname -- that is "not checked", not "missing"', () => {
      render(
        <FleetTable
          rows={[
            row({
              hostnames: oneHostname,
              primaryHostname: 'alpha.example.invalid',
              tlsConfigured: true,
              certDaysRemaining: null,
              hostnameAnswers: [
                healthyHostnameAnswer({ certDaysRemaining: null, certExpiresAt: null, externalOutcome: null, externalAgeMs: null }),
              ],
            }),
          ]}
        />,
      )
      const cell = screen.getByTestId('cert-cell')
      expect(within(cell).queryByText(/^no certificate$/i)).toBeNull()
      expect(within(cell).getByText(/not checked yet/i)).toBeTruthy()
      expect(cell.getAttribute('data-severity')).toBe('unknown')
    })

    // Same absence, but this time the probe DID run and failed BEFORE
    // reaching TLS at all (DNS, timeout, refused connection --
    // `not-answering`) -- still not evidence of a missing certificate.
    it('does NOT say "no certificate" when the probe failed before ever reaching the TLS layer', () => {
      render(
        <FleetTable
          rows={[
            row({
              hostnames: oneHostname,
              primaryHostname: 'alpha.example.invalid',
              tlsConfigured: true,
              certDaysRemaining: null,
              hostnameAnswers: [
                healthyHostnameAnswer({ certDaysRemaining: null, certExpiresAt: null, externalOutcome: 'not-answering' }),
              ],
            }),
          ]}
        />,
      )
      const cell = screen.getByTestId('cert-cell')
      expect(within(cell).queryByText(/^no certificate$/i)).toBeNull()
      expect(within(cell).getByText(/not observed this check/i)).toBeTruthy()
      expect(cell.getAttribute('data-severity')).toBe('unknown')
    })

    it('does not conflate "TLS not configured" with "no certificate" -- they are different facts', () => {
      render(
        <FleetTable
          rows={[
            row({
              hostnames: oneHostname,
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
              hostnames: oneHostname,
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

    // THE DENIAL TEST for fix round 1's I1: an enrolled host that has never
    // checked in (`hostnames: null`, no opinion this tick) must NOT read as
    // "no HTTP surface" in the Cert column -- that is the CONFIRMED-empty
    // sentence, a different and stronger claim than "we simply do not know
    // yet". The previous CertCell fell through to `certLabel(null)` for
    // BOTH cases, destroying the distinction Task 5 spent two fix rounds
    // preserving in the URL column.
    it('does NOT say "no HTTP surface" in the Cert column when hostnames is null (never checked), unlike confirmed-empty', () => {
      render(<FleetTable rows={[row({ hostnames: null, primaryHostname: null, hostnameAnswers: [] })]} />)
      const cell = screen.getByTestId('cert-cell')
      expect(within(cell).queryByText(/no http surface/i)).toBeNull()
      expect(cell.textContent?.toLowerCase()).toContain('not available')
    })

    // THE DENIAL TEST for fix round 2's C1: the reviewer's exact reproduction
    // -- a primary hostname healthy and fresh (60d), a SIBLING two days from
    // expiry. The primary's own severity is `ok`, and `primaryHostname()`
    // chooses by which hostname ANSWERS, which has no relationship to
    // certificate health -- so a cell that only read the primary's severity
    // rendered green over a certificate two days out, with the red evidence
    // sitting inertly inside a CLOSED `<details>` (and, before this round's
    // CSS fix, not even coloured once opened -- see the CSS-coverage test
    // below). The fix takes the WORST severity across every hostname while
    // keeping the primary's own number as the visible text.
    // THE DENIAL TEST for fix round 3: the reviewer's exact scenario --
    // primary 60d, sibling 2d. Round 2 coloured this cell red while its
    // TEXT still said "60d remaining", which the reviewer overruled: a red
    // cell reading a healthy number reads as the colour being noise, and it
    // disagrees with the URL column's own primary hostname (whose
    // certificate genuinely has 60 days). The fix: the visible text now
    // names the ACTIONABLE (worst) figure, qualified with whose it is,
    // since it is not the primary's.
    it('names the ACTIONABLE figure and whose it is, when the worst hostname is a sibling, not the primary', () => {
      render(
        <FleetTable
          rows={[
            row({
              hostnames: [
                { hostname: 'alpha.example.invalid', listensTls: true },
                { hostname: 'beta.example.invalid', listensTls: true },
              ],
              primaryHostname: 'alpha.example.invalid',
              hostnameAnswers: [
                healthyHostnameAnswer({ certDaysRemaining: 60 }),
                healthyHostnameAnswer({ hostname: 'beta.example.invalid', certDaysRemaining: 2 }),
              ],
            }),
          ]}
        />,
      )
      const cell = screen.getByTestId('cert-cell')
      expect(cell.getAttribute('data-severity')).toBe('red')
      // The collapsed text carries the WORST (2d), not the primary's
      // reassuring 60d -- and names whose figure it is, so the row never
      // says something false about `alpha.example.invalid`.
      const collapsedText = cell.childNodes[0]?.textContent
      expect(collapsedText).toMatch(/2d remaining/)
      expect(collapsedText).toMatch(/beta\.example\.invalid/)
      expect(collapsedText).not.toMatch(/60d remaining/)
      // THE DENIAL TEST for fix round 4's I3: the primary's OWN figure
      // (alpha, 60d) must still be reachable from this row -- it used to
      // render NOWHERE at all, because the expansion excluded the primary
      // ("others"), so this scenario rendered beta twice (collapsed AND in
      // the expansion) and alpha zero times.
      const expansion = cell.querySelector<HTMLElement>('details.cert-expand')!
      expect(within(expansion).getByText(/alpha\.example\.invalid/)).toBeTruthy()
      expect(within(expansion).getByText(/60d remaining/)).toBeTruthy()
    })

    // The qualifier must ALSO fire for `amber`, not only `red` -- an
    // expiring-soon sibling is just as actionable as a near-expiry one.
    it('also names the sibling when the worst is merely amber, not just red', () => {
      render(
        <FleetTable
          rows={[
            row({
              hostnames: [
                { hostname: 'alpha.example.invalid', listensTls: true },
                { hostname: 'beta.example.invalid', listensTls: true },
              ],
              primaryHostname: 'alpha.example.invalid',
              hostnameAnswers: [
                healthyHostnameAnswer({ certDaysRemaining: 60 }),
                healthyHostnameAnswer({ hostname: 'beta.example.invalid', certDaysRemaining: 15 }),
              ],
            }),
          ]}
        />,
      )
      const cell = screen.getByTestId('cert-cell')
      expect(cell.getAttribute('data-severity')).toBe('amber')
      expect(cell.childNodes[0]?.textContent).toBe('15d remaining (beta.example.invalid)')
    })

    // The ordinary case must not regress: when the worst hostname IS the
    // primary (or there is only one hostname at all), the text is
    // unchanged from before this round -- no qualifier, no parenthetical,
    // nothing added that the common case does not need.
    it('does not add a qualifier when the worst hostname is already the primary', () => {
      render(
        <FleetTable
          rows={[
            row({
              hostnames: oneHostname,
              primaryHostname: 'alpha.example.invalid',
              hostnameAnswers: [healthyHostnameAnswer({ certDaysRemaining: 3 })],
            }),
          ]}
        />,
      )
      const cell = screen.getByTestId('cert-cell')
      expect(cell.getAttribute('data-severity')).toBe('red')
      expect(cell.childNodes[0]?.textContent).toBe('3d remaining')
    })

    // `worstCertAnswer`'s own tie-break: when TWO siblings are both at the
    // worst severity (both red here), the MORE urgent one (fewer days) is
    // the one named, not merely whichever sits first in hostname order.
    it('names the MORE urgent sibling when two are tied at the same severity', () => {
      render(
        <FleetTable
          rows={[
            row({
              hostnames: [
                { hostname: 'alpha.example.invalid', listensTls: true },
                { hostname: 'beta.example.invalid', listensTls: true },
                { hostname: 'gamma.example.invalid', listensTls: true },
              ],
              primaryHostname: 'alpha.example.invalid',
              hostnameAnswers: [
                healthyHostnameAnswer({ certDaysRemaining: 60 }),
                healthyHostnameAnswer({ hostname: 'beta.example.invalid', certDaysRemaining: 5 }),
                healthyHostnameAnswer({ hostname: 'gamma.example.invalid', certDaysRemaining: 2 }),
              ],
            }),
          ]}
        />,
      )
      const collapsedText = screen.getByTestId('cert-cell').childNodes[0]?.textContent
      expect(collapsedText).toMatch(/2d remaining/)
      expect(collapsedText).toMatch(/gamma\.example\.invalid/)
      expect(collapsedText).not.toMatch(/5d remaining/)
    })

    it('still reads ok when every hostname is healthy and fresh -- the worst-of fold does not invent a problem', () => {
      render(
        <FleetTable
          rows={[
            row({
              hostnames: [
                { hostname: 'alpha.example.invalid', listensTls: true },
                { hostname: 'beta.example.invalid', listensTls: true },
              ],
              primaryHostname: 'alpha.example.invalid',
              hostnameAnswers: [
                healthyHostnameAnswer({ certDaysRemaining: 60 }),
                healthyHostnameAnswer({ hostname: 'beta.example.invalid', certDaysRemaining: 45 }),
              ],
            }),
          ]}
        />,
      )
      const cell = screen.getByTestId('cert-cell')
      expect(cell.getAttribute('data-severity')).toBe('ok')
      // THE DENIAL TEST for fix round 4's I5: on this fully ORDINARY row --
      // nothing wrong anywhere, a 45-day sibling is not remotely urgent --
      // the collapsed text must be the PRIMARY's own, unqualified figure.
      // Before this fix, "different from the primary" alone was enough to
      // trigger the qualifier, so this exact scenario rendered green
      // "45d remaining (beta.example.invalid)" -- naming an uninvolved
      // hostname, in the URL column's shadow, on a row where nothing
      // needed the operator's attention at all.
      expect(cell.childNodes[0]?.textContent).toBe('60d remaining')
    })

    // `unknown` must outrank `ok` in the worst-of fold, the same reasoning
    // `VERDICT_SEVERITY` gives for `unprobed`/`unconfirmed` outranking
    // `healthy`: a row must not read as fully fine (green) while one of its
    // hostnames' certificate status is simply unverified.
    it('reads unknown, not ok, when one hostname is healthy but a sibling has never been checked', () => {
      render(
        <FleetTable
          rows={[
            row({
              hostnames: [
                { hostname: 'alpha.example.invalid', listensTls: true },
                { hostname: 'beta.example.invalid', listensTls: true },
              ],
              primaryHostname: 'alpha.example.invalid',
              hostnameAnswers: [
                healthyHostnameAnswer({ certDaysRemaining: 60 }),
                healthyHostnameAnswer({
                  hostname: 'beta.example.invalid',
                  certDaysRemaining: null,
                  certExpiresAt: null,
                  externalOutcome: null,
                  externalAgeMs: null,
                }),
              ],
            }),
          ]}
        />,
      )
      expect(screen.getByTestId('cert-cell').getAttribute('data-severity')).toBe('unknown')
    })

    // THE DENIAL TEST for fix round 4's I4 (I6's first pin): `none` must
    // rank its OWN tier, strictly below `ok` -- a plain-HTTP-by-design
    // sibling must never hide a genuinely near-expiry certificate
    // elsewhere on the row. Before this fix, `ok`/`none` tied at the same
    // rank and `worstCertSeverity`'s reduce used strict `>`, so whichever
    // was FIRST in `hostnameAnswers` array order (itself downstream of an
    // unsorted `readdir` over vhost files) silently won the tie -- the
    // same system could render green or grey depending purely on file
    // order, and adding an unrelated plain-HTTP vhost to a system could
    // flip an EXISTING row's colour with no change to any certificate.
    // THE precise reproduction: `none` and `ok` are the pair that used to
    // TIE at rank 0. A `none`/`red` pair (a plain-HTTP sibling next to a
    // near-expiry one) was NEVER actually at risk -- `red` outranked `none`
    // either way -- so that pairing does not exercise this defect at all.
    // The order-dependent hazard only appears between two hostnames that
    // are BOTH otherwise "fine" (a verified healthy cert vs. nothing to
    // check): with `none` listed FIRST in `hostnameAnswers` (itself
    // downstream of an unsorted `readdir`), the OLD tied ranking made
    // `.reduce`'s strict `>` keep the FIRST element on a tie, so the row
    // rendered grey `"no TLS configured"` instead of the verified-healthy
    // hostname's own `"60d remaining"` -- with NO certificate problem
    // anywhere on the row. Reversing the array order used to flip the
    // answer; it must not, now.
    it('deterministically prefers the VERIFIED-healthy ("ok") hostname over a plain-HTTP one ("none") when they tie, regardless of array order', () => {
      render(
        <FleetTable
          rows={[
            row({
              hostnames: [
                { hostname: 'alpha.example.invalid', listensTls: false },
                { hostname: 'beta.example.invalid', listensTls: true },
              ],
              // `alpha` (none) is listed BEFORE `beta` (ok) -- the ordering
              // that exposed the old bug, since `.reduce` without ties
              // resolved keeps whichever element it saw FIRST.
              primaryHostname: 'beta.example.invalid',
              hostnameAnswers: [
                healthyHostnameAnswer({ hostname: 'alpha.example.invalid', listensTls: false, certDaysRemaining: null, certExpiresAt: null }),
                healthyHostnameAnswer({ hostname: 'beta.example.invalid', certDaysRemaining: 60 }),
              ],
            }),
          ]}
        />,
      )
      const cell = screen.getByTestId('cert-cell')
      expect(cell.getAttribute('data-severity')).toBe('ok')
      expect(cell.childNodes[0]?.textContent).toBe('60d remaining')
    })

    // M2: the cert-expansion's `data-severity` was purely decorative --
    // nothing in globals.css styled it, confirmed by the reviewer deleting
    // the attribute and watching all 797 tests stay green. jsdom in this
    // test environment does not apply external stylesheet rules, so the
    // only way to PIN that CSS coverage actually exists (as opposed to
    // merely re-asserting the DOM attribute, which is exactly what stayed
    // green before) is to read the stylesheet itself, the same way the
    // reviewer diagnosed the gap.
    it('has a CSS rule that actually colours each severity inside the cert expansion, not just on the collapsed cell', () => {
      const css = readFileSync(join(import.meta.dirname, '../app/globals.css'), 'utf8')
      for (const severity of ['red', 'amber', 'ok', 'unknown', 'none']) {
        expect(css).toMatch(new RegExp(`\\.cert-expand li\\[data-severity=['"]${severity}['"]\\]`))
      }
    })

    // THE DENIAL TEST for fix round 4's I6 (second pin): the round 2 test
    // above proves the CSS RULE exists for every severity value, but never
    // asserted that an expansion row's `data-severity` ATTRIBUTE actually
    // carries the CORRECT value for its own hostname -- it takes BOTH the
    // rule and the right attribute to colour anything. Hardcoding the
    // attribute to `"ok"` would still pass that CSS-coverage test.
    it('gives each expansion row its OWN computed severity, not a fixed value', () => {
      render(
        <FleetTable
          rows={[
            row({
              hostnames: [
                { hostname: 'alpha.example.invalid', listensTls: true },
                { hostname: 'beta.example.invalid', listensTls: true },
              ],
              primaryHostname: 'alpha.example.invalid',
              hostnameAnswers: [
                healthyHostnameAnswer({ certDaysRemaining: 60 }),
                healthyHostnameAnswer({ hostname: 'beta.example.invalid', certDaysRemaining: 2 }),
              ],
            }),
          ]}
        />,
      )
      const expansion = screen.getByTestId('cert-cell').querySelector<HTMLElement>('details.cert-expand')!
      const betaRow = within(expansion)
        .getAllByRole('listitem')
        .find((li) => li.textContent?.includes('beta'))!
      const alphaRow = within(expansion)
        .getAllByRole('listitem')
        .find((li) => li.textContent?.includes('alpha'))!
      expect(betaRow.getAttribute('data-severity')).toBe('red')
      expect(alphaRow.getAttribute('data-severity')).toBe('ok')
    })

    // M1: staleness/fleet-wide suppression nulls `externalOutcome`
    // identically to "never checked" -- but `externalAgeMs` (fixed in I1 to
    // stay populated) is what lets the label tell them apart. A result
    // checked 9 days ago is a DIFFERENT sentence from one never checked at
    // all, even though neither currently counts as a trusted opinion.
    it('says a certificate was checked before, just not recently enough to trust, rather than claiming it was never checked', () => {
      render(
        <FleetTable
          rows={[
            row({
              hostnames: oneHostname,
              primaryHostname: 'alpha.example.invalid',
              tlsConfigured: true,
              certDaysRemaining: null,
              hostnameAnswers: [
                healthyHostnameAnswer({
                  certDaysRemaining: null,
                  certExpiresAt: null,
                  externalOutcome: null,
                  externalAgeMs: 9 * 24 * 60 * 60_000,
                }),
              ],
            }),
          ]}
        />,
      )
      const cell = screen.getByTestId('cert-cell')
      expect(within(cell).queryByText(/not checked yet/i)).toBeNull()
      expect(within(cell).getByText(/last checked 9d ago, no longer current/i)).toBeTruthy()
    })

    // THE DENIAL TEST for fix round 4's C2, at the component level (the
    // query-layer version lives in fleet-query.test.ts): a REAL
    // days-remaining figure, checked 9 days ago (stale) or during a
    // fleet-wide failure, must still be SHOWN -- with its provenance
    // stated, not hidden behind the "not checked"/"no longer current"
    // wording certLabel uses when there is no figure at all.
    it('shows a stale certificate figure WITH its provenance, never hiding it the way a fleet-wide failure or the staleness ceiling used to', () => {
      render(
        <FleetTable
          rows={[
            row({
              hostnames: oneHostname,
              primaryHostname: 'alpha.example.invalid',
              tlsConfigured: true,
              certDaysRemaining: 3,
              hostnameAnswers: [
                healthyHostnameAnswer({
                  certDaysRemaining: 3,
                  externalOutcome: null,
                  externalAgeMs: 9 * 24 * 60 * 60_000,
                }),
              ],
            }),
          ]}
        />,
      )
      const cell = screen.getByTestId('cert-cell')
      expect(within(cell).queryByText(/no longer current/i)).toBeNull()
      expect(within(cell).queryByText(/not checked yet/i)).toBeNull()
      expect(within(cell).getByText(/3d remaining, from a check 9d ago/i)).toBeTruthy()
      // The severity must ALSO survive -- a 3-day certificate reads red,
      // never grey, even while its own reading is not current.
      expect(cell.getAttribute('data-severity')).toBe('red')
    })

    it('does not add a provenance clause to an ORDINARY, current certificate reading', () => {
      render(
        <FleetTable
          rows={[
            row({
              hostnames: oneHostname,
              primaryHostname: 'alpha.example.invalid',
              tlsConfigured: true,
              certDaysRemaining: 60,
              hostnameAnswers: [healthyHostnameAnswer({ certDaysRemaining: 60 })],
            }),
          ]}
        />,
      )
      expect(screen.getByTestId('cert-cell').childNodes[0]?.textContent).toBe('60d remaining')
    })

    it('still says "not checked yet" when there is truly no age at all -- distinct from the stale case above', () => {
      render(
        <FleetTable
          rows={[
            row({
              hostnames: oneHostname,
              primaryHostname: 'alpha.example.invalid',
              tlsConfigured: true,
              certDaysRemaining: null,
              hostnameAnswers: [
                healthyHostnameAnswer({
                  certDaysRemaining: null,
                  certExpiresAt: null,
                  externalOutcome: null,
                  externalAgeMs: null,
                }),
              ],
            }),
          ]}
        />,
      )
      const cell = screen.getByTestId('cert-cell')
      expect(within(cell).getByText(/not checked yet/i)).toBeTruthy()
      expect(within(cell).queryByText(/no longer current/i)).toBeNull()
    })
  })

  // Spec §9: "A fleet-wide external failure is a probe fault, not twenty
  // outages ... the board says the dashboard could not reach anything and
  // falls back to displaying on-box results -- it must NOT turn every row
  // red." Fix round 1 (Task 8 review), C2b: the banner is now driven by a
  // run-level record (`lastExternalSweep`), not an inference over
  // per-hostname rows, and its wording says how long ago the sweep ran
  // rather than claiming "this cycle" when the data cannot support it.
  describe('the fleet-wide external-failure banner (spec §9)', () => {
    it('shows a probe-side banner naming how long ago the sweep ran, instead of reddening every row', () => {
      render(
        <FleetTable
          rows={[row({ verdict: 'healthy' })]}
          lastExternalSweep={{ reachedAnything: false, ageMs: 4 * 60_000 }}
        />,
      )
      expect(screen.getByText(/reached nothing/i)).toBeTruthy()
      expect(screen.getByText(/4m ago/)).toBeTruthy()
      expect(screen.queryByText(/this cycle/i)).toBeNull()
      // The banner does not itself repaint a row -- a healthy row (as
      // fleet-query.ts would have ALREADY computed it, falling back to
      // on-box evidence) still reads healthy underneath the banner.
      expect(within(screen.getByTestId('answers-cell')).getByText(/^healthy$/i)).toBeTruthy()
    })

    it('shows no banner when the last sweep reached something', () => {
      render(
        <FleetTable
          rows={[row({ verdict: 'healthy' })]}
          lastExternalSweep={{ reachedAnything: true, ageMs: 4 * 60_000 }}
        />,
      )
      expect(screen.queryByText(/reached nothing/i)).toBeNull()
    })

    it('shows no banner at all when no sweep has ever run', () => {
      render(<FleetTable rows={[row({ verdict: 'healthy' })]} lastExternalSweep={null} />)
      expect(screen.queryByText(/reached nothing/i)).toBeNull()
    })

    it('shows no banner when the prop is simply omitted', () => {
      render(<FleetTable rows={[row({ verdict: 'healthy' })]} />)
      expect(screen.queryByText(/reached nothing/i)).toBeNull()
    })

    // Minor 2 (Task 8 review): the banner must survive the empty-board
    // early return, since it is a fact about the DASHBOARD's own probing,
    // independent of whether any system happens to be enrolled.
    it('still shows the banner on an empty board, alongside the "no systems" message', () => {
      render(<FleetTable rows={[]} lastExternalSweep={{ reachedAnything: false, ageMs: 60_000 }} />)
      expect(screen.getByText(/reached nothing/i)).toBeTruthy()
      expect(screen.getByText(/no systems reported/i)).toBeTruthy()
    })
  })
})
