'use client'

import { useState, useEffect, type FormEvent } from 'react'
import type { CredentialSummary } from '../lib/vault/credentials.js'
import type { SystemLabel } from '../lib/vault/system-labels.js'
import {
  createVaultAction,
  unlockAction,
  unlockWithRecoveryAction,
  lockAction,
  addCredentialAction,
  revealAction,
} from '../app/vault/actions.js'

export type VaultPanelProps = {
  initialised: boolean
  unlocked: boolean
  credentials: CredentialSummary[]
  /** From the board link: `/vault?host=<hostId>&system=<systemKey>`. Absent for a direct visit. */
  focusHostId?: string | null
  focusSystemKey?: string | null
  /**
   * How many milliseconds remain in the current server-side session AS OF
   * THE MOMENT THIS VALUE WAS LEARNED -- `null` while locked. Drives this
   * panel's own client-side auto-lock (fix round 1): without it, a secret
   * revealed before the server re-locks stays on screen indefinitely under
   * a header still reading "Unlocked", which is exactly the "dashboard left
   * open on an unlocked laptop" scenario design spec section 6 introduces
   * the auto-lock to close.
   *
   * Two sources feed this, both authoritative and neither ever estimated by
   * this component:
   *  1. `page.tsx`'s `remainingSessionMs()` on every server render.
   *  2. The unlock/create actions' own `sessionRemainingMs` return value,
   *     applied immediately on a client-driven unlock (fix round 2) --
   *     closing the window where a secret revealed right after an unlock,
   *     with no intervening server render, had no deadline to schedule
   *     against at all.
   *
   * Deliberately a DURATION, not an absolute epoch instant (fix round 1
   * shipped the latter as `sessionExpiresAt`; see fix round 2's report for
   * why it was replaced): a client whose clock disagreed with the server's
   * would misjudge an absolute deadline for the entire session, in either
   * direction. A duration is converted to a LOCAL deadline (`Date.now() +`
   * this value) the instant it is learned, in `localDeadlineMs` below --
   * comparing THAT against `Date.now()` later only requires this client's
   * own clock to stay self-consistent from that moment on, which the
   * `visibilitychange`/`focus` re-checks exist to catch a violation of (a
   * laptop suspended mid-session).
   */
  sessionRemainingMs?: number | null
  /**
   * Resolved display names for every `hostId`/`systemKey` pair currently in
   * the fleet table, keyed `${hostId}::${systemKey}` (built in `page.tsx`
   * from `Host`/`System`). A credential whose pair has NO entry here still
   * has non-null `hostId`/`systemKey` in the database (a credential can
   * outlive its system by design, see `credentials.ts`), but is grouped
   * with the unattached credentials rather than under a heading built from
   * raw internal ids -- an unresolvable system reads as "we no longer know
   * where this belongs", not as broken data.
   */
  systemLabels?: Record<string, SystemLabel>
}

// Exact strings, asserted on exactly by the test file -- kept as named
// constants so a future copy edit cannot accidentally drift the component
// and its test apart. See VaultPanel.test.tsx "Resolution 1" for why the
// Locked/Unlocked pair specifically must never be matched by substring.
const LOCKED_LABEL = 'Locked'
const UNLOCKED_LABEL = 'Unlocked'
const UNATTACHED_HEADING = 'Not attached to a system'
const EMPTY_MESSAGE = 'No credentials stored yet.'

// How long a revealed secret stays on screen before hiding itself, absent
// any other action. Chosen, not derived: long enough to read and click Copy
// without racing the clock, short enough that "transient" (design spec
// section 8) means something more than "until the 15-minute session TTL
// happens to expire" -- the vault's own session window is a much coarser
// backstop, not the mechanism "transient" is describing.
const REVEAL_DISPLAY_MS = 20_000

function copyToClipboard(text: string): void {
  // jsdom (the test environment) has no Clipboard API, and this must never
  // throw the click handler -- so this is best-effort, not load-bearing for
  // any requirement in this file.
  if (typeof navigator !== 'undefined' && navigator.clipboard) {
    navigator.clipboard.writeText(text).catch(() => {})
  }
}

type CredentialGroup = { key: string; hostName: string; systemName: string; items: CredentialSummary[] }

