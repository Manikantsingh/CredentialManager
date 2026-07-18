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
| `manifest.json` | MV3 manifest. Permissions: `identity`, `storage`, `scripting`, `tabs`. Host permissions: `https://www.googleapis.com/*` plus `http://*/*` + `https://*/*` (for login detection). Registers the content script and `web_accessible_resources`. |
| `config.js` | User/config constants: `CLIENT_ID`, OAuth scopes, Drive folder/file names, crypto parameters, `AUTO_LOCK_MINUTES`, versions. |
| `crypto.js` | Key derivation (PBKDF2), AES‑GCM encrypt/decrypt, raw key export/import (for session cache), base64 helpers, vault envelope build/open, password generator. **Pure, side‑effect free — unit‑testable in Node.** |
| `messages.js` | Shared message‑type constants and storage keys used by the content script, service worker, and popup (auto‑detect feature). |
| `drive.js` | OAuth token acquisition/caching, Drive folder/file discovery, download, multipart upload. |
| `vault.js` | Vault domain model, in‑memory session, session persistence (`chrome.storage.session`) with idle auto‑lock, local cache, Drive sync orchestration, CRUD grouped by domain, domain normalization, capture classify/upsert, per‑site ignore list. |
| `popup.html` / `popup.css` | UI markup and styling (unlock screen, list, add/edit dialog, toast). |
| `popup.js` | UI controller: wires DOM events to `vault.js`, renders grouped list, dialogs; restores session on boot; handles pending detected captures. |
| `content/detector.js` | Content script injected into web pages. Detects login forms, captures the typed credential on submit, and renders the in‑page **Save/Update** banner in a closed Shadow DOM. Not an ES module. |
| `background.js` | MV3 service worker and **auto‑detect coordinator**: classifies captures, performs the upsert (or locked‑vault flow), maintains the ignore list, hands pending captures to the popup. |
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
- `credmanager_step1_<tabId>` — `{ username, regDomain, ts }`. 5‑min TTL. Stashes the
  email/username submitted on a step‑1 login page (no password field present, e.g. Google's
  email screen) so it can be paired with the password captured on the next page. Keyed by
  tab ID; cleared after use or when the tab navigates to a different registrable domain.
- `credmanager_pending_cap_<tabId>` — `{ cap, mode, domain, regDomain, ts }`. 2‑min TTL.
  Stashes a classified capture so it survives the page navigation that occurs after a
  successful login (before the user can click the save banner). The landing page re‑shows
  the banner by sending `GET_TAB_PENDING` on load. Cleared on save, dismiss/never, or when
  the tab navigates to a different registrable domain.

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

## 8. Auto‑detect & save credentials

CredManager detects logins entered on any website and offers to save/update them, without
the user opening the popup. Three components cooperate across the trust boundary.

