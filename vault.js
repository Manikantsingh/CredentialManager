import {
  buildVaultEnvelope,
  openVaultEnvelope,
  deriveKey,
  exportRawKey,
  importRawKey,
  bufToBase64,
  randomBytes,
} from "./crypto.js";
import {
  getAccessToken,
  findOrCreateFolder,
  findVaultFile,
  downloadVault,
  uploadVault,
} from "./drive.js";
import { VAULT_VERSION, AUTO_LOCK_MINUTES } from "./config.js";

const LOCAL_ENVELOPE_KEY = "credmanager_envelope";
const LOCAL_META_KEY = "credmanager_meta"; // { fileId, folderId, modifiedTime }
const SESSION_KEY = "credmanager_session"; // { keyB64, saltB64, payload, lastActive }

// ---------- in-memory session (cleared on lock) ----------
let sessionKey = null;      // CryptoKey (memory-only, mirrored to storage.session)
let sessionSaltB64 = null;  // base64 salt
let payload = null;         // { entries: [...] }

export function isUnlocked() {
  return sessionKey !== null;
}

export function lock() {
  sessionKey = null;
  sessionSaltB64 = null;
  payload = null;
  // Clear the memory-only session cache too.
  try {
    chrome.storage.session.remove(SESSION_KEY);
  } catch {
    /* storage.session may be unavailable in non-extension contexts */
  }
}

// ---------- memory-only session cache (chrome.storage.session) ----------
// Keeps the vault unlocked across popup reopens for the browser session.
// storage.session lives in memory, is cleared when Chrome closes, and is never
// written to disk or synced to Drive.
async function saveSession() {
  if (!sessionKey || !sessionSaltB64 || AUTO_LOCK_MINUTES <= 0) return;
  try {
    const keyB64 = await exportRawKey(sessionKey);
    await chrome.storage.session.set({
      [SESSION_KEY]: {
        keyB64,
        saltB64: sessionSaltB64,
        payload,
        lastActive: Date.now(),
      },
    });
  } catch {
    /* ignore: persistence is best-effort */
  }
}

// Restore an unlocked session if one exists and hasn't idled out.
export async function restoreSession() {
  if (AUTO_LOCK_MINUTES <= 0) return false;
  try {
    const obj = await chrome.storage.session.get(SESSION_KEY);
    const s = obj[SESSION_KEY];
    if (!s) return false;
    const idleMs = Date.now() - (s.lastActive || 0);
    if (idleMs > AUTO_LOCK_MINUTES * 60000) {
      await chrome.storage.session.remove(SESSION_KEY);
      return false;
    }
    sessionKey = await importRawKey(s.keyB64);
    sessionSaltB64 = s.saltB64;
    payload = s.payload;
    await saveSession(); // refresh lastActive
    return true;
  } catch {
    return false;
  }
}

function emptyPayload() {
  return { schema: VAULT_VERSION, entries: [] };
}

function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = randomBytes(16);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0"));
  return `${h[0]}${h[1]}${h[2]}${h[3]}-${h[4]}${h[5]}-${h[6]}${h[7]}-${h[8]}${h[9]}-${h[10]}${h[11]}${h[12]}${h[13]}${h[14]}${h[15]}`;
}

// ---------- local cache ----------
async function getLocal(key) {
  const obj = await chrome.storage.local.get(key);
  return obj[key];
}
async function setLocal(key, value) {
  await chrome.storage.local.set({ [key]: value });
}

export async function hasLocalVault() {
  return !!(await getLocal(LOCAL_ENVELOPE_KEY));
}

// ---------- unlock flows ----------

// Create a brand-new vault protected by masterPassword.
export async function createVault(masterPassword) {
  const salt = randomBytes(16);
  sessionSaltB64 = bufToBase64(salt);
  sessionKey = await deriveKey(masterPassword, salt.buffer);
  payload = emptyPayload();
  await persistLocalEnvelope();
  await saveSession();
  return payload;
}

// Unlock using the locally cached encrypted envelope.
export async function unlockFromLocal(masterPassword) {
  const envelope = await getLocal(LOCAL_ENVELOPE_KEY);
  if (!envelope) throw new Error("No local vault found.");
  const { key, payload: p } = await openVaultEnvelope(masterPassword, envelope);
  sessionKey = key;
  sessionSaltB64 = envelope.kdf.salt;
  payload = p;
  await saveSession();
  return payload;
}

