# Authentication — architecture boundary

Status: **not implemented.** This document defines the boundary an authentication system
must respect before any of it is built. The only authentication UI is a design preview
(`apps/desktop/src/preview/AuthPreview.tsx`), reachable in development builds at
`#preview/auth` and removed from production builds. Every field and provider button in it
is disabled and labelled "not connected".

## What exists today

- MORROW is a local, single-user desktop application. There is no server, no user,
  account, session or device record, and no identity provider.
- The database has no identity tables. Adding them requires a migration.
- Secrets are never stored in the database, only `secretRef`s into the OS credential
  store. The OS-keychain `SecretResolver` is declared but **not implemented**
  (`models/src/provider.ts`).
- The WebView has no OS authority (D1): it cannot open sockets, read files or hold
  secrets. Anything an identity flow needs (browser launch, loopback listener, keychain)
  belongs to the native layer.

## The first decision: what would sign-in protect?

A local-first app with no server has nothing remote to authorise. Before choosing
providers, decide which of these MORROW needs. They are different systems:

| Purpose | What it needs | Providers? |
|---|---|---|
| **Lock** the local environment (someone else at the machine) | A local unlock (OS authentication such as Windows Hello, or a passphrase) | No |
| **Protect data at rest** | Database encryption keyed from a passphrase or the OS keychain | No |
| **Identity** for future sync, connectors or multi-device use | An identity provider and server-side sessions | Yes |

Google, Discord, device sessions and recovery codes only make sense for the third.

## Boundary rules (whatever is built)

1. **Native owns identity.** OAuth runs in the system browser, never an embedded
   WebView. Use authorization code + PKCE (RFC 8252) with a loopback redirect or a
   registered deep link, handled by the Rust layer. The UI receives only the outcome.
2. **No client secrets in the app.** Desktop OAuth clients are public clients. No
   credential is ever hardcoded, bundled or committed.
3. **Tokens live in the OS keychain**, through the `SecretResolver`. They never go to
   SQLite, logs, events or the WebView.
4. **Providers are configuration, not code paths.** A provider appears in the UI only
   when it is configured and reachable. An unconfigured provider is not shown as
   available.
5. **Two-factor (TOTP, RFC 6238).** The shared secret lives in the keychain (or server
   side, if identity is remote). Recovery codes are generated once, shown once, and
   stored only as hashes (e.g. Argon2id). Each code is single use.
6. **Sessions and devices** are records a server issues and revokes. A local-only MORROW
   has no meaningful device list, and must not show one.
7. **Auth is not permission.** Signing in never grants tool capabilities. The permission
   engine stays the only authority over what MORROW may do.
8. **Events, not state leaks.** Sign-in, sign-out and failed attempts are recorded as
   typed events, without credentials, tokens or codes.

## What each capability would require

| Capability | Native (Rust) | Runtime / database | UI |
|---|---|---|---|
| Local unlock | OS authentication API; keychain | Lock state; no schema change | Lock screen (preview's sign-in layout) |
| Data at rest | Key from keychain or passphrase | Encrypted SQLite (e.g. SQLCipher) and a migration path for existing data | Passphrase setup and unlock |
| Google / Discord OAuth | System browser launch; loopback/deep link; PKCE; keychain | Account record (migration); provider configuration | Provider buttons, enabled only when configured |
| Email / password | — | Requires an identity server MORROW does not have | — |
| TOTP 2FA | Keychain for the secret | Enrolment state (migration) | Code entry (preview), enrolment QR |
| Recovery codes | — | Hashed codes (migration) | One-time display; code entry (preview) |
| Device sessions | — | Server-issued sessions | Session list and revoke (preview, empty) |

## Decisions required before implementation

1. Which purpose: lock, data at rest, identity, or a combination?
2. If identity: which identity provider or server, and where it runs.
3. Which OAuth providers, and who owns their client registrations.
4. Whether two-factor is required or optional, and the recovery policy.
5. Migration plan for the identity tables, plus the keychain `SecretResolver`
   implementation it depends on.