### 8.1 Components
- **`content/detector.js`** (runs in the untrusted page, top frame, `document_idle`):
  - Finds visible `input[type=password]` fields and the best‑guess username/email field in
    the same form (scored by type, `autocomplete`, name/id/placeholder hints, DOM order).
  - Captures `{ url, username, password }` on `submit`, on Enter inside a password field,
    and on clicks of likely login/sign‑up buttons (covers SPA logins without a form submit).
  - On pages with no password field (e.g. Google's email‑only step), sends `STEP1_CAPTURE`
    instead, stashing the username in the background to pair with the password on the next page.
  - On page load (`document_idle`), sends `GET_TAB_PENDING` to re‑show any save banner whose
    login page navigated away before the user could respond (navigation‑survive flow). Passes
    `pageLoadTs` so the background can distinguish a pre‑existing stash from one written by
    `tryCapture()` on this same page.
  - Sends `CAPTURE` to the service worker; based on the returned `mode`, renders a banner in
    a **closed Shadow DOM** host so page CSS/scripts can't style or read it. Banner text is
    set via `textContent` only (no page‑controlled markup). Buttons: Save/Update, Not now,
    Never for this site. **Not now** and **Never** send `CLEAR_PENDING_CAPTURE` to discard
    the navigation‑survive stash so the banner does not re‑appear on the next page.
- **`background.js`** (service worker, ES module — the coordinator):
  - `CAPTURE` → skips ignored sites; if `username` is blank, checks for a stashed step‑1
    username (`credmanager_step1_<tabId>`) and merges it; calls `vault.classifyCapture()`
    (read‑only); fire‑and‑forgets a write of `credmanager_pending_cap_<tabId>` (navigation‑
    survive stash) before returning `{ mode, domain, username }`. Also keeps the capture in
    an in‑memory `Map` (2‑min TTL) for the locked flow.
  - `STEP1_CAPTURE` → writes `credmanager_step1_<tabId>` (5‑min TTL) with the email/username
    captured on a password‑less login step.
  - `SAVE_CONFIRM` → if unlocked, `vault.upsertCapture()`; if locked, stashes the capture in
    `chrome.storage.session` (`PENDING_CAPTURE_KEY`) and calls `chrome.action.openPopup()`
    (Chrome 127+) with a badge fallback. Both paths clear `credmanager_pending_cap_<tabId>`.
  - `GET_TAB_PENDING` → returns (and clears) `credmanager_pending_cap_<tabId>` when it exists,
    is within TTL, belongs to the same registrable domain, and was written before the
    requesting page loaded (the `pageLoadTs` guard prevents the same-page stash from being
    consumed prematurely, which would leave nothing for the landing page).
  - `CLEAR_PENDING_CAPTURE` → deletes `credmanager_pending_cap_<tabId>` (sent by Not now / Never).
  - `NEVER_SITE` → `vault.addIgnoredSite()`.
  - `GET_PENDING` → returns and clears the locked‑vault stash (called by the popup).
- **`popup.js`**:
  - After unlock (`showVaultScreen`), calls `GET_PENDING`; if a capture is waiting it opens
    the Add/Update dialog pre‑filled (Update mode when it matches an existing entry).
  - A `chrome.storage.onChanged` listener re‑runs `restoreSession()` + `renderList()` so the
    list stays fresh when the service worker saves while the popup is open (the popup and SW
    are **separate module instances** — `chrome.storage.session` is the bridge).

### 9.2 Message flow
```
 page (detector.js)                      service worker (background.js)
   step-1 submit     ──STEP1_CAPTURE──────► stash username in session (5 min TTL)

   step-2 submit     ──CAPTURE────────────► merge step-1 username if username==""
    (password found)                         classifyCapture()  (read-only)
                     ◄──{mode,domain,user}── fire-and-forget: write pending_cap stash
   [banner: Save / Update / Unlock / Never]
        Save ─────────SAVE_CONFIRM──────────► unlocked → upsertCapture() → {ok}
                                              locked   → stash + openPopup()/badge
                                              both     → clear pending_cap stash
        Not now ──────CLEAR_PENDING_CAPTURE─► delete pending_cap stash
        Never ─────────────────────────────► NEVER_SITE → addIgnoredSite()
              ────────CLEAR_PENDING_CAPTURE─► delete pending_cap stash

 landing page load  ──GET_TAB_PENDING──────► check pending_cap stash:
    (document_idle)   {url, pageLoadTs}       • wrong domain   → delete, return null
                                              • written after   → return null (same-page
                                                pageLoadTs        guard, keeps stash for
                                                                  landing page)
                                              • ok → delete stash, return {cap,mode,domain}
                     ◄──{cap,mode,domain}──
   [banner re-shown on landing page]

 popup (popup.js)   ──GET_PENDING───────────► return + clear locked-vault stash
                    ◄──{pending}────────────  → prefilled Add/Update dialog
```

### 9.3 Vault support (in `vault.js`)
- `classifyCapture({url,username,password})` — loads the session (via `restoreSession()`,
  so it works in the SW) and returns `mode` = `new` | `update` | `nochange` | `locked`
  **without mutating** the vault.
- `upsertCapture({url,username,password})` — requires unlocked; adds a new entry, updates the
  password of an existing `domain+username` match, or reports `nochange`. Reuses `addEntry` /
  `updateEntry` (so per‑domain isolation and local persistence are unchanged). Does **not**
  auto‑push to Drive.
- `findByDomainUsername(domain, username)` — case‑insensitive username match within a domain.
- `isIgnoredSite` / `addIgnoredSite` — per‑site ignore list in
  `chrome.storage.local` (`credmanager_ignored_sites`).

### 9.4 Security notes
- The content script is treated as **hostile**. Only the user‑typed capture flows
  page → extension; **no vault entries, other saved passwords, or keys are ever sent to the
  page.** The banner receives only a minimal `mode`/`domain`/`username` echo of what the user
  just typed.
- Plaintext captures live only in service‑worker memory and, for the locked flow, briefly in
  memory‑only `chrome.storage.session` (never on disk); they're cleared on save, on TTL, or
  when the popup consumes them.
- Broad host permissions (`http://*/*`, `https://*/*`) are required for detection and are
  disclosed to the user in the README.

### 8.5 Autofill on login pages

CredManager also fills saved credentials into login forms. Unlike the capture flow, autofill
must return a credential **to** the page, so it is scoped as tightly as possible.

- **`content/detector.js`** (`attachAutofill()`):
  - On `focusin` of a login field (a visible `input[type=password]`, or a username/email/text
    field in a form that has one — see `getLoginContext()`), it pins a small CredManager key
    icon to the field's right edge in a **closed Shadow DOM** host (`pointer-events:none` on
    the host so typing passes through; only the icon and menu are clickable).
  - Clicking the icon sends `AUTOFILL_QUERY` and renders a dropdown of matching **usernames
    only** (or an "Unlock CredManager" item when locked, which sends `OPEN_POPUP`).
  - Choosing an account sends `AUTOFILL_FILL { id }`; on success it fills the username and
    password via the native value setter and dispatches `input`/`change` so SPA frameworks
    register the change. The icon/menu dismiss on Escape, blur, scroll-away, or outside click.
