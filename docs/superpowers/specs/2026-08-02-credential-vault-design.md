# Design — Credential Vault

**Date:** 2026-08-02
**Status:** Approved in brainstorming — pending implementation plan
**Depends on:** slice 1 (live). Does **not** depend on the authentication slice — see §3.

> **Repo hygiene still binds.** This repository is public. No addresses, hostnames, domains or monitored-system names in code, tests, fixtures or docs. Nothing in this feature changes that, and a credential store is the last place to start making exceptions.

## 1 · Problem

The operator administers roughly twenty applications across several businesses, each with its own admin account, its own user store and its own hashing scheme. Today those credentials live scattered across chat logs, notes and memory. Finding the right login for a given app is recurring friction, and the current storage — wherever a password happened to be written down — is worse than a designed one.

The fleet board already lists every system. It is the natural place to answer "what do I log into this with".

## 2 · Goals

Clicking a system on the board reveals the admin credentials for it, after unlocking the vault. Credentials are stored encrypted, revealed one at a time, and every reveal is recorded.

**Non-goals, deliberately:**
- **Writing new passwords into the applications themselves.** That needs a per-application adapter — twenty different user stores, schemas and hashing schemes — and belongs in later, separate work, added per app only where it earns its keep. This spec covers storage and retrieval only.
- Sharing credentials with other people, or per-user access control. One operator.
- Storing credentials for **other developers' applications** on the shared host. Several systems on the board belong to other businesses; their admin credentials are not ours to hold.

## 3 · Why this does not wait for the authentication slice

The dashboard has no login page. It is reached only through an SSH tunnel, which requires the operator's private key, to a host whose firewall admits exactly one address. Nobody else can reach a login screen to attack, because there is none to reach.

What the tunnel cannot cover — by construction — is the case where **the session is already open**: an unlocked laptop, or malware on the machine holding the key. A login page would not help there either, since the session would already be authenticated.

The control that does help is the vault having **its own lock**, independent of how the page was reached: a passphrase to unlock, and automatic re-locking. That is why this ships without waiting for authentication, and why the lock is not optional.

Attribution is the one thing genuinely absent. With a single operator it is not missing information. It becomes real the day a second admin exists, which is when the authentication slice arrives.

## 4 · Decisions

1. **Recovery: a printed recovery key**, generated once at vault creation and stored off this machine. Rationale: a passphrase-only vault means one forgotten passphrase permanently destroys credentials for twenty production systems, with no undo. For a solo operator, losing access is far likelier than physical theft of a printed key. The estate already carries the mirror of this risk elsewhere, where a sole encryption key lives on one laptop and its loss would be silent until a restore is attempted.
2. **One model for any credential type.** Admin logins now; database passwords, SMTP and API keys fit the same shape. No second system later.
3. **Credentials attach to a system but never die with one.** If a system disappears from the board, its credentials become unattached — never deleted. Deleting a password because a container went away would be indefensible.
4. **Reveal is the audited event**, not access to the page.

## 5 · Key handling

A random 32-byte **vault key** is generated once. It is never stored raw. It is wrapped twice:

- by a key derived from the operator's **passphrase** (**scrypt**, N=65536 r=8 p=1, parameters stored alongside), and
- by the **recovery key**.

  This section originally specified Argon2id. It was changed during implementation and the reason is worth keeping: every Argon2 binding available to Node is a native module, and this project admits no new dependencies — a native addon would have to compile on the deployment host and would become a way for the dashboard to fail to start. scrypt is in the Node standard library, is memory-hard, and at these parameters costs roughly 64 MB per derivation. Argon2id is the better primitive in the abstract; scrypt without a native dependency is the better choice here, and the parameters are stored per-vault so they can be raised later without invalidating anything.

  The stored parameters are validated on every unlock against a floor, not merely parsed — a `kdfParams` row edited to a weak work factor is rejected rather than honoured, and reported as a corrupt configuration rather than as a wrong passphrase.

Unlocking derives the wrapping key in memory and unwraps the vault key; neither is ever written to disk. Changing the passphrase re-wraps the vault key — it does **not** re-encrypt every secret, so a passphrase change is instant regardless of vault size.

Each credential's secret is sealed with the existing envelope primitive (`web/src/lib/crypto/envelope.ts`): AES-256-GCM, with **AAD bound to `credential:<id>:secret`**, so a ciphertext lifted from one row cannot be opened in another. That primitive has been present and unused since slice 1 for exactly this purpose.

**Verifier.** `VaultConfig` stores a value that proves a supplied passphrase is correct without revealing the vault key, so a wrong passphrase fails cleanly rather than producing garbage plaintext.

## 6 · Locking

