# CredManager — System Design

Technical reference for developers maintaining or extending CredManager. Read this
alongside the code; it explains *why* things are the way they are so you can ramp up fast.

---

## 1. Overview

CredManager is a **Manifest V3 Chrome extension** that acts as a personal, zero‑knowledge
credentials manager. Credentials are encrypted client‑side with **AES‑GCM 256** and the
resulting ciphertext is synced to the user's **own Google Drive**. The master password
never leaves the device; Drive and any third party only ever see an encrypted envelope.

**Core guarantees**
- Zero‑knowledge: plaintext and the master password never leave the client.
- Per‑domain isolation: each credential is a distinct record keyed by its own UUID and
  grouped by domain. Identical username/password on different domains remain separate.
- Offline‑capable: an encrypted copy of the vault is cached in `chrome.storage.local`.

---

## 2. Technology stack

| Area | Choice | Notes |
|------|--------|-------|
| Platform | Chrome Extension **Manifest V3** | `minimum_chrome_version` 102 |
| Language | Vanilla JS **ES modules** | No build step, no framework, no dependencies |
| Crypto | **Web Crypto API** (`crypto.subtle`) | Native, audited, constant‑time primitives |
| Storage (local) | `chrome.storage.local` | Encrypted envelope + sync metadata (persists on disk) |
| Storage (session) | `chrome.storage.session` | Unlocked key + payload cache (memory‑only, cleared on browser close) |
| Auth | `chrome.identity.launchWebAuthFlow` | OAuth 2.0 implicit flow |
| Cloud | **Google Drive REST API v3** | Scope `drive.file` |
| UI | HTML/CSS + a single popup controller | Dark theme, no external assets |

**Deliberately no dependencies / no bundler.** The entire security surface is auditable
in a few small files, and there is no supply‑chain risk from npm packages. Load‑unpacked
runs the source directly.

---

## 3. File map

| File | Responsibility |
|------|----------------|
| `manifest.json` | MV3 manifest. Permissions: `identity`, `storage`. Host permission: `https://www.googleapis.com/*`. |
| `config.js` | User/config constants: `CLIENT_ID`, OAuth scopes, Drive folder/file names, crypto parameters, `AUTO_LOCK_MINUTES`, versions. |
| `crypto.js` | Key derivation (PBKDF2), AES‑GCM encrypt/decrypt, raw key export/import (for session cache), base64 helpers, vault envelope build/open, password generator. **Pure, side‑effect free — unit‑testable in Node.** |
| `drive.js` | OAuth token acquisition/caching, Drive folder/file discovery, download, multipart upload. |
| `vault.js` | Vault domain model, in‑memory session, session persistence (`chrome.storage.session`) with idle auto‑lock, local cache, Drive sync orchestration, CRUD grouped by domain, domain normalization. |
| `popup.html` / `popup.css` | UI markup and styling (unlock screen, list, add/edit dialog, toast). |
| `popup.js` | UI controller: wires DOM events to `vault.js`, renders grouped list, dialogs; restores session on boot. |
| `background.js` | Minimal MV3 service worker (install hook). No secrets held here. |
| `decrypt-vault.mjs` | Standalone Node CLI to decrypt a vault envelope locally (recovery/verification). Prompts for the master password; nothing leaves the machine. |
| `make_icons.py` | Regenerates padlock PNG icons (pure‑Python PNG encoder, no PIL). |
| `icons/` | 16/48/128 px icons. |

---

## 4. Architecture & data flow

```
        ┌────────────────────────── Popup (popup.js) ──────────────────────────┐
        │  Unlock screen · Credential list · Add/Edit dialog · Sync buttons     │
        └───────────────┬───────────────────────────────────────┬──────────────┘
                        │ calls                                  │ calls
                 ┌──────▼──────┐                          ┌──────▼──────┐
                 │  vault.js   │  in‑memory key + payload │  crypto.js  │  (pure)
                 │  (session)  │◄─────────────────────────┤  PBKDF2 +   │
                 └──┬───────┬──┘                          │  AES‑GCM    │
       persist local│       │ sync                        └─────────────┘
        (ciphertext)│       │
        ┌───────────▼──┐ ┌──▼──────────┐  Bearer token   ┌───────────────────┐
        │chrome.storage│ │  drive.js   ├────────────────►│ Google Drive API  │
        │   .local     │ │  (OAuth +   │◄────────────────┤ (ciphertext only) │
        └──────────────┘ │   REST)     │  envelope JSON   └───────────────────┘
                         └─────────────┘
```

