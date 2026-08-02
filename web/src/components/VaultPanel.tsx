'use client'

import { useState, type FormEvent } from 'react'
import type { CredentialSummary } from '../lib/vault/credentials.js'
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
}

// Exact strings, asserted on exactly by the test file -- kept as named
// constants so a future copy edit cannot accidentally drift the component
// and its test apart. See VaultPanel.test.tsx "Resolution 1" for why the
// Locked/Unlocked pair specifically must never be matched by substring.
const LOCKED_LABEL = 'Locked'
const UNLOCKED_LABEL = 'Unlocked'
const UNATTACHED_HEADING = 'Not attached to a system'
const EMPTY_MESSAGE = 'No credentials stored yet.'

function copyToClipboard(text: string): void {
  // jsdom (the test environment) has no Clipboard API, and this must never
  // throw the click handler -- so this is best-effort, not load-bearing for
  // any requirement in this file.
  if (typeof navigator !== 'undefined' && navigator.clipboard) {
    navigator.clipboard.writeText(text).catch(() => {})
  }
}

type CredentialGroup = { key: string; hostId: string; systemKey: string; items: CredentialSummary[] }

/**
 * Splits credentials into per-system groups plus an "unattached" bucket.
 * A credential counts as attached only when BOTH hostId and systemKey are
 * set -- addCredential always writes them together (see credentials.ts), so
 * one-set-one-null is not a shape this data actually produces, but treating
 * it as unattached rather than crashing is the safer read of a field this
 * function does not control the writer of.
 */
function groupBySystem(credentials: readonly CredentialSummary[]): {
  groups: CredentialGroup[]
  unattached: CredentialSummary[]
} {
  const map = new Map<string, CredentialGroup>()
  const unattached: CredentialSummary[] = []
  for (const c of credentials) {
    if (c.hostId === null || c.systemKey === null) {
      unattached.push(c)
      continue
    }
    const key = `${c.hostId}::${c.systemKey}`
    const existing = map.get(key)
    if (existing) {
      existing.items.push(c)
    } else {
      map.set(key, { key, hostId: c.hostId, systemKey: c.systemKey, items: [c] })
    }
  }
  const groups = Array.from(map.values()).sort((a, b) => a.key.localeCompare(b.key))
  return { groups, unattached }
}

export function VaultPanel({ initialised, unlocked, credentials, focusHostId, focusSystemKey }: VaultPanelProps) {
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

  // --- Create ---
  const [createPassphrase, setCreatePassphrase] = useState('')
  const [createPending, setCreatePending] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  // Shown exactly once. Nothing re-derives this from props or persists it --
  // once dismissed, there is no way back to this screen short of a fresh
  // createVaultAction call, which the "already exists" guard refuses.
  const [createdRecoveryKey, setCreatedRecoveryKey] = useState<string | null>(null)

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
        setRecoveryInput('')
        setUseRecoveryMode(false)
      } else {
        setRecoveryError(r.message)
      }
    } finally {
      setRecoveryPending(false)
    }
  }

  // --- Lock ---
  async function handleLock() {
    await lockAction()
    setLocalUnlocked(false)
    // A secret already revealed this session must not survive a lock -- the
    // vault key it depended on is gone from the server, and leaving the text
    // on screen after the operator explicitly asked to lock is exactly the
    // kind of lingering exposure this feature exists to avoid.
    setRevealed({})
    setRevealErrors({})
  }

  // --- Reveal (per credential id, so one row's state can never leak into another's) ---
  const [revealed, setRevealed] = useState<Record<string, string>>({})
  const [revealPending, setRevealPending] = useState<Record<string, boolean>>({})
  const [revealErrors, setRevealErrors] = useState<Record<string, string>>({})

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
        setRevealed((p) => ({ ...p, [id]: r.secret }))
      } else {
        setRevealErrors((p) => ({ ...p, [id]: r.message }))
      }
    } finally {
      setRevealPending((p) => ({ ...p, [id]: false }))
    }
  }

  function handleHide(id: string) {
    setRevealed((p) => {
      const next = { ...p }
      delete next[id]
      return next
    })
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

  const { groups, unattached } = groupBySystem(credentialsState)

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
            No credentials stored yet for system &ldquo;{activeFocusSystemKey}&rdquo;. Unlock the vault to
            add one.
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
    const secret = revealed[c.id]
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
            <button type="button" className="vault-button" onClick={() => handleHide(c.id)}>
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
            System &ldquo;{g.systemKey}&rdquo; (host {g.hostId})
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
          <h3 className="vault-group-heading">
            Add a credential for system &ldquo;{activeFocusSystemKey}&rdquo;
          </h3>
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