// ---------- persistence ----------
async function persistLocalEnvelope() {
  if (!sessionKey || !sessionSaltB64) throw new Error("Vault is locked.");
  const envelope = await buildVaultEnvelope(sessionKey, sessionSaltB64, payload);
  await setLocal(LOCAL_ENVELOPE_KEY, envelope);
  await saveSession();
  return envelope;
}

// ---------- Google Drive sync ----------

// Pull the vault from Drive. If a local session is unlocked, decrypt with the
// current key; otherwise store the envelope locally to be unlocked next.
export async function syncFromDrive(interactive = true) {
  const token = await getAccessToken(interactive);
  const folderId = await findOrCreateFolder(token);
  const file = await findVaultFile(token, folderId);
  const meta = { folderId, fileId: file ? file.id : null, modifiedTime: file ? file.modifiedTime : null };
  await setLocal(LOCAL_META_KEY, meta);

  if (!file) {
    return { pulled: false, reason: "No vault file in Drive yet." };
  }
  const envelope = await downloadVault(token, file.id);
  await setLocal(LOCAL_ENVELOPE_KEY, envelope);

  // The pulled envelope may have been created on another device (different salt),
  // so it must be unlocked with the master password. Lock the session and let the
  // caller re-unlock against the freshly pulled envelope.
  lock();
  return { pulled: true, meta };
}

// Push current (unlocked) payload to Drive.
export async function syncToDrive(interactive = true) {
  if (!sessionKey) throw new Error("Unlock the vault before syncing to Drive.");
  const envelope = await persistLocalEnvelope();
  const token = await getAccessToken(interactive);
  let meta = (await getLocal(LOCAL_META_KEY)) || {};
  if (!meta.folderId) meta.folderId = await findOrCreateFolder(token);
  if (!meta.fileId) {
    const existing = await findVaultFile(token, meta.folderId);
    if (existing) meta.fileId = existing.id;
  }
  const result = await uploadVault(token, {
    fileId: meta.fileId,
    folderId: meta.folderId,
    content: envelope,
  });
  meta.fileId = result.id;
  meta.modifiedTime = result.modifiedTime;
  await setLocal(LOCAL_META_KEY, meta);
  return meta;
}

// ---------- CRUD (grouped by domain) ----------

export function normalizeDomain(input) {
  if (!input) return "";
  let s = input.trim();
  try {
    if (!/^[a-z]+:\/\//i.test(s)) s = "https://" + s;
    const u = new URL(s);
    return u.hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return input.trim().toLowerCase();
  }
}

export function getEntries() {
  return payload ? payload.entries.slice() : [];
}

export function getEntriesByDomain() {
  const map = new Map();
  for (const e of getEntries()) {
    const key = e.domain || "(unknown)";
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(e);
  }
  return map;
}

export async function addEntry({ domain, url, username, password, notes }) {
  if (!sessionKey) throw new Error("Vault is locked.");
  const now = Date.now();
  const entry = {
    id: uuid(),
    domain: normalizeDomain(domain || url),
    url: url || "",
    username: username || "",
    password: password || "",
    notes: notes || "",
    createdAt: now,
    updatedAt: now,
  };
  payload.entries.push(entry);
  await persistLocalEnvelope();
  return entry;
}

export async function updateEntry(id, fields) {
  if (!sessionKey) throw new Error("Vault is locked.");
  const e = payload.entries.find((x) => x.id === id);
  if (!e) throw new Error("Entry not found.");
  if (fields.domain !== undefined || fields.url !== undefined) {
    e.domain = normalizeDomain(fields.domain ?? e.domain ?? fields.url ?? e.url);
  }
  for (const k of ["url", "username", "password", "notes"]) {
    if (fields[k] !== undefined) e[k] = fields[k];
  }
  e.updatedAt = Date.now();
  await persistLocalEnvelope();
  return e;
}

export async function deleteEntry(id) {
  if (!sessionKey) throw new Error("Vault is locked.");
  const before = payload.entries.length;
  payload.entries = payload.entries.filter((x) => x.id !== id);
  if (payload.entries.length !== before) await persistLocalEnvelope();
}

export function exportEnvelope() {
  return getLocal(LOCAL_ENVELOPE_KEY);
}