/**
 * Splits credentials into per-system groups plus an "unattached" bucket.
 *
 * A credential counts as attached only when BOTH `hostId` and `systemKey`
 * are set (addCredential always writes them together) AND that pair
 * resolves to a real, currently-enrolled system via `systemLabels`. A
 * credential whose system has since disappeared is deliberately folded into
 * `unattached` rather than rendered under a heading built from raw ids --
 * see `VaultPanelProps.systemLabels`.
 */
function groupBySystem(
  credentials: readonly CredentialSummary[],
  systemLabels: Readonly<Record<string, SystemLabel>>,
): { groups: CredentialGroup[]; unattached: CredentialSummary[] } {
  const map = new Map<string, CredentialGroup>()
  const unattached: CredentialSummary[] = []
  for (const c of credentials) {
    if (c.hostId === null || c.systemKey === null) {
      unattached.push(c)
      continue
    }
    const key = `${c.hostId}::${c.systemKey}`
    const label = systemLabels[key]
    if (label === undefined) {
      unattached.push(c)
      continue
    }
    const existing = map.get(key)
    if (existing) {
      existing.items.push(c)
    } else {
      map.set(key, { key, hostName: label.hostName, systemName: label.systemName, items: [c] })
    }
  }
  const groups = Array.from(map.values()).sort((a, b) =>
    `${a.systemName}::${a.hostName}`.localeCompare(`${b.systemName}::${b.hostName}`),
  )
  return { groups, unattached }
}

