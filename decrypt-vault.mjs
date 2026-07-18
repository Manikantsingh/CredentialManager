// Local vault decryptor for CredManager.
// Usage:
//   node decrypt-vault.mjs path\to\vault.json
//   node decrypt-vault.mjs            (then paste the JSON, end with an empty line)
//
// You will be prompted for your master password. Nothing is sent anywhere —
// decryption happens entirely on your machine using Node's built-in crypto.

import { webcrypto as crypto } from "node:crypto";
import { readFileSync } from "node:fs";
import readline from "node:readline";

const dec = new TextDecoder();

function base64ToBuf(b64) {
  return Buffer.from(b64, "base64");
}

async function deriveKey(password, saltBuf, iterations, hash) {
  const baseKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    { name: "PBKDF2" },
    false,
    ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: saltBuf, iterations, hash },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"]
  );
}

function ask(question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    if (hidden) {
      const stdout = process.stdout;
      rl._writeToOutput = () => stdout.write("");
      stdout.write(question);
    }
    rl.question(hidden ? "" : question, (answer) => {
      rl.close();
      if (hidden) stdout.write("\n");
      resolve(answer);
    });
  });
}

function readAllStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => resolve(data));
  });
}

async function main() {
  const fileArg = process.argv[2];
  let raw;
  if (fileArg) {
    raw = readFileSync(fileArg, "utf8");
  } else {
    console.log("Paste the vault JSON, then press Ctrl+Z + Enter (Windows) to finish:");
    raw = await readAllStdin();
  }

  let envelope;
  try {
    envelope = JSON.parse(raw);
  } catch {
    console.error("ERROR: input is not valid JSON.");
    process.exit(1);
  }

  if (!envelope.kdf || !envelope.iv || !envelope.data) {
    console.error("ERROR: this does not look like a CredManager vault envelope.");
    process.exit(1);
  }

  const password = await ask("Master password: ", { hidden: true });

  try {
    const saltBuf = base64ToBuf(envelope.kdf.salt);
    const key = await deriveKey(
      password,
      saltBuf,
      envelope.kdf.iterations || 310000,
      envelope.kdf.hash || "SHA-256"
    );
    const iv = base64ToBuf(envelope.iv);
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv },
      key,
      base64ToBuf(envelope.data)
    );
    const payload = JSON.parse(dec.decode(plaintext));

    console.log("\n=== Decrypted vault ===");
    const entries = payload.entries || [];
    console.log(`Entries: ${entries.length}\n`);
    for (const e of entries) {
      console.log(`- domain:   ${e.domain}`);
      if (e.url) console.log(`  url:      ${e.url}`);
      console.log(`  username: ${e.username}`);
      console.log(`  password: ${e.password}`);
      if (e.notes) console.log(`  notes:    ${e.notes}`);
      console.log("");
    }
  } catch {
    console.error(
      "\nDECRYPT FAILED. Either the master password is wrong, or the data is corrupted."
    );
    process.exit(1);
  }
}

main();