**Trust boundary:** the plaintext credentials and the derived AES key exist **only** in
the popup's memory (module‑scoped variables in `vault.js`). They are never written to
disk or sent over the network. Everything crossing the boundary to `chrome.storage.local`
or Google Drive is the encrypted **envelope**.

**Session lifecycle**
1. Popup opens → `boot()` calls `vault.restoreSession()`. If a valid, non‑idle session
   exists in `chrome.storage.session`, the vault opens straight to the list; otherwise it
   is empty (locked) and shows the unlock screen.
2. User unlocks → master password + stored salt derive the AES key (held in memory and
   mirrored to `chrome.storage.session` for cross‑popup persistence — see §4.1).
3. Popup closes → in‑memory variables vanish, but the session cache keeps the vault
   unlocked so reopening within the idle window does not re‑prompt.
4. **Lock** clicked, browser closed, or idle timeout exceeded → `lock()` nulls the key,
   salt, and payload and clears the session cache.

### 4.1 Unlock persistence (`chrome.storage.session`)
MV3 popups are torn down whenever they lose focus (e.g. the Google sign‑in window opens),
which would otherwise re‑lock the vault mid‑task. To avoid this, on unlock the derived key
is exported (`exportRawKey`) and cached — together with the salt, decrypted payload, and a
`lastActive` timestamp — in `chrome.storage.session`.

- `chrome.storage.session` is **memory‑only**: it is never written to disk and is wiped
  when Chrome fully closes. It is **not** synced to Drive.
- On popup open, `restoreSession()` re‑imports the key (`importRawKey`) if
  `now - lastActive <= AUTO_LOCK_MINUTES` (see `config.js`); otherwise it clears the cache
  and requires re‑unlock (idle auto‑lock). Set `AUTO_LOCK_MINUTES = 0` to disable
  persistence entirely (lock on every popup close).
- Trade‑off: the derived key lives in memory‑only session storage for the idle window
  instead of only in the popup's variables. This is the reason `deriveKey` uses
  `extractable = true` (see §6.2).

---

## 5. Data formats

### 5.1 Encrypted vault envelope (stored in Drive **and** local cache)
```json
{
  "version": 1,
  "cipher": "AES-GCM-256",
  "kdf": {
    "algo": "PBKDF2",
    "hash": "SHA-256",
    "iterations": 310000,
    "salt": "<base64 16 bytes>"
  },
  "iv": "<base64 12 bytes>",
  "data": "<base64 AES-GCM ciphertext (includes 128-bit auth tag)>"
}
```
The KDF parameters travel *with* the envelope so a vault created on one device can be
opened on another (and so iteration counts can be raised in future without breaking old
vaults).

### 5.2 Decrypted payload (never persisted in plaintext)
```json
{
  "schema": 1,
  "entries": [
    {
      "id": "uuid-v4",
      "domain": "example.com",
      "url": "https://example.com/login",
      "username": "alice",
      "password": "…",
      "notes": "",
      "createdAt": 1730000000000,
      "updatedAt": 1730000000000
    }
  ]
}
```

### 5.3 Local storage (`chrome.storage.local`, on disk)
- `credmanager_envelope` — the encrypted envelope (offline cache).
- `credmanager_meta` — `{ folderId, fileId, modifiedTime }` for Drive.

### 5.4 Session cache (`chrome.storage.session`, memory‑only)
- `credmanager_session` — `{ keyB64, saltB64, payload, lastActive }`. Holds the exported
  raw AES key and decrypted payload so the vault stays unlocked across popup reopens.
  Never written to disk, never synced to Drive, cleared on browser close, on **Lock**, and
  on idle timeout (`AUTO_LOCK_MINUTES`).

---

## 6. Encryption design & rationale

This is the security core; changes here must be made carefully.

