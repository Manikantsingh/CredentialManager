import {
  PBKDF2_ITERATIONS,
  PBKDF2_HASH,
  CIPHER,
  VAULT_VERSION,
} from "./config.js";

// ---------- base64 helpers ----------
export function bufToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

export function base64ToBuf(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

// ---------- key derivation ----------
export function randomBytes(len) {
  return crypto.getRandomValues(new Uint8Array(len));
}

// Derive an AES-GCM 256 key from a master password using PBKDF2-SHA256.
// `extractable` controls whether the raw key bytes can be exported; this is
// enabled only so the key can be cached in chrome.storage.session (memory-only)
// to keep the vault unlocked across popup reopens within a browser session.
export async function deriveKey(
  masterPassword,
  saltBuf,
  iterations = PBKDF2_ITERATIONS,
  extractable = true
) {
  const baseKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(masterPassword),
    { name: "PBKDF2" },
    false,
    ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: saltBuf,
      iterations,
      hash: PBKDF2_HASH,
    },
    baseKey,
    { name: "AES-GCM", length: 256 },
    extractable,
    ["encrypt", "decrypt"]
  );
}

// Export/import the raw AES key for in-memory session caching.
export async function exportRawKey(key) {
  const raw = await crypto.subtle.exportKey("raw", key);
  return bufToBase64(raw);
}

export async function importRawKey(rawB64) {
  return crypto.subtle.importKey(
    "raw",
    base64ToBuf(rawB64),
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"]
  );
}

// ---------- encrypt / decrypt an arbitrary JSON object ----------
export async function encryptObject(key, obj) {
  const iv = randomBytes(12); // 96-bit nonce recommended for AES-GCM
  const plaintext = enc.encode(JSON.stringify(obj));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    plaintext
  );
  return { iv: bufToBase64(iv), data: bufToBase64(ciphertext) };
}

export async function decryptObject(key, ivB64, dataB64) {
  const iv = new Uint8Array(base64ToBuf(ivB64));
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    key,
    base64ToBuf(dataB64)
  );
  return JSON.parse(dec.decode(plaintext));
}

// ---------- full vault envelope (what is stored in Drive) ----------
// {
//   version, cipher, kdf: {algo, hash, iterations, salt}, iv, data
// }
export async function buildVaultEnvelope(key, saltB64, payload) {
  const { iv, data } = await encryptObject(key, payload);
  return {
    version: VAULT_VERSION,
    cipher: CIPHER,
    kdf: {
      algo: "PBKDF2",
      hash: PBKDF2_HASH,
      iterations: PBKDF2_ITERATIONS,
      salt: saltB64,
    },
    iv,
    data,
  };
}

export async function openVaultEnvelope(masterPassword, envelope) {
  const saltBuf = base64ToBuf(envelope.kdf.salt);
  const iterations = envelope.kdf.iterations || PBKDF2_ITERATIONS;
  const key = await deriveKey(masterPassword, saltBuf, iterations);
  const payload = await decryptObject(key, envelope.iv, envelope.data);
  return { key, payload };
}

// ---------- password generator ----------
export function generatePassword(length = 20, opts = {}) {
  const {
    lower = true,
    upper = true,
    digits = true,
    symbols = true,
  } = opts;
  let alphabet = "";
  if (lower) alphabet += "abcdefghijklmnopqrstuvwxyz";
  if (upper) alphabet += "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  if (digits) alphabet += "0123456789";
  if (symbols) alphabet += "!@#$%^&*()-_=+[]{};:,.?";
  if (!alphabet) alphabet = "abcdefghijklmnopqrstuvwxyz";
  const out = [];
  const rnd = crypto.getRandomValues(new Uint32Array(length));
  for (let i = 0; i < length; i++) {
    out.push(alphabet[rnd[i] % alphabet.length]);
  }
  return out.join("");
}