- The vault is **locked at process start**. A restart always locks.
- Unlock is required before any reveal.
- **Automatic re-lock 15 minutes after unlocking**, measured from the unlock itself and never extended by use. A dashboard left open on an unlocked laptop stops being a credential dispenser.

  This corrects the original wording, "after 15 minutes of inactivity", which described a sliding idle window. That would have been the weaker control: revealing a credential every fourteen minutes would keep the vault unlocked indefinitely, so the session most actively dispensing secrets would be the one that never re-locked. An absolute deadline costs an occasional re-entry mid-task and buys a guarantee — no unlock outlives its 15 minutes, whatever the operator does. The implementation was already absolute; the wording was wrong, not the behaviour.

  A revealed secret is cleared from the screen at that same deadline, not merely refused at the next reveal. Blocking new reveals while leaving an already-rendered secret on display would miss the unattended-laptop case this rule exists for.
- The unwrapped vault key exists only in process memory, never in the database, a file, an environment variable, or a log line.
- **The system clipboard is out of the lock's reach, and deliberately not swept.** Copying a secret puts a plaintext copy somewhere this application cannot see, cannot verify, and does not own. It survives the auto-lock, the auto-hide and an explicit *Lock now*.

  Writing an empty string to the clipboard on lock was considered and rejected. It cannot be verified — the page cannot read the clipboard back to confirm the secret is gone — and it fails silently in the common case, because clipboard writes require document focus and user activation that a background timer does not have. Worse, it is wrong when it does work: the operator who copied a secret and has since copied something else would lose that instead, and the vault would have destroyed unrelated data to no benefit. A control that usually fails quietly, and does damage when it succeeds, is worse than a documented limitation — it converts a known gap into a false assurance, which is the failure mode this design keeps guarding against elsewhere.

  So it is stated instead: **a copied secret is out of the vault's custody.** Paste it, use it, and clear the clipboard yourself if the machine is shared.

## 7 · Data model

- **`Credential`** — `id`, `label`, `username`, `secretSealed`, `notes`, optional `hostId` + `systemKey`, `createdAt`, `updatedAt`, `rotatedAt`.
  The system link is a plain pair, not a foreign key to `System`: systems are discovered and can vanish, and a credential must survive that. Attachment is resolved by matching, so a returning system re-attaches automatically.
- **`VaultConfig`** — exactly one row: KDF parameters, the verifier, and both wrapped copies of the vault key. A partial-unique index enforces the single row.
- **`CredentialAccess`** — append-only: `credentialId`, `action`, `at`. Never records the secret itself.

  The actions actually written are `create`, `reveal`, `reveal-denied` and `reveal-failed`. The last two were added during implementation: an access log that records only the reveals that succeeded is backwards, because a reveal blocked by the lock, or one whose ciphertext failed its authentication check, is the event most worth seeing.

  Two actions named in the original draft are **not** written, and each is a real limitation rather than an oversight:

  - **`delete`** cannot be recorded. `CredentialAccess` rows cascade with the credential, so a row describing a deletion would be removed by the same statement that deletes the thing it describes. The audit trail therefore cannot record the one action that destroys its own evidence. Recording deletions would need a separate log not foreign-keyed to `Credential`.
  - **`update`** has no code path, because there is no edit-in-place operation. Changing a stored secret means deleting the credential and adding a new one, which starts a fresh audit history and loses continuity with the old one. `rotatedAt` exists on the model for the same unbuilt operation and is written by nothing.

  Both belong to the same follow-up: credential rotation with an audit trail that survives it.

## 8 · Interface

- A system row on the board links to its credentials. A system with none says so plainly rather than showing an empty control.
- A vault page lists all entries grouped by system, with unattached entries last, clearly labelled as unattached rather than hidden.
- **Reveal shows one credential at a time**, transiently, with copy-to-clipboard. Secrets are never rendered into the page for rows the operator has not asked to reveal.
- When locked, the interface says the vault is locked and offers to unlock. It does not silently show empty fields — an empty field reads as "no credential stored", which is a different fact.

## 9 · Failure modes designed in

- **A wrong passphrase fails clearly**, via the verifier, rather than yielding unreadable output.
- **A missing or corrupt `VaultConfig`** reports that the vault is not initialised, and refuses to create a second one silently.
- **A decryption failure on one credential** degrades that entry only; the rest of the vault stays usable. The failing entry is shown as unreadable, never as empty.
- **Never log a secret, a passphrase, a derived key, or the vault key** — including in error messages, which is where they usually escape.

## 10 · Testing

Unit tests for key wrapping and unwrapping, passphrase change, the verifier, and re-lock timing. Integration tests against a real Postgres for the credential lifecycle and audit writes.

Every rule gets a test asserting the **denial**, and each denial test must be verified to fail without its fix rather than reasoned about. Specifically: a wrong passphrase cannot unlock; a locked vault cannot reveal; a ciphertext moved between credential rows fails to open; a reveal always writes an audit row; deleting a system does not delete its credentials; and no secret, passphrase or key appears in any log line or error message.

## 11 · Out of scope, recorded so it is not rediscovered

Automated password reset into the applications. It requires a per-application adapter with write access to each app's user store, several of those applications belong to other businesses, and the value is far lower than storage and retrieval. Revisit per app, on demand.
