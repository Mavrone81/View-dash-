// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within, fireEvent, waitFor } from '@testing-library/react'

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
}))

import {
  createVaultAction,
  unlockAction,
  lockAction,
  addCredentialAction,
  revealAction,
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

  it('never renders a secret into the page before it is asked for', () => {
    const { container } = render(<VaultPanel initialised unlocked credentials={[cred()]} />)
    expect(container.innerHTML).not.toContain('hunter2')
  })

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
      />,
    )
    const headings = screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent ?? '')
    const alphaIdx = headings.findIndex((h) => h.includes('alpha'))
    const unattachedIdx = headings.findIndex((h) => h === 'Not attached to a system')
    expect(alphaIdx).toBeGreaterThanOrEqual(0)
    expect(unattachedIdx).toBeGreaterThan(alphaIdx)
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

    it('does not offer to add when the focused system already has a credential', () => {
      render(
        <VaultPanel
          initialised
          unlocked
          credentials={[cred({ hostId: 'h9', systemKey: 'beta' })]}
          focusHostId="h9"
          focusSystemKey="beta"
        />,
      )
      expect(screen.queryByRole('button', { name: /add credential/i })).toBeNull()
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

  describe('creating the vault', () => {
    it('shows the recovery key once after creation, with an instruction to store it off this machine, and never shows it again', async () => {
      vi.mocked(createVaultAction).mockResolvedValue({ ok: true, recoveryKey: 'RK-EXAMPLE-VALUE' })
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