export function VaultPanel({
  initialised,
  unlocked,
  credentials,
  focusHostId,
  focusSystemKey,
  sessionRemainingMs,
  systemLabels,
}: VaultPanelProps) {
  // Mirrors the props but is updated locally from the AUTHORITATIVE result of
  // each action -- `ok: true` from createVaultAction/unlockAction/lockAction
  // means the server state genuinely changed, so it is safe to reflect that
  // immediately rather than waiting for a fresh server render. This is what
  // lets the panel behave correctly inside a plain render() in tests, which
  // has no Next.js router to refresh it -- and it also gives an incident
  // responder instant feedback in production, where a full-page round trip
  // would otherwise sit between "I typed the passphrase" and "it unlocked".
  const [localInitialised, setLocalInitialised] = useState(initialised)
  const [localUnlocked, setLocalUnlocked] = useState(unlocked)
  const [credentialsState, setCredentialsState] = useState<CredentialSummary[]>(credentials)

  const activeFocusHostId = focusHostId ?? null
  const activeFocusSystemKey = focusSystemKey ?? null
  const labels = systemLabels ?? {}

  // The LOCAL absolute deadline this client schedules its own auto-lock
  // against -- always derived by adding a server-issued DURATION to this
  // client's own `Date.now()` at the moment that duration became known
  // (see VaultPanelProps.sessionRemainingMs). Never the server's raw epoch
  // instant, and never a duration this component invented on its own.
  const [localDeadlineMs, setLocalDeadlineMs] = useState<number | null>(null)

  // Syncs `localDeadlineMs` from the `sessionRemainingMs` PROP -- i.e. from
  // page.tsx's `remainingSessionMs()` on every fresh server render. Runs on
  // mount (establishing the initial deadline) and again whenever the prop
  // VALUE changes (a later render delivering fresher data). A client-driven
  // unlock/create sets `localDeadlineMs` directly from the action's own
  // return value instead (see the three handlers below) -- that path does
  // not wait for this effect, which is what closes the "revealed
  // immediately after an unlock, before the next server render" window
  // fix round 2 exists to fix.
  useEffect(() => {
    setLocalDeadlineMs(sessionRemainingMs != null ? Date.now() + sessionRemainingMs : null)
  }, [sessionRemainingMs])

  // --- Create ---
  const [createPassphrase, setCreatePassphrase] = useState('')
  const [createPending, setCreatePending] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  // Shown exactly once. Nothing re-derives this from props or persists it --
  // once dismissed, there is no way back to this screen short of a fresh
  // createVaultAction call, which the "already exists" guard refuses.
  const [createdRecoveryKey, setCreatedRecoveryKey] = useState<string | null>(null)
  // Set when the session deadline passed while the recovery key was STILL ON
  // SCREEN unacknowledged (fix I2). Distinct from `createdRecoveryKey ===
  // null`, which is also true after the operator confirms storing it -- this
  // one means the key was destroyed before anyone wrote it down.
  const [recoveryKeyLostToDeadline, setRecoveryKeyLostToDeadline] = useState(false)

  async function handleCreate(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setCreatePending(true)
    setCreateError(null)
    try {
      const r = await createVaultAction(createPassphrase)
      if (r.ok) {
        setCreatedRecoveryKey(r.recoveryKey)
        setLocalInitialised(true)
        setLocalUnlocked(true)
        // Applied directly from the action's own result, not waited on the
        // `sessionRemainingMs` prop's next server render -- see fix round 2.
        setLocalDeadlineMs(Date.now() + r.sessionRemainingMs)
        setCreatePassphrase('')
      } else {
        setCreateError(r.message)
      }
    } finally {
      setCreatePending(false)
    }
  }

  // --- Unlock ---
  const [passphrase, setPassphrase] = useState('')
  const [unlockPending, setUnlockPending] = useState(false)
  const [unlockError, setUnlockError] = useState<string | null>(null)
  const [useRecoveryMode, setUseRecoveryMode] = useState(false)
  const [recoveryInput, setRecoveryInput] = useState('')
  const [recoveryPending, setRecoveryPending] = useState(false)
  const [recoveryError, setRecoveryError] = useState<string | null>(null)

  async function handleUnlock(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setUnlockPending(true)
    setUnlockError(null)
    try {
      const r = await unlockAction(passphrase)
      if (r.ok) {
        setLocalUnlocked(true)
        setLocalDeadlineMs(Date.now() + r.sessionRemainingMs)
        setPassphrase('')
      } else {
        setUnlockError(r.message)
      }
    } finally {
      setUnlockPending(false)
    }
  }

  async function handleUnlockRecovery(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setRecoveryPending(true)
    setRecoveryError(null)
    try {
      const r = await unlockWithRecoveryAction(recoveryInput)
      if (r.ok) {
        setLocalUnlocked(true)
        setLocalDeadlineMs(Date.now() + r.sessionRemainingMs)
        setRecoveryInput('')
        setUseRecoveryMode(false)
      } else {
        setRecoveryError(r.message)
      }
    } finally {
      setRecoveryPending(false)
    }
  }

  // --- Reveal: exactly one credential's plaintext may be on screen at any
  // moment (design spec section 8, "Reveal shows one credential at a time,
  // transiently" -- the coordinator's ruling on the ambiguity between that
  // and independent per-row toggles). A single slot makes "revealing a
  // second credential hides the first" a structural property rather than
  // something a future change could accidentally break by touching only
  // one row's state. ---
  const [revealedCredential, setRevealedCredential] = useState<{ id: string; secret: string } | null>(null)
  const [revealPending, setRevealPending] = useState<Record<string, boolean>>({})
  const [revealErrors, setRevealErrors] = useState<Record<string, string>>({})

  // Auto-hide: a revealed secret disappears on its own after REVEAL_DISPLAY_MS,
  // independent of the vault's own session expiry (below) -- this is what
  // "transiently" asks for, and what a manual-only Hide does not deliver.
  useEffect(() => {
    if (revealedCredential === null) return
    const timer = setTimeout(() => setRevealedCredential(null), REVEAL_DISPLAY_MS)
    return () => clearTimeout(timer)
  }, [revealedCredential])

  // Auto-lock: schedules against `localDeadlineMs` (see above) -- a value
  // this client derived itself, once, from a server-issued DURATION, so
  // comparing it to `Date.now()` here never depends on this client's clock
  // agreeing with the server's, only on it being self-consistent since the
  // deadline was set. The server remains the only thing that decides when
  // the vault is ACTUALLY locked (`revealAction` etc. re-check the real
  // session on every call); this effect only decides when the SCREEN
  // clears. A single timer is not enough on its own: background tabs
  // throttle timers, and a laptop suspended past the deadline wakes with
  // the timer unfired -- exactly the walk-away cases this fix exists for --
  // so `visibilitychange` and `focus` re-check the same deadline every time
  // the tab could plausibly have been away.
  //
  // `createdRecoveryKey` is in the dependency list, not merely read from a
  // stale closure, so `checkAndLock` always sees the CURRENT value: the
  // recovery-key gate is set by the same handler that sets the deadline, and
  // is cleared by a later, unrelated click, so neither ordering may be
  // assumed.
  useEffect(() => {
    if (localDeadlineMs === null) return
    function checkAndLock() {
      if (localDeadlineMs !== null && Date.now() >= localDeadlineMs) {
        setLocalUnlocked(false)
        setRevealedCredential(null)
        setRevealErrors({})
        // Fix I2. The recovery-key gate returns BEFORE every other branch,
        // so without this the whole clearing above was invisible: the key
        // stayed rendered under a screen that never even said Locked. It is
        // the worst secret this panel ever displays -- it permanently
        // unwraps the vault key, nothing can redisplay or rotate it, and it
        // survives a passphrase change by design -- so it gets the same
        // treatment as a revealed credential, not an exemption.
        //
        // Clearing it is safe precisely because of where that gate sits: the
        // operator cannot have reached any add control yet, so the vault is
        // provably empty and recreating it costs nothing. Losing an
        // unacknowledged recovery key to a timeout is survivable; leaving it
        // on an unattended screen indefinitely is not.
        if (createdRecoveryKey !== null) {
          setCreatedRecoveryKey(null)
          setRecoveryKeyLostToDeadline(true)
        }
      }
    }
    checkAndLock() // in case the deadline has already passed by the time this effect runs
    const remaining = localDeadlineMs - Date.now()
    const timer = remaining > 0 ? setTimeout(checkAndLock, remaining) : null
    document.addEventListener('visibilitychange', checkAndLock)
    window.addEventListener('focus', checkAndLock)
    return () => {
      if (timer !== null) clearTimeout(timer)
      document.removeEventListener('visibilitychange', checkAndLock)
      window.removeEventListener('focus', checkAndLock)
    }
  }, [localDeadlineMs, createdRecoveryKey])

  // --- Lock (manual) ---
  async function handleLock() {
    await lockAction()
    setLocalUnlocked(false)
    setLocalDeadlineMs(null)
    // A secret already revealed this session must not survive a lock -- the
    // vault key it depended on is gone from the server, and leaving the text
    // on screen after the operator explicitly asked to lock is exactly the
    // kind of lingering exposure this feature exists to avoid.
    setRevealedCredential(null)
    setRevealErrors({})
  }

  async function handleReveal(id: string) {
    setRevealPending((p) => ({ ...p, [id]: true }))
    setRevealErrors((p) => {
      const next = { ...p }
      delete next[id]
      return next
    })
    try {
      const r = await revealAction(id)
      if (r.ok) {
        setRevealedCredential({ id, secret: r.secret })
      } else {
        setRevealErrors((p) => ({ ...p, [id]: r.message }))
      }
    } finally {
      setRevealPending((p) => ({ ...p, [id]: false }))
    }
  }

  function handleHide() {
    setRevealedCredential(null)
  }

  // --- Add a credential pre-attached to the focused system (Resolution 3) ---
  const [addLabel, setAddLabel] = useState('')
  const [addUsername, setAddUsername] = useState('')
  const [addSecret, setAddSecret] = useState('')
  const [addPending, setAddPending] = useState(false)
  const [addError, setAddError] = useState<string | null>(null)

  async function handleAddFocused(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (activeFocusHostId === null || activeFocusSystemKey === null) return
    setAddPending(true)
    setAddError(null)
    try {
      const r = await addCredentialAction({
        label: addLabel,
        username: addUsername,
        secret: addSecret,
        hostId: activeFocusHostId,
        systemKey: activeFocusSystemKey,
      })
      if (r.ok) {
        setCredentialsState((prev) => [
          ...prev,
          {
            id: r.id,
            label: addLabel,
            username: addUsername,
            notes: null,
            hostId: activeFocusHostId,
            systemKey: activeFocusSystemKey,
            rotatedAt: null,
          },
        ])
        setAddLabel('')
        setAddUsername('')
        setAddSecret('')
      } else {
        setAddError(r.message)
      }
    } finally {
      setAddPending(false)
    }
  }

  // The focused system's resolved display name, when known -- falls back to
  // the raw key only for the "what do I call this in a sentence" purpose of
  // these hint strings, which is a different situation from the group
  // headings below (there, an unresolved system is folded into unattached
  // rather than named at all).
  const focusSystemLabel =
    activeFocusHostId !== null && activeFocusSystemKey !== null
      ? (labels[`${activeFocusHostId}::${activeFocusSystemKey}`]?.systemName ?? activeFocusSystemKey)
      : null

  // --- Recovery key destroyed at the deadline before it was acknowledged
  // (fix I2): a hard stop, ahead of every other branch including the gate
  // itself. There is deliberately no control here to carry on with. A vault
  // whose only recovery key was never written down is one forgotten
  // passphrase away from taking every credential in it with it, and the
  // moment to say so is BEFORE the first credential is stored -- which is
  // exactly the moment this state can occur in, and no other. ---
  if (recoveryKeyLostToDeadline) {
    return (
      <section className="vault-panel" aria-labelledby="vault-heading">
        <h2 id="vault-heading">Vault</h2>
        <div className="vault-recovery-gate" role="alert">
          <p>
            <strong>The recovery key was cleared before you confirmed storing it.</strong> The vault
            session reached its deadline while the key was still on screen, so it was removed rather
            than left on an unattended display. It cannot be shown again, and nothing can regenerate
            it.
          </p>
          <p>
            <strong>This vault must be recreated before anything is stored in it.</strong> Nothing has
            been stored yet -- the recovery key is shown before any credential can be added -- so
            recreating it costs nothing but the time. Remove the stored vault configuration and set
            the vault up again, and store the new recovery key the moment it appears.
          </p>
        </div>
      </section>
    )
  }

  // --- Recovery-key gate: takes over the ENTIRE panel until acknowledged ---
  if (createdRecoveryKey !== null) {
    return (
      <section className="vault-panel" aria-labelledby="vault-heading">
        <h2 id="vault-heading">Vault</h2>
        <div className="vault-recovery-gate" role="alert">
          <p>
            <strong>Recovery key -- shown once.</strong> Store this off this machine now (a password
            manager or printed copy, not a file on this box). It will not be shown again, and there is
            no other way to recover access if the passphrase is lost.
          </p>
          <code>{createdRecoveryKey}</code>
          <button type="button" className="vault-button" onClick={() => copyToClipboard(createdRecoveryKey)}>
            Copy recovery key
          </button>
          <button type="button" className="vault-button" onClick={() => setCreatedRecoveryKey(null)}>
            I have stored it -- continue
          </button>
        </div>
      </section>
    )
  }

  // --- Uninitialised ---
  if (!localInitialised) {
    return (
      <section className="vault-panel" aria-labelledby="vault-heading">
        <h2 id="vault-heading">Vault</h2>
        <h3>Set up the vault</h3>
        <p className="vault-hint">No vault has been created on this dashboard yet.</p>
        <form onSubmit={handleCreate}>
          <label className="vault-field">
            Passphrase
            <input
              type="password"
              value={createPassphrase}
              onChange={(e) => setCreatePassphrase(e.target.value)}
              required
              autoComplete="new-password"
            />
          </label>
          <button type="submit" className="vault-button" disabled={createPending}>
            {createPending ? 'Creating...' : 'Create vault'}
          </button>
        </form>
        {createError && <p className="vault-error" role="alert">{createError}</p>}
      </section>
    )
  }

  const { groups, unattached } = groupBySystem(credentialsState, labels)

  // --- Locked ---
  if (!localUnlocked) {
    const focusHasCredentials =
      activeFocusHostId !== null &&
      activeFocusSystemKey !== null &&
      credentialsState.some((c) => c.hostId === activeFocusHostId && c.systemKey === activeFocusSystemKey)

    return (
      <section className="vault-panel" aria-labelledby="vault-heading">
        <h2 id="vault-heading">Vault</h2>
        <p className="vault-status" data-status="locked">
          {LOCKED_LABEL}
        </p>
        <form onSubmit={handleUnlock}>
          <label className="vault-field">
            Passphrase
            <input
              type="password"
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
              required
              autoComplete="current-password"
            />
          </label>
          <button type="submit" className="vault-button" disabled={unlockPending}>
            {unlockPending ? 'Unlocking...' : 'Unlock'}
          </button>
        </form>
        {unlockError && <p className="vault-error" role="alert">{unlockError}</p>}

        {!useRecoveryMode && (
          <button type="button" className="vault-button" onClick={() => setUseRecoveryMode(true)}>
            Unlock with recovery key instead
          </button>
        )}
        {useRecoveryMode && (
          <form onSubmit={handleUnlockRecovery}>
            <label className="vault-field">
              Recovery key
              <input
                type="text"
                value={recoveryInput}
                onChange={(e) => setRecoveryInput(e.target.value)}
                required
                autoComplete="off"
              />
            </label>
            <button type="submit" className="vault-button" disabled={recoveryPending}>
              {recoveryPending ? 'Unlocking...' : 'Unlock with recovery key'}
            </button>
          </form>
        )}
        {recoveryError && <p className="vault-error" role="alert">{recoveryError}</p>}

        {/* Labels only -- see LOCKED_LABEL doc comment: a dash here would read
            as "not known", which is a different fact from "locked". */}
        {credentialsState.length > 0 && (
          <div>
            <h3>Stored credentials</h3>
            <ul className="vault-locked-list">
              {credentialsState.map((c) => (
                <li key={c.id}>{c.label}</li>
              ))}
            </ul>
          </div>
        )}

        {activeFocusSystemKey !== null && !focusHasCredentials && (
          <p className="vault-hint">
            No credentials stored yet for system &ldquo;{focusSystemLabel}&rdquo;. Unlock the vault to add
            one.
          </p>
        )}
      </section>
    )
  }

  // --- Unlocked ---
  const focusGroupCredentials =
    activeFocusHostId !== null && activeFocusSystemKey !== null
      ? credentialsState.filter((c) => c.hostId === activeFocusHostId && c.systemKey === activeFocusSystemKey)
      : []
  const focusHasNoCredentials =
    activeFocusHostId !== null && activeFocusSystemKey !== null && focusGroupCredentials.length === 0

  function renderRow(c: CredentialSummary) {
    const secret = revealedCredential !== null && revealedCredential.id === c.id ? revealedCredential.secret : undefined
    const pending = revealPending[c.id] === true
    const error = revealErrors[c.id]
    return (
      <li key={c.id} className="vault-credential-row" data-testid={`credential-row-${c.id}`}>
        <span className="vault-credential-label">{c.label}</span>
        <span className="vault-credential-username">{c.username}</span>
        {secret !== undefined ? (
          <span className="vault-secret" data-testid={`secret-${c.id}`}>
            <code>{secret}</code>
            <button type="button" className="vault-button" onClick={() => copyToClipboard(secret)}>
              Copy
            </button>
            <button type="button" className="vault-button" onClick={handleHide}>
              Hide
            </button>
          </span>
        ) : (
          <button
            type="button"
            className="vault-button"
            data-testid={`reveal-${c.id}`}
            disabled={pending}
            onClick={() => {
              void handleReveal(c.id)
            }}
          >
            {pending ? 'Revealing...' : 'Reveal'}
          </button>
        )}
        {error !== undefined && (
          <p className="vault-error" role="alert">
            {error}
          </p>
        )}
      </li>
    )
  }

  return (
    <section className="vault-panel" aria-labelledby="vault-heading">
      <h2 id="vault-heading">Vault</h2>
      <p className="vault-status" data-status="unlocked">
        {UNLOCKED_LABEL}
      </p>
      <button type="button" className="vault-button" onClick={() => void handleLock()}>
        Lock now
      </button>

      {credentialsState.length === 0 && <p>{EMPTY_MESSAGE}</p>}

      {groups.map((g) => (
        <div key={g.key}>
          <h3 className="vault-group-heading">
            System &ldquo;{g.systemName}&rdquo; (host {g.hostName})
          </h3>
          <ul className="vault-credential-list">{g.items.map(renderRow)}</ul>
        </div>
      ))}

      {unattached.length > 0 && (
        <div>
          <h3 className="vault-group-heading">{UNATTACHED_HEADING}</h3>
          <ul className="vault-credential-list">{unattached.map(renderRow)}</ul>
        </div>
      )}

      {focusHasNoCredentials && activeFocusHostId !== null && activeFocusSystemKey !== null && (
        <div className="vault-focus-add">
          <h3 className="vault-group-heading">Add a credential for system &ldquo;{focusSystemLabel}&rdquo;</h3>
          <form onSubmit={handleAddFocused}>
            <label className="vault-field">
              Label
              <input type="text" value={addLabel} onChange={(e) => setAddLabel(e.target.value)} required />
            </label>
            <label className="vault-field">
              Username
              <input
                type="text"
                value={addUsername}
                onChange={(e) => setAddUsername(e.target.value)}
                required
              />
            </label>
            <label className="vault-field">
              Secret
              <input
                type="password"
                value={addSecret}
                onChange={(e) => setAddSecret(e.target.value)}
                required
                autoComplete="new-password"
              />
            </label>
            <button type="submit" className="vault-button" disabled={addPending}>
              {addPending ? 'Saving...' : 'Add credential'}
            </button>
          </form>
          {addError && <p className="vault-error" role="alert">{addError}</p>}
        </div>
      )}
    </section>
  )
}