### 6.1 Cipher: AES‑GCM with a 256‑bit key
- **Why AES‑GCM:** it is an **AEAD** cipher — it provides *confidentiality* **and**
  *integrity/authenticity* in one primitive. The built‑in 128‑bit authentication tag
  means any tampering with the ciphertext (or a wrong key) causes `decrypt()` to throw,
  rather than silently returning garbage. This is exactly what we want for a vault synced
  through third‑party storage.
- **Why 256‑bit:** maximal margin against brute force, negligible performance cost for our
  small payloads, and it is the modern default recommendation.
- **Why not AES‑CBC / others:** CBC provides no built‑in integrity (needs a separate HMAC
  and is padding‑oracle prone if misused). GCM avoids that whole class of mistakes. We
  intentionally standardized on a single, hard‑to‑misuse algorithm rather than offering a
  menu of ciphers where a user could pick a weaker one.
- **Nonce (IV):** a fresh **96‑bit (12‑byte)** random IV is generated for **every**
  encryption via `crypto.getRandomValues`. 96 bits is the size GCM is optimized for, and a
  new IV per write prevents catastrophic nonce reuse. The IV is stored (non‑secret) in the
  envelope.

### 6.2 Key derivation: PBKDF2‑HMAC‑SHA256
- **Why derive a key at all:** the AES key must come from the human master password, but
  passwords are low‑entropy. A KDF stretches the password and binds it to a random salt.
- **Why PBKDF2:** it is available **natively** in the Web Crypto API (`deriveKey`),
  standardized (RFC 8018), and requires no third‑party library — keeping the zero‑dependency
  guarantee and avoiding shipping our own crypto.
- **Parameters:**
  - **310,000 iterations** — aligns with the OWASP recommendation for PBKDF2‑HMAC‑SHA256,
    slowing offline brute‑force of the master password.
  - **128‑bit random salt** per vault — prevents rainbow‑table/precomputation attacks and
    ensures two users with the same password get different keys.
  - Output: a 256‑bit AES‑GCM key. The key is derived as **extractable**
    (`extractable = true`) so it can be exported and cached in the memory‑only
    `chrome.storage.session` to keep the vault unlocked across popup reopens (see §4.1).
    The exported key never touches disk and never leaves the device; if you prefer a
    stricter posture, set `AUTO_LOCK_MINUTES = 0` — the key is then never exported and
    lives only in the popup's memory for the lifetime of a single popup.
- **Known trade‑off / future work:** memory‑hard KDFs (**scrypt** or **Argon2id**) resist
  GPU/ASIC cracking better than PBKDF2. They are not in Web Crypto today, so adopting one
  means bundling a vetted WASM implementation. The envelope's `kdf` block is versioned
  precisely so we can migrate: on unlock, read `kdf.algo`, and on next save re‑wrap with a
  stronger KDF. Iteration count can likewise be raised transparently.

### 6.3 Zero‑knowledge property
The master password is only ever passed to `deriveKey` in memory. Neither the password nor
the derived key nor the plaintext payload is written to storage or sent to any network
endpoint. Drive receives only Section 5.1's envelope. Therefore compromise of the Google
account or the Drive file does **not** reveal credentials without the master password.

### 6.4 Threat model (what is / isn't covered)
- **Covered:** cloud storage compromise, network eavesdropping, at‑rest disk inspection
  (local cache is ciphertext), tampering (GCM auth tag), rainbow tables (per‑vault salt).
- **Not covered:** a compromised local machine (keylogger/malware capturing the master
  password or reading popup memory), a malicious Chrome build, or the user choosing a weak
  master password. Client‑side encryption cannot defend a fully compromised endpoint.

---

## 7. Google Drive integration

- **Auth:** OAuth 2.0 **implicit flow** via `chrome.identity.launchWebAuthFlow`. We request
  `response_type=token`; the access token is parsed from the redirect URL fragment and
  cached in memory in `drive.js` with its `expires_in` (re‑requested ~60 s before expiry).
  No client secret and no refresh token are stored — appropriate for a public client.
- **Redirect URI:** `https://<EXTENSION_ID>.chromiumapp.org/` (from
  `chrome.identity.getRedirectURL()`), which must be registered on the OAuth client.
- **Scope:** `https://www.googleapis.com/auth/drive.file` — least privilege. The app can
  only access files/folders it created; it cannot read the user's other Drive content.