- **`background.js`**:
  - `AUTOFILL_QUERY` → derives the domain from the **authenticated `sender.tab.url`** (never
    page-supplied), restores the session if needed, and returns
    `{ ok, locked, entries:[{id,username,url}] }` via `vault.listAutofillCandidates()`. No
    passwords are included.
  - `AUTOFILL_FILL { id }` → returns `{ ok, username, password }` for exactly one entry, and
    only if `vault.getAutofillSecret(id, sender.tab.url)` confirms the entry's `domain` matches
    the sender tab's domain. A hostile page cannot fish for another origin's credentials by
    guessing ids or spoofing a URL.
  - `OPEN_POPUP` → `openPopupSafely()` so the user can unlock, then re-open the picker.
- **Security trade-off:** filling inherently exposes the chosen credential to page JavaScript
  (true of every autofill). Exposure is minimized: the vault is never bulk-dumped, only
  usernames are listed until the user picks, a password is released one-at-a-time, the domain
  is verified server-side against the authenticated tab URL, and nothing is filled without an
  explicit click.


---

## 10. Domain handling

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
| Add autofill on login pages | Implemented — see §8.5. In-page picker (`content/detector.js` `attachAutofill()`), `AUTOFILL_QUERY`/`AUTOFILL_FILL`/`OPEN_POPUP` messages, and `vault.listAutofillCandidates()` / `vault.getAutofillSecret()`. |
| Automatic sync / conflict handling | `vault.js` sync functions; compare `modifiedTime`, consider entry‑level merge keyed by `id`+`updatedAt`. |
| Stronger KDF (Argon2id/scrypt) | Add vetted WASM lib; branch on `envelope.kdf.algo` in `openVaultEnvelope`; re‑wrap on next save; bump `VAULT_VERSION`. |
| Import/export | `vault.exportEnvelope()` already returns the encrypted envelope; add file download/upload UI. `decrypt-vault.mjs` shows the offline decrypt path. |
| Multiple algorithm choice | Reintroduce a cipher selector in `config`/UI and branch in `crypto.js`; keep GCM as default. |
| Tighten auto‑lock | Idle auto‑lock exists via `AUTO_LOCK_MINUTES` + `chrome.storage.session`. For hard timing independent of popup opens, add a `chrome.alarms` listener in `background.js` that clears the session cache. |

---

## 11. Known limitations

- Manual sync only; no automatic multi‑device conflict resolution (last‑write‑wins).
- OAuth token is memory‑only and expires ~1 h; a fresh interactive consent may be needed.
- Multi‑step logins (email on one page, password on the next — e.g. Google Sign‑In) are
  now handled via the step‑1 stash; however, heavily obfuscated or non‑standard flows
  (hidden fields, custom Web Components) may still not be detected.
- The save banner may appear on the page **after** login (the landing/dashboard page)
  rather than on the login page itself when the server redirects before the user can click;
  this is by design (navigation‑survive flow).
- Idle auto‑lock is enforced on popup open (not by a background timer), so the session
  cache can outlive `AUTO_LOCK_MINUTES` until the next open; see §10 for a hard‑timer option.
- PBKDF2 (not memory‑hard) — acceptable at 310k iterations but see §6.2 for the migration path.
- Recovery is impossible by design if the master password is lost (though
  `decrypt-vault.mjs` can decrypt a vault offline **if** you still know the master password).
