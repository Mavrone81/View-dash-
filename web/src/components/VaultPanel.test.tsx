// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, within, fireEvent, waitFor, act } from '@testing-library/react'

// The actions module is a Next.js server-action layer ('use server') that
// talks to a real Postgres-backed vault (see actions.test.ts, which exercises
// it directly). VaultPanel must never depend on any of that in a unit test --
// mocking it here means this suite proves the PANEL's behaviour given a
// result shape, not that the real actions produce that shape (actions.test.ts
// already covers that). See the report for what this leaves uncovered.
vi.mock('../app/vault/actions.js', () => ({
  createVaultAction: vi.fn(),
  unlockAction: vi.fn(),
  unlockWithRecoveryAction: vi.fn(),
  lockAction: vi.fn(),
  addCredentialAction: vi.fn(),
  revealAction: vi.fn(),
  removeCredentialAction: vi.fn(),
  changePassphraseAction: vi.fn(),
}))

import {
  createVaultAction,
  unlockAction,
  lockAction,
  addCredentialAction,
  revealAction,
  removeCredentialAction,
  changePassphraseAction,
} from '../app/vault/actions.js'
import { VaultPanel } from './VaultPanel.js'

const cred = (over = {}) => ({
  id: 'c1', label: 'admin', username: 'operator', notes: null,
  hostId: 'h1', systemKey: 'alpha', rotatedAt: null, ...over,
})

beforeEach(() => {
  vi.mocked(createVaultAction).mockReset()
  vi.mocked(unlockAction).mockReset()
  vi.mocked(lockAction).mockReset()
  vi.mocked(addCredentialAction).mockReset()
  vi.mocked(revealAction).mockReset()
  vi.mocked(removeCredentialAction).mockReset()
  vi.mocked(changePassphraseAction).mockReset()
})

