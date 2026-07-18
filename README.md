# CredManager

**Your personal password manager that lives in Chrome and syncs to your own Google Drive — fully encrypted.**

CredManager is a Chrome extension that safely stores the usernames and passwords
you use on websites. Everything is locked with **one master password that only you
know**. Your saved logins are encrypted on your computer *before* they are ever sent
anywhere, so even Google Drive only sees scrambled data.

---

## What it does

- 🔐 **Stores your website logins securely** using strong AES‑GCM 256 encryption.
- 🔑 **Protected by a single master password.** You remember one password; it unlocks all the others.
- ☁️ **Syncs to your own Google Drive** so you can back up and move your vault between computers.
- 🗂️ **Keeps a separate entry for every website.** If you use the same username and
  password on two different sites, they are still saved as two separate logins.
- 🔍 **Search, add, edit, delete, and copy** usernames/passwords in one click.
- 🎲 **Generates strong random passwords** for you.
- 💾 **Works offline.** Your encrypted vault is cached locally, so you can unlock it without internet.

> **Zero‑knowledge:** Your master password and your decrypted passwords never leave your
> device. Google Drive only ever receives an encrypted file it cannot read.

---

## Important — please read first

- **Your master password cannot be recovered.** There is no "forgot password" option by
  design. If you lose it, your saved logins cannot be decrypted by anyone — including you.
  Choose something strong that you will remember, or keep it somewhere safe.
- **Back up regularly** by pushing your vault to Google Drive (see below).

---

## Getting started

### Step 1 — Install the extension
1. Download/clone this project folder (`CredManager`) to your computer.
2. Open Chrome and go to `chrome://extensions`.
3. Turn on **Developer mode** (toggle in the top‑right corner).
4. Click **Load unpacked** and choose the `CredManager` folder.
5. The CredManager icon (a padlock) appears in your toolbar. **Copy the extension ID**
   shown on its card — you'll need it in Step 2.

### Step 2 — Connect it to Google Drive (one‑time)
This lets CredManager save your encrypted vault to *your* Drive. You only do this once.

1. Go to the [Google Cloud Console](https://console.cloud.google.com/) and create a
   project (or pick an existing one).
2. Open **APIs & Services → Library**, search for **Google Drive API**, and click **Enable**.
3. Open **APIs & Services → OAuth consent screen**:
   - Choose **External**, fill in the required app name/email.
   - Add your own Google account under **Test users**.
4. Open **APIs & Services → Credentials → Create credentials → OAuth client ID**:
   - Application type: **Web application**.
   - Under **Authorized redirect URIs**, add this (replace `<EXTENSION_ID>` with the ID
     you copied in Step 1):

     ```
     https://<EXTENSION_ID>.chromiumapp.org/
     ```
   - Click **Create** and copy the **Client ID**.
5. Open the file `config.js` in the project and paste your Client ID:

   ```js
   export const CLIENT_ID = "YOUR_CLIENT_ID.apps.googleusercontent.com";
   ```
6. Go back to `chrome://extensions` and click the **reload** icon on the CredManager card.

> Don't want Drive sync yet? You can skip Step 2 and still use CredManager locally.
> The Drive buttons simply won't work until a Client ID is configured.

### Step 3 — Create your vault
1. Click the CredManager icon in the toolbar.
2. Enter a **master password** (at least 8 characters), confirm it, and click
   **Create new vault**.
3. That's it — you're ready to save logins.

---

## Everyday use

| I want to… | Do this |
|------------|---------|
| **Add a login** | Click **+ Add**, enter the website, username, and password (or click ⚙ to generate one), then **Save**. |
| **Find a login** | Type a website or username in the search box. |
| **Copy a username/password** | Click the 👤 or 🔑 button next to the entry. |
| **Edit or delete** | Click ✎ to edit or 🗑 to delete an entry. |
| **Back up to Drive** | Click **↑ Push to Drive**. |
| **Restore on another computer** | Install + configure the extension, then click **Load vault from Google Drive**, approve access, and unlock with your master password. |
| **Lock the vault** | Click **Lock** (top‑right). It also locks automatically after 15 minutes of inactivity, or when you close Chrome. |

> **Staying unlocked:** For convenience the vault stays unlocked when you reopen the popup
> (for example after the Google sign‑in window appears), until you click **Lock**, close
> Chrome, or 15 minutes of inactivity pass. You can change or disable this timeout with the
> `AUTO_LOCK_MINUTES` setting in `config.js` (set it to `0` to lock every time the popup closes).

### About Google Drive sync
- Your encrypted vault is saved as `credmanager-vault.json` inside a folder called
  **CredManager** in your Google Drive.
- Sync is **manual**: use **↑ Push** to upload your latest changes and **↓ Pull** to
  download the copy from Drive. After a pull you'll re‑enter your master password.
- CredManager can only see the files it creates in your Drive — it cannot read anything else.

---

## Frequently asked questions

**Is my data safe if someone gets my Google account?**
They would only find an encrypted file. Without your master password it cannot be read.

**Can CredManager or its author see my passwords?**
No. Encryption happens on your device and the master password is never stored or transmitted.

**What if I forget my master password?**
Unfortunately the data cannot be recovered. This is a deliberate security trade‑off — no
one, including the developer, can decrypt your vault without the master password.

**Can I read my vault outside the extension?**
Yes, as long as you know your master password. A small helper script, `decrypt-vault.mjs`,
can decrypt an exported vault file locally on your computer (see *Advanced* below). It's
useful for backups or verifying your data.

**Does it autofill login forms?**
Not yet — you copy the username/password with one click. Autofill can be added later.

**Where is my vault stored on my computer?**
In Chrome's encrypted local extension storage, as ciphertext (never in plain text). While
unlocked, the key is held in Chrome's in‑memory session storage only — never written to disk.

---

## Advanced: decrypt your vault outside Chrome

If you ever want to inspect or back up your credentials outside the extension, you can
decrypt a vault file on your own machine. This still requires your master password —
nothing is sent anywhere.

1. Get the encrypted vault JSON: either download `credmanager-vault.json` from the
   **CredManager** folder in Google Drive, or copy the envelope text.
2. Make sure [Node.js](https://nodejs.org/) is installed.
3. In the project folder run:
   ```
   node decrypt-vault.mjs credmanager-vault.json
   ```
   (Or run `node decrypt-vault.mjs` and paste the JSON.)
4. Enter your master password when prompted. Your decrypted logins are printed to the screen.

> Only run this on a computer you trust — the decrypted passwords are shown in plain text.

## For developers
See **[systemDesign.md](./systemDesign.md)** for architecture, data formats, the
encryption design and rationale, and a file‑by‑file guide to ramp up quickly.