- **Storage layout:** a `CredManager` folder (visible in My Drive) containing
  `credmanager-vault.json`. `drive.js` finds‑or‑creates the folder, locates the file, and
  uploads via **multipart** (`PATCH` when `fileId` known, else `POST`).
- **401 handling:** `driveFetch` clears the cached token and surfaces a "sign in again"
  error so the UI can re‑prompt.

### Sync model
Sync is **manual, last‑write‑wins**, chosen for simplicity and predictability:
- **Push (`syncToDrive`)** — re‑encrypts the current payload, uploads the envelope,
  updates local `meta`.
- **Pull (`syncFromDrive`)** — downloads the envelope, overwrites the local cache, then
  **locks the session** and requires re‑unlock. This is intentional: a pulled vault may
  come from another device with a *different salt*, so the in‑memory key is invalid and the
  user must re‑derive it against the pulled envelope's KDF parameters.

There is no automatic merge/conflict resolution yet (see Future work).

---

## 8. Domain handling

`normalizeDomain()` in `vault.js` canonicalizes input to a hostname:
- Prefixes a scheme if missing, parses with `URL`, lowercases, strips a leading `www.`.
- Falls back to a trimmed/lowercased string if parsing fails.

`getEntriesByDomain()` groups entries into a `Map<domain, entry[]>` for the UI. Because each
entry carries its own `id`, identical `{username,password}` under different domains are
independent records — satisfying the per‑domain requirement.

---

## 9. Testing & verification

- **Syntax:** every module passes `node --check` (validated as ESM).
- **Crypto/vault self‑test** (run ad‑hoc in Node with `webcrypto` polyfilled) covers:
  encrypt→decrypt round‑trip, wrong‑password rejection (GCM auth failure), per‑domain
  distinctness, password‑generator length, and raw key export→import (session cache path).
- To re‑run such a test in Node, alias `globalThis.crypto = require('node:crypto').webcrypto`
  and import the pure functions from `crypto.js` (add a temporary `package.json` with
  `{"type":"module"}` or use an `.mjs` shim).
- **`decrypt-vault.mjs`** doubles as a manual verification tool: point it at an exported
  vault envelope, enter the master password, and confirm the plaintext entries decrypt.

Because `crypto.js` is pure and dependency‑free, it is the natural target for a proper unit
test suite (recommended next addition).

---

## 10. Extending the project — pointers

| Task | Where to start |
|------|----------------|
| Add autofill on login pages | New content script + `scripting`/`activeTab` permission; read entries by matching `location.hostname` to `domain`. |
| Automatic sync / conflict handling | `vault.js` sync functions; compare `modifiedTime`, consider entry‑level merge keyed by `id`+`updatedAt`. |
| Stronger KDF (Argon2id/scrypt) | Add vetted WASM lib; branch on `envelope.kdf.algo` in `openVaultEnvelope`; re‑wrap on next save; bump `VAULT_VERSION`. |
| Import/export | `vault.exportEnvelope()` already returns the encrypted envelope; add file download/upload UI. `decrypt-vault.mjs` shows the offline decrypt path. |
| Multiple algorithm choice | Reintroduce a cipher selector in `config`/UI and branch in `crypto.js`; keep GCM as default. |
| Tighten auto‑lock | Idle auto‑lock exists via `AUTO_LOCK_MINUTES` + `chrome.storage.session`. For hard timing independent of popup opens, add a `chrome.alarms` listener in `background.js` that clears the session cache. |

---

## 11. Known limitations

- Manual sync only; no automatic multi‑device conflict resolution (last‑write‑wins).
- OAuth token is memory‑only and expires ~1 h; a fresh interactive consent may be needed.
- No autofill yet (copy‑to‑clipboard only).
- Idle auto‑lock is enforced on popup open (not by a background timer), so the session
  cache can outlive `AUTO_LOCK_MINUTES` until the next open; see §10 for a hard‑timer option.
- PBKDF2 (not memory‑hard) — acceptable at 310k iterations but see §6.2 for the migration path.
- Recovery is impossible by design if the master password is lost (though
  `decrypt-vault.mjs` can decrypt a vault offline **if** you still know the master password).