describe('VaultPanel', () => {
  it('says the vault is not set up when it is uninitialised', () => {
    render(<VaultPanel initialised={false} unlocked={false} credentials={[]} />)
    expect(screen.getByText(/set up the vault/i)).toBeTruthy()
  })

  // --- Resolution 1: `/locked/i` is a substring of "Unlocked" and does not
  // discriminate -- verified by mutation (see task-8-report.md): rendering
  // the unlocked branch unconditionally still passes an assertion written
  // as `screen.getByText(/locked/i)`. This version cannot pass that way: it
  // exact-matches the word "Locked" (which "Unlocked" is not equal to,
  // whole-string), explicitly rules out "Unlocked" being present at all,
  // and asserts on the one behaviour that actually matters -- no reveal
  // control anywhere and no way to see a secret while locked.
  it('says Locked -- exactly, not as a substring of "Unlocked" -- and offers no way to see a secret', () => {
    render(<VaultPanel initialised unlocked={false} credentials={[cred()]} />)
    expect(screen.getByText('Locked', { exact: true })).toBeTruthy()
    expect(screen.queryByText('Unlocked', { exact: true })).toBeNull()
    expect(screen.queryByText(/^unlocked$/i)).toBeNull()
    // The unlock control must be present...
    expect(screen.getByRole('button', { name: /^unlock$/i })).toBeTruthy()
    // ...and no reveal control, and no "Lock now" (which only makes sense
    // once unlocked), anywhere on the page.
    expect(screen.queryByRole('button', { name: /reveal/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /^lock now$/i })).toBeNull()
    // An empty field would read as "no credential stored" -- a different,
    // false fact from "locked".
    expect(screen.queryByText('—')).toBeNull()
  })

  // Fix round 1: the brief's/task-8's original version of this test rendered
  // `cred()`, which has no secret field at all -- so no implementation,
  // buggy or not, could ever make 'hunter2' appear from `credentials` alone.
  // It could not fail and was removed rather than kept as a paper trail
  // (git history and this comment are the record). The real coverage is
  // below, in "revealing a secret": a MOCKED reveal action returns a KNOWN
  // secret, and its absence before the click is asserted against that real
  // value.

  it('shows unattached credentials, clearly labelled, rather than hiding them', () => {
    render(<VaultPanel initialised unlocked credentials={[cred({ hostId: null, systemKey: null })]} />)
    expect(screen.getByText(/not attached to a system/i)).toBeTruthy()
  })

  it('renders an empty state rather than an empty list', () => {
    render(<VaultPanel initialised unlocked credentials={[]} />)
    expect(screen.getByText(/no credentials stored yet/i)).toBeTruthy()
  })

  it('groups credentials by system and lists unattached ones last, clearly labelled', () => {
    render(
      <VaultPanel
        initialised
        unlocked
        credentials={[
          cred({ id: 'c1', label: 'db', hostId: 'h1', systemKey: 'alpha' }),
          cred({ id: 'c2', label: 'orphan', hostId: null, systemKey: null }),
        ]}
        systemLabels={{ 'h1::alpha': { hostName: 'host-one', systemName: 'alpha' } }}
      />,
    )
    const headings = screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent ?? '')
    const alphaIdx = headings.findIndex((h) => h.includes('alpha'))
    const unattachedIdx = headings.findIndex((h) => h === 'Not attached to a system')
    expect(alphaIdx).toBeGreaterThanOrEqual(0)
    expect(unattachedIdx).toBeGreaterThan(alphaIdx)
  })

  // Fix round 1, "resolve display names": a credential can outlive its
  // system by design (see credentials.ts), so a hostId/systemKey pair with
  // no entry in `systemLabels` is a NORMAL, expected state, not corruption.
  it('an attached credential whose system no longer exists reads as unattached, not under a raw-id heading', () => {
    render(
      <VaultPanel
        initialised
        unlocked
        credentials={[cred({ id: 'c1', label: 'ghost-cred', hostId: 'h1', systemKey: 'deleted-system' })]}
        systemLabels={{}}
      />,
    )
    expect(screen.getByText('Not attached to a system')).toBeTruthy()
    const headings = screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent ?? '')
    // No heading should be built from the raw, meaningless-to-a-human ids --
    // that would read as broken data rather than "we no longer know where
    // this belongs".
    expect(headings.some((h) => h.includes('h1'))).toBe(false)
    expect(headings.some((h) => h.includes('deleted-system'))).toBe(false)
  })

  it('Lock now is always available while unlocked', () => {
    render(<VaultPanel initialised unlocked credentials={[]} />)
    expect(screen.getByRole('button', { name: /^lock now$/i })).toBeTruthy()
  })

  // --- Resolution 2: the core interaction (reveal) has its own coverage ---
  describe('revealing a secret', () => {
    it('is absent until Reveal is clicked, calls the reveal action, and then shows the returned secret', async () => {
      vi.mocked(revealAction).mockResolvedValue({ ok: true, secret: 'hunter2' })
      render(<VaultPanel initialised unlocked credentials={[cred()]} />)
      // Proved against a REAL value the mock will return, not merely against
      // a hardcoded string this panel was never given (that was the gap in
      // the brief's original version of this assertion).
      expect(screen.queryByText('hunter2')).toBeNull()
      expect(revealAction).not.toHaveBeenCalled()

      fireEvent.click(screen.getByTestId('reveal-c1'))

      expect(await screen.findByText('hunter2')).toBeTruthy()
      expect(revealAction).toHaveBeenCalledWith('c1')
      expect(revealAction).toHaveBeenCalledTimes(1)
    })

    it('revealing one credential does not reveal another', async () => {
      vi.mocked(revealAction).mockImplementation(async (id: string) =>
        id === 'c1' ? { ok: true, secret: 'secret-one' } : { ok: true, secret: 'secret-two' },
      )
      render(
        <VaultPanel
          initialised
          unlocked
          credentials={[cred({ id: 'c1', label: 'first' }), cred({ id: 'c2', label: 'second' })]}
        />,
      )

      fireEvent.click(screen.getByTestId('reveal-c1'))
      expect(await screen.findByText('secret-one')).toBeTruthy()

      // c2's own row must still show its Reveal control, not c1's secret --
      // scoped to the row so this cannot pass by accident from a shared,
      // un-keyed piece of state.
      const rowC2 = screen.getByTestId('credential-row-c2')
      expect(within(rowC2).queryByText('secret-one')).toBeNull()
      expect(within(rowC2).getByTestId('reveal-c2')).toBeTruthy()
      expect(screen.queryByText('secret-two')).toBeNull()
      expect(revealAction).toHaveBeenCalledTimes(1)
    })

    it('shows the failure message and no secret when reveal fails', async () => {
      vi.mocked(revealAction).mockResolvedValue({
        ok: false,
        message: 'This credential could not be decrypted and is unreadable.',
      })
      render(<VaultPanel initialised unlocked credentials={[cred()]} />)

      fireEvent.click(screen.getByTestId('reveal-c1'))

      expect(await screen.findByText(/could not be decrypted/i)).toBeTruthy()
      expect(screen.queryByTestId('secret-c1')).toBeNull()
      // The row must still offer Reveal again -- a failed attempt is not a
      // dead end.
      expect(screen.getByTestId('reveal-c1')).toBeTruthy()
    })
  })

  // --- Fix round 1: the coordinator's ruling on design spec section 8
  // ("Reveal shows one credential at a time, transiently") -- the stricter
  // reading. Only one plaintext secret may be visible at any moment, and an
  // individual reveal hides itself after a short interval even with no
  // other action taken. Both use fake timers: `revealAction`'s mocked
  // promise resolves on the microtask queue, which `vi.advanceTimersByTimeAsync`
  // flushes correctly (plain `vi.advanceTimersByTime` does not await
  // in-flight promises between ticks and was confirmed NOT to work here
  // during prototyping).
  describe('exposure limits on a revealed secret (fix round 1)', () => {
    beforeEach(() => {
      vi.useFakeTimers()
    })
    afterEach(() => {
      vi.useRealTimers()
    })

    it('revealing a second credential hides the first', async () => {
      vi.mocked(revealAction).mockImplementation(async (id: string) =>
        id === 'c1' ? { ok: true, secret: 'secret-one' } : { ok: true, secret: 'secret-two' },
      )
      render(
        <VaultPanel
          initialised
          unlocked
          credentials={[cred({ id: 'c1', label: 'first' }), cred({ id: 'c2', label: 'second' })]}
        />,
      )

      await act(async () => {
        fireEvent.click(screen.getByTestId('reveal-c1'))
        await vi.advanceTimersByTimeAsync(0)
      })
      expect(screen.getByText('secret-one')).toBeTruthy()

      await act(async () => {
        fireEvent.click(screen.getByTestId('reveal-c2'))
        await vi.advanceTimersByTimeAsync(0)
      })
      expect(screen.queryByText('secret-one')).toBeNull()
      expect(screen.getByText('secret-two')).toBeTruthy()
      // c1's row goes back to offering Reveal -- it is not a dead row.
      expect(within(screen.getByTestId('credential-row-c1')).getByTestId('reveal-c1')).toBeTruthy()
    })

    it('a revealed secret hides itself after a short interval, with no other action taken', async () => {
      vi.mocked(revealAction).mockResolvedValue({ ok: true, secret: 'hunter2' })
      render(<VaultPanel initialised unlocked credentials={[cred()]} />)

      await act(async () => {
        fireEvent.click(screen.getByTestId('reveal-c1'))
        await vi.advanceTimersByTimeAsync(0)
      })
      expect(screen.getByText('hunter2')).toBeTruthy()

      await act(async () => {
        await vi.advanceTimersByTimeAsync(20_001)
      })
      expect(screen.queryByText('hunter2')).toBeNull()
      // Reveal is offered again -- auto-hide is not a dead end either.
      expect(screen.getByTestId('reveal-c1')).toBeTruthy()
    })
  })

  // --- Fix round 1: "a revealed secret outlives the auto-lock". The panel
  // must clear any revealed secret and show Locked once the session
  // deadline passes, without relying on a further reveal attempt to notice
  // -- a timer alone is not enough (background-tab throttling, a suspended
  // laptop), so visibilitychange/focus are also covered.
  //
  // `sessionRemainingMs` is a DURATION (fix round 2 renamed this prop from
  // `sessionExpiresAt`, an absolute instant -- see task-8-report.md "Fix
  // round 2" for why). With `vi.setSystemTime(0)` in `beforeEach` below, a
  // duration of 5000 and an absolute instant of 5000 land on the identical
  // local deadline, so these tests' numbers did not need to change, only
  // the prop name and what it now means.
  describe('auto-lock at the session deadline (fix round 1)', () => {
    beforeEach(() => {
      vi.useFakeTimers()
      vi.setSystemTime(0)
    })
    afterEach(() => {
      vi.useRealTimers()
    })

    it('clears a revealed secret and shows Locked once the deadline passes, via its own timer', async () => {
      vi.mocked(revealAction).mockResolvedValue({ ok: true, secret: 'hunter2' })
      // A short deadline (5s), well under the 20s reveal auto-hide interval,
      // so what clears the secret here can only be the session-expiry path,
      // not the unrelated per-reveal auto-hide timer.
      render(<VaultPanel initialised unlocked credentials={[cred()]} sessionRemainingMs={5000} />)

      await act(async () => {
        fireEvent.click(screen.getByTestId('reveal-c1'))
        await vi.advanceTimersByTimeAsync(0)
      })
      expect(screen.getByText('hunter2')).toBeTruthy()

      await act(async () => {
        await vi.advanceTimersByTimeAsync(5001)
      })
      expect(screen.getByText('Locked', { exact: true })).toBeTruthy()
      expect(screen.queryByText('hunter2')).toBeNull()
    })

    it('re-checks the deadline on visibilitychange even if its own timer has not fired', async () => {
      vi.mocked(revealAction).mockResolvedValue({ ok: true, secret: 'hunter2' })
      render(<VaultPanel initialised unlocked credentials={[cred()]} sessionRemainingMs={5000} />)

      await act(async () => {
        fireEvent.click(screen.getByTestId('reveal-c1'))
        await vi.advanceTimersByTimeAsync(0)
      })
      expect(screen.getByText('hunter2')).toBeTruthy()

      // Simulate a laptop suspended past the deadline: the wall clock jumps,
      // but the JS timer queue does not advance on its own (no
      // advanceTimersByTime call) -- only a visibilitychange/focus event
      // resuming the tab can notice.
      vi.setSystemTime(6000)
      await act(async () => {
        document.dispatchEvent(new Event('visibilitychange'))
      })

      expect(screen.getByText('Locked', { exact: true })).toBeTruthy()
      expect(screen.queryByText('hunter2')).toBeNull()
    })

    it('re-checks the deadline on window focus', async () => {
      vi.mocked(revealAction).mockResolvedValue({ ok: true, secret: 'hunter2' })
      render(<VaultPanel initialised unlocked credentials={[cred()]} sessionRemainingMs={5000} />)

      await act(async () => {
        fireEvent.click(screen.getByTestId('reveal-c1'))
        await vi.advanceTimersByTimeAsync(0)
      })
      expect(screen.getByText('hunter2')).toBeTruthy()

      vi.setSystemTime(6000)
      await act(async () => {
        window.dispatchEvent(new Event('focus'))
      })

      expect(screen.getByText('Locked', { exact: true })).toBeTruthy()
      expect(screen.queryByText('hunter2')).toBeNull()
    })

    it('does not lock early -- a secret survives right up to, but not past, the deadline', async () => {
      vi.mocked(revealAction).mockResolvedValue({ ok: true, secret: 'hunter2' })
      render(<VaultPanel initialised unlocked credentials={[cred()]} sessionRemainingMs={5000} />)

      await act(async () => {
        fireEvent.click(screen.getByTestId('reveal-c1'))
        await vi.advanceTimersByTimeAsync(0)
      })

      await act(async () => {
        await vi.advanceTimersByTimeAsync(4000)
      })
      expect(screen.getByText('hunter2')).toBeTruthy()
      expect(screen.getByText('Unlocked', { exact: true })).toBeTruthy()
    })

    // --- Fix round 2: the window disclosed in the fix round 1 report.
    // A client-driven unlock flips `localUnlocked` to true immediately, but
    // (before this fix) the deadline used to come ONLY from the
    // `sessionRemainingMs` PROP, which only updates on the NEXT server
    // render -- so a secret revealed in the gap had no deadline scheduled
    // against it at all, and would never auto-clear. This is the exact case
    // the coordinator asked to be proven failing before the fix.
    it('a secret revealed immediately after a client-driven unlock -- with no intervening server render -- still clears at the deadline', async () => {
      vi.mocked(unlockAction).mockResolvedValue({ ok: true, sessionRemainingMs: 5000 })
      vi.mocked(revealAction).mockResolvedValue({ ok: true, secret: 'hunter2' })

      // No `sessionRemainingMs` prop at all: this is what a page that loaded
      // locked looks like (there is no session to report a duration for).
      // The unlock below happens ENTIRELY client-side; this prop is never
      // supplied a value at any point in this test, so the only possible
      // source of a deadline is `unlockAction`'s own return value.
      render(<VaultPanel initialised unlocked={false} credentials={[cred()]} />)

      await act(async () => {
        fireEvent.change(screen.getByLabelText(/^passphrase$/i), { target: { value: 'right passphrase' } })
        fireEvent.click(screen.getByRole('button', { name: /^unlock$/i }))
        await vi.advanceTimersByTimeAsync(0)
      })
      expect(screen.getByText('Unlocked', { exact: true })).toBeTruthy()

      await act(async () => {
        fireEvent.click(screen.getByTestId('reveal-c1'))
        await vi.advanceTimersByTimeAsync(0)
      })
      expect(screen.getByText('hunter2')).toBeTruthy()

      await act(async () => {
        await vi.advanceTimersByTimeAsync(5001)
      })
      expect(screen.getByText('Locked', { exact: true })).toBeTruthy()
      expect(screen.queryByText('hunter2')).toBeNull()
    })

    // Same gap, for the OTHER action that leaves the vault unlocked
    // (createVaultAction calls unlockSession internally too).
    it('arms the auto-lock from createVaultAction\'s own result, with no credentials involved yet', async () => {
      vi.mocked(createVaultAction).mockResolvedValue({
        ok: true,
        recoveryKey: 'RK-EXAMPLE-VALUE',
        sessionRemainingMs: 5000,
      })
      render(<VaultPanel initialised={false} unlocked={false} credentials={[]} />)

      await act(async () => {
        fireEvent.change(screen.getByLabelText(/passphrase/i), { target: { value: 'a very long passphrase' } })
        fireEvent.click(screen.getByRole('button', { name: /^create vault$/i }))
        await vi.advanceTimersByTimeAsync(0)
      })
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /i have stored it/i }))
      })
      expect(screen.getByText('Unlocked', { exact: true })).toBeTruthy()

      await act(async () => {
        await vi.advanceTimersByTimeAsync(5001)
      })
      expect(screen.getByText('Locked', { exact: true })).toBeTruthy()
    })
  })

  describe('locking clears a previously revealed secret', () => {
    it('Lock now hides a revealed secret and returns to the Locked view', async () => {
      vi.mocked(revealAction).mockResolvedValue({ ok: true, secret: 'hunter2' })
      vi.mocked(lockAction).mockResolvedValue({ ok: true })
      render(<VaultPanel initialised unlocked credentials={[cred()]} />)

      fireEvent.click(screen.getByTestId('reveal-c1'))
      await screen.findByText('hunter2')

      fireEvent.click(screen.getByRole('button', { name: /^lock now$/i }))

      await waitFor(() => expect(screen.getByText('Locked', { exact: true })).toBeTruthy())
      expect(screen.queryByText('hunter2')).toBeNull()
    })
  })

  // --- Resolution 3: the board link must never land on a dead end ---
  describe('linking in from the board for a specific system', () => {
    it('offers to add a credential, pre-attached to the focused system, when it has none', () => {
      render(<VaultPanel initialised unlocked credentials={[]} focusHostId="h9" focusSystemKey="beta" />)
      expect(screen.getByRole('button', { name: /^add credential$/i })).toBeTruthy()
    })

    it('does not offer an add control while locked -- never a dead control', () => {
      render(
        <VaultPanel initialised unlocked={false} credentials={[]} focusHostId="h9" focusSystemKey="beta" />,
      )
      expect(screen.queryByRole('button', { name: /add credential/i })).toBeNull()
      expect(screen.getByText(/unlock the vault to add one/i)).toBeTruthy()
    })

    // --- Task 10 / finding C1. This test used to assert the OPPOSITE, and
    // in doing so certified the defect as intended behaviour: the only add
    // form in the product was gated on the focused system having ZERO
    // credentials, so it vanished the moment it was used. Design spec
    // section 4.2 names the database password, the SMTP credential and the
    // API key for one system as the reason a single model covers any
    // credential type -- and after storing the first of those, the other two
    // could never be stored at all. Rewritten, not deleted: the scenario is
    // the right one, the expectation was wrong.
    it('still offers to add when the focused system already has a credential -- one system, several credentials', async () => {
      vi.mocked(addCredentialAction).mockResolvedValue({ ok: true, id: 'new-2' })
      render(
        <VaultPanel
          initialised
          unlocked
          credentials={[cred({ id: 'c1', label: 'admin login', hostId: 'h9', systemKey: 'beta' })]}
          focusHostId="h9"
          focusSystemKey="beta"
        />,
      )
      expect(screen.getByRole('button', { name: /^add credential$/i })).toBeTruthy()

      fireEvent.change(screen.getByLabelText(/^label$/i), { target: { value: 'database password' } })
      fireEvent.change(screen.getByLabelText(/^username$/i), { target: { value: 'dbuser' } })
      fireEvent.change(screen.getByLabelText(/^secret$/i), { target: { value: 'x' } })
      fireEvent.click(screen.getByRole('button', { name: /^add credential$/i }))

      await waitFor(() =>
        expect(addCredentialAction).toHaveBeenCalledWith({
          label: 'database password',
          username: 'dbuser',
          secret: 'x',
          hostId: 'h9',
          systemKey: 'beta',
        }),
      )
      // Both now exist, attached to the same system -- the state the old
      // behaviour made unreachable.
      expect(await screen.findByTestId('reveal-new-2')).toBeTruthy()
      expect(screen.getByTestId('reveal-c1')).toBeTruthy()
    })

    it('adding a credential for the focused system attaches it, and it is then revealable', async () => {
      vi.mocked(addCredentialAction).mockResolvedValue({ ok: true, id: 'new-1' })
      render(<VaultPanel initialised unlocked credentials={[]} focusHostId="h9" focusSystemKey="beta" />)

      fireEvent.change(screen.getByLabelText(/^label$/i), { target: { value: 'root' } })
      fireEvent.change(screen.getByLabelText(/^username$/i), { target: { value: 'admin' } })
      fireEvent.change(screen.getByLabelText(/^secret$/i), { target: { value: 'x' } })
      fireEvent.click(screen.getByRole('button', { name: /^add credential$/i }))

      await waitFor(() =>
        expect(addCredentialAction).toHaveBeenCalledWith({
          label: 'root',
          username: 'admin',
          secret: 'x',
          hostId: 'h9',
          systemKey: 'beta',
        }),
      )
      expect(await screen.findByTestId('reveal-new-1')).toBeTruthy()
    })
  })

  // --- Task 10 / finding C1: the add path must not depend on how the page
  // was reached. Opening /vault directly offered no add control at ALL, so an
  // unattached credential -- which design spec section 8 requires the page to
  // list -- could never be created through the product. ---
  describe('adding a credential without coming from the board (C1)', () => {
    it('offers an add control on a direct visit, with no focused system', () => {
      render(<VaultPanel initialised unlocked credentials={[]} />)
      expect(screen.getByRole('button', { name: /^add credential$/i })).toBeTruthy()
    })

    it('offers no add control while locked, on a direct visit -- never a dead control', () => {
      render(<VaultPanel initialised unlocked={false} credentials={[]} />)
      expect(screen.queryByRole('button', { name: /add credential/i })).toBeNull()
    })

    it('creates an UNATTACHED credential when no system is chosen', async () => {
      vi.mocked(addCredentialAction).mockResolvedValue({ ok: true, id: 'new-3' })
      render(<VaultPanel initialised unlocked credentials={[]} />)

      fireEvent.change(screen.getByLabelText(/^label$/i), { target: { value: 'shared api key' } })
      fireEvent.change(screen.getByLabelText(/^username$/i), { target: { value: 'service' } })
      fireEvent.change(screen.getByLabelText(/^secret$/i), { target: { value: 'x' } })
      fireEvent.click(screen.getByRole('button', { name: /^add credential$/i }))

      // No hostId and no systemKey at all: "absent" is what makes it
      // unattached, and passing either as a placeholder would attach it to
      // something that does not exist.
      await waitFor(() =>
        expect(addCredentialAction).toHaveBeenCalledWith({
          label: 'shared api key',
          username: 'service',
          secret: 'x',
        }),
      )
      expect(await screen.findByText('Not attached to a system')).toBeTruthy()
    })

    it('can attach to any system on the board, not only the one linked in from', async () => {
      vi.mocked(addCredentialAction).mockResolvedValue({ ok: true, id: 'new-4' })
      render(
        <VaultPanel
          initialised
          unlocked
          credentials={[]}
          systemLabels={{
            'h1::alpha': { hostName: 'host-one', systemName: 'alpha' },
            'h2::gamma': { hostName: 'host-two', systemName: 'gamma' },
          }}
        />,
      )

      fireEvent.change(screen.getByLabelText(/^label$/i), { target: { value: 'smtp' } })
      fireEvent.change(screen.getByLabelText(/^username$/i), { target: { value: 'mailer' } })
      fireEvent.change(screen.getByLabelText(/^secret$/i), { target: { value: 'x' } })
      fireEvent.change(screen.getByLabelText(/^attach to$/i), { target: { value: 'h2::gamma' } })
      fireEvent.click(screen.getByRole('button', { name: /^add credential$/i }))

      await waitFor(() =>
        expect(addCredentialAction).toHaveBeenCalledWith({
          label: 'smtp',
          username: 'mailer',
          secret: 'x',
          hostId: 'h2',
          systemKey: 'gamma',
        }),
      )
    })

    it('can create an UNATTACHED credential even when the page was reached from a board row', async () => {
      vi.mocked(addCredentialAction).mockResolvedValue({ ok: true, id: 'new-5' })
      render(<VaultPanel initialised unlocked credentials={[]} focusHostId="h9" focusSystemKey="beta" />)

      fireEvent.change(screen.getByLabelText(/^label$/i), { target: { value: 'unrelated' } })
      fireEvent.change(screen.getByLabelText(/^username$/i), { target: { value: 'someone' } })
      fireEvent.change(screen.getByLabelText(/^secret$/i), { target: { value: 'x' } })
      fireEvent.change(screen.getByLabelText(/^attach to$/i), { target: { value: '' } })
      fireEvent.click(screen.getByRole('button', { name: /^add credential$/i }))

      await waitFor(() =>
        expect(addCredentialAction).toHaveBeenCalledWith({
          label: 'unrelated',
          username: 'someone',
          secret: 'x',
        }),
      )
    })

    it('shows the failure message and stores nothing when the add fails', async () => {
      vi.mocked(addCredentialAction).mockResolvedValue({ ok: false, message: 'Could not save the credential.' })
      render(<VaultPanel initialised unlocked credentials={[]} />)

      fireEvent.change(screen.getByLabelText(/^label$/i), { target: { value: 'x' } })
      fireEvent.change(screen.getByLabelText(/^username$/i), { target: { value: 'y' } })
      fireEvent.change(screen.getByLabelText(/^secret$/i), { target: { value: 'z' } })
      fireEvent.click(screen.getByRole('button', { name: /^add credential$/i }))

      expect(await screen.findByText(/could not save the credential/i)).toBeTruthy()
      expect(screen.getByText('No credentials stored yet.')).toBeTruthy()
    })
  })

  // --- Task 10 / finding C1: removeCredentialAction was exported, tested and
  // called from nowhere. Deleting a stored production password is
  // irreversible and there is no undo anywhere in this design, so a single
  // click must never be enough. ---
  describe('removing a credential (C1)', () => {
    it('a single click does not delete -- it asks first', () => {
      render(<VaultPanel initialised unlocked credentials={[cred()]} />)

      fireEvent.click(screen.getByTestId('remove-c1'))

      // The action must NOT have been called by the first click. This is the
      // whole requirement: one click away from destroying a production
      // password is one click too few.
      expect(removeCredentialAction).not.toHaveBeenCalled()
      expect(screen.getByTestId('confirm-remove-c1')).toBeTruthy()
      expect(screen.getByText(/no undo/i)).toBeTruthy()
      // ...and the credential is still listed.
      expect(screen.getByTestId('credential-row-c1')).toBeTruthy()
    })

    it('confirming deletes it and drops it from the list', async () => {
      vi.mocked(removeCredentialAction).mockResolvedValue({ ok: true })
      render(<VaultPanel initialised unlocked credentials={[cred()]} />)

      fireEvent.click(screen.getByTestId('remove-c1'))
      fireEvent.click(screen.getByTestId('confirm-remove-c1'))

      await waitFor(() => expect(removeCredentialAction).toHaveBeenCalledWith('c1'))
      await waitFor(() => expect(screen.queryByTestId('credential-row-c1')).toBeNull())
    })

    it('backing out of the confirmation deletes nothing and restores the row', () => {
      render(<VaultPanel initialised unlocked credentials={[cred()]} />)

      fireEvent.click(screen.getByTestId('remove-c1'))
      fireEvent.click(screen.getByTestId('cancel-remove-c1'))

      expect(removeCredentialAction).not.toHaveBeenCalled()
      expect(screen.getByTestId('remove-c1')).toBeTruthy()
      expect(screen.queryByTestId('confirm-remove-c1')).toBeNull()
    })

    it('confirming one row does not arm the confirmation on another', () => {
      render(
        <VaultPanel
          initialised
          unlocked
          credentials={[cred({ id: 'c1', label: 'first' }), cred({ id: 'c2', label: 'second' })]}
        />,
      )

      fireEvent.click(screen.getByTestId('remove-c1'))

      expect(screen.getByTestId('confirm-remove-c1')).toBeTruthy()
      expect(screen.queryByTestId('confirm-remove-c2')).toBeNull()
      expect(within(screen.getByTestId('credential-row-c2')).getByTestId('remove-c2')).toBeTruthy()
    })

    it('keeps the credential listed, with the reason, when the delete fails', async () => {
      vi.mocked(removeCredentialAction).mockResolvedValue({
        ok: false,
        message: 'The vault is locked. Unlock it and try again.',
      })
      render(<VaultPanel initialised unlocked credentials={[cred()]} />)

      fireEvent.click(screen.getByTestId('remove-c1'))
      fireEvent.click(screen.getByTestId('confirm-remove-c1'))

      expect(await screen.findByText(/the vault is locked/i)).toBeTruthy()
      // Reporting a failure while quietly dropping the row from the list
      // would tell the operator two contradicting things at once.
      expect(screen.getByTestId('credential-row-c1')).toBeTruthy()
    })

    it('offers no remove control while locked -- never a dead control', () => {
      render(<VaultPanel initialised unlocked={false} credentials={[cred()]} />)
      expect(screen.queryByTestId('remove-c1')).toBeNull()
      expect(screen.queryByRole('button', { name: /^remove$/i })).toBeNull()
    })
  })

  // --- Task 10 / finding C1: changePassphrase() existed in vault.ts, with
  // three tests including the recovery-key-survives-a-change proof, and no
  // action and no UI in front of it. The passphrase could never be changed. ---
  describe('changing the passphrase (C1)', () => {
    it('offers the control while unlocked', () => {
      render(<VaultPanel initialised unlocked credentials={[]} />)
      expect(screen.getByRole('button', { name: /^change passphrase$/i })).toBeTruthy()
    })

    it('offers no change control while locked -- never a dead control', () => {
      render(<VaultPanel initialised unlocked={false} credentials={[]} />)
      expect(screen.queryByRole('button', { name: /change passphrase/i })).toBeNull()
    })

    it('passes both passphrases to the action and reports success', async () => {
      vi.mocked(changePassphraseAction).mockResolvedValue({ ok: true })
      render(<VaultPanel initialised unlocked credentials={[]} />)

      fireEvent.change(screen.getByLabelText(/^current passphrase$/i), { target: { value: 'the old one' } })
      fireEvent.change(screen.getByLabelText(/^new passphrase$/i), { target: { value: 'the new one' } })
      fireEvent.click(screen.getByRole('button', { name: /^change passphrase$/i }))

      await waitFor(() => expect(changePassphraseAction).toHaveBeenCalledWith('the old one', 'the new one'))
      expect(await screen.findByText(/passphrase changed/i)).toBeTruthy()
    })

    // Not cosmetic. An operator who believes the change invalidated their
    // printed recovery key may throw it away -- and it is the only way back
    // into this vault if the new passphrase is forgotten.
    it('says the recovery key still works, both before and after the change', async () => {
      vi.mocked(changePassphraseAction).mockResolvedValue({ ok: true })
      render(<VaultPanel initialised unlocked credentials={[]} />)

      expect(screen.getByText(/recovery key still works/i)).toBeTruthy()

      fireEvent.change(screen.getByLabelText(/^current passphrase$/i), { target: { value: 'the old one' } })
      fireEvent.change(screen.getByLabelText(/^new passphrase$/i), { target: { value: 'the new one' } })
      fireEvent.click(screen.getByRole('button', { name: /^change passphrase$/i }))

      const confirmation = await screen.findByText(/passphrase changed/i)
      expect(confirmation.textContent).toMatch(/recovery key is unchanged and still works/i)
    })

    it('shows the failure message and claims no success when the change fails', async () => {
      vi.mocked(changePassphraseAction).mockResolvedValue({
        ok: false,
        message: 'That current passphrase is not the one this vault was locked with. The passphrase is unchanged.',
      })
      render(<VaultPanel initialised unlocked credentials={[]} />)

      fireEvent.change(screen.getByLabelText(/^current passphrase$/i), { target: { value: 'wrong' } })
      fireEvent.change(screen.getByLabelText(/^new passphrase$/i), { target: { value: 'the new one' } })
      fireEvent.click(screen.getByRole('button', { name: /^change passphrase$/i }))

      expect(await screen.findByText(/is unchanged/i)).toBeTruthy()
      expect(screen.queryByText(/passphrase changed/i)).toBeNull()
    })

    // Deliberately exercised on the FAILURE path. On success the handler
    // clears both fields, so a component that echoed them would show nothing
    // by the time the assertion runs -- the test would pass without
    // discriminating (verified: it did). After a failure the values are still
    // held in state, which is exactly when an echo would be visible, and is
    // also the moment a failure message is being composed near them.
    it('never renders either passphrase back into the page, including after a failure', async () => {
      vi.mocked(changePassphraseAction).mockResolvedValue({
        ok: false,
        message: 'That current passphrase is not the one this vault was locked with. The passphrase is unchanged.',
      })
      const { container } = render(<VaultPanel initialised unlocked credentials={[]} />)

      fireEvent.change(screen.getByLabelText(/^current passphrase$/i), { target: { value: 'old-passphrase-value' } })
      fireEvent.change(screen.getByLabelText(/^new passphrase$/i), { target: { value: 'new-passphrase-value' } })
      fireEvent.click(screen.getByRole('button', { name: /^change passphrase$/i }))
      await screen.findByText(/is unchanged/i)

      expect(container.textContent ?? '').not.toContain('old-passphrase-value')
      expect(container.textContent ?? '').not.toContain('new-passphrase-value')
    })
  })

  // --- Task 10 / finding I2: the recovery-key gate renders BEFORE every
  // other branch, and `checkAndLock` cleared `localUnlocked`,
  // `revealedCredential` and `revealErrors` -- never `createdRecoveryKey`.
  // So an unacknowledged recovery key stayed on screen indefinitely past the
  // auto-lock, on the one screen where the deadline was never applied. That
  // is worse than a leaked reveal: the recovery key permanently unwraps the
  // vault key, nothing can redisplay or rotate it, and it survives every
  // passphrase change by design.
  //
  // The ruling: clear it at the deadline and replace it with a hard stop.
  // Safe precisely because this gate renders before every other branch --
  // the operator cannot have added a credential yet, so the vault is
  // provably empty at that moment and recreating it costs nothing.
  describe('the recovery key does not outlive the session deadline (I2)', () => {
    beforeEach(() => {
      vi.useFakeTimers()
      vi.setSystemTime(0)
    })
    afterEach(() => {
      vi.useRealTimers()
    })

    async function createVaultShowingTheKey() {
      vi.mocked(createVaultAction).mockResolvedValue({
        ok: true,
        recoveryKey: 'RK-EXAMPLE-VALUE',
        sessionRemainingMs: 5000,
      })
      render(<VaultPanel initialised={false} unlocked={false} credentials={[]} />)
      await act(async () => {
        fireEvent.change(screen.getByLabelText(/passphrase/i), { target: { value: 'a very long passphrase' } })
        fireEvent.click(screen.getByRole('button', { name: /^create vault$/i }))
        await vi.advanceTimersByTimeAsync(0)
      })
      // Precondition, not the assertion under test: it really is on screen
      // before the deadline, so its absence afterwards means something.
      expect(screen.getByText('RK-EXAMPLE-VALUE')).toBeTruthy()
    }

    it('clears an unacknowledged recovery key at the deadline, via its own timer', async () => {
      await createVaultShowingTheKey()

      await act(async () => {
        await vi.advanceTimersByTimeAsync(5001)
      })

      expect(screen.queryByText('RK-EXAMPLE-VALUE')).toBeNull()
      // ...and does not silently drop the operator into a working vault whose
      // recovery key they never stored.
      expect(screen.getByText(/must be recreated/i)).toBeTruthy()
      expect(screen.queryByRole('button', { name: /i have stored it/i })).toBeNull()
    })

    // The suspended-laptop path: the wall clock jumps but the timer queue
    // never advances, so only a focus/visibility re-check can notice. Covered
    // independently of the timer above -- the timer firing and the event
    // firing are different code paths and only one of them was ever wired to
    // this state.
    it('clears an unacknowledged recovery key when the tab regains focus past the deadline', async () => {
      await createVaultShowingTheKey()

      vi.setSystemTime(6000)
      await act(async () => {
        window.dispatchEvent(new Event('focus'))
      })

      expect(screen.queryByText('RK-EXAMPLE-VALUE')).toBeNull()
      expect(screen.getByText(/must be recreated/i)).toBeTruthy()
    })

    it('leaves the recovery key alone right up to the deadline', async () => {
      await createVaultShowingTheKey()

      await act(async () => {
        await vi.advanceTimersByTimeAsync(4000)
      })

      expect(screen.getByText('RK-EXAMPLE-VALUE')).toBeTruthy()
      expect(screen.queryByText(/must be recreated/i)).toBeNull()
    })

    it('an acknowledged recovery key leaves no hard stop behind at the deadline', async () => {
      await createVaultShowingTheKey()
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /i have stored it/i }))
      })

      await act(async () => {
        await vi.advanceTimersByTimeAsync(5001)
      })

      // The normal auto-lock, not the hard stop: the key was stored, so
      // there is nothing to recreate.
      expect(screen.getByText('Locked', { exact: true })).toBeTruthy()
      expect(screen.queryByText(/must be recreated/i)).toBeNull()
    })
  })

  describe('creating the vault', () => {
    it('shows the recovery key once after creation, with an instruction to store it off this machine, and never shows it again', async () => {
      vi.mocked(createVaultAction).mockResolvedValue({
        ok: true,
        recoveryKey: 'RK-EXAMPLE-VALUE',
        sessionRemainingMs: 900_000,
      })
      render(<VaultPanel initialised={false} unlocked={false} credentials={[]} />)

      fireEvent.change(screen.getByLabelText(/passphrase/i), { target: { value: 'a very long passphrase' } })
      fireEvent.click(screen.getByRole('button', { name: /^create vault$/i }))

      expect(await screen.findByText('RK-EXAMPLE-VALUE')).toBeTruthy()
      expect(screen.getByText(/store this off this machine/i)).toBeTruthy()

      fireEvent.click(screen.getByRole('button', { name: /i have stored it/i }))

      expect(screen.queryByText('RK-EXAMPLE-VALUE')).toBeNull()
      expect(screen.getByText('Unlocked', { exact: true })).toBeTruthy()
    })
  })
})
