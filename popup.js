import * as vault from "./vault.js";
import { generatePassword } from "./crypto.js";

const $ = (id) => document.getElementById(id);

const el = {
  unlockScreen: $("unlockScreen"),
  vaultScreen: $("vaultScreen"),
  unlockHint: $("unlockHint"),
  masterPassword: $("masterPassword"),
  masterPasswordConfirm: $("masterPasswordConfirm"),
  confirmField: $("confirmField"),
  unlockBtn: $("unlockBtn"),
  createBtn: $("createBtn"),
  pullBtn: $("pullBtn"),
  unlockError: $("unlockError"),
  lockBtn: $("lockBtn"),
  search: $("search"),
  addBtn: $("addBtn"),
  syncDownBtn: $("syncDownBtn"),
  syncUpBtn: $("syncUpBtn"),
  syncStatus: $("syncStatus"),
  list: $("list"),
  editOverlay: $("editOverlay"),
  editTitle: $("editTitle"),
  editId: $("editId"),
  editDomain: $("editDomain"),
  editUrl: $("editUrl"),
  editUsername: $("editUsername"),
  editPassword: $("editPassword"),
  editNotes: $("editNotes"),
  editError: $("editError"),
  togglePw: $("togglePw"),
  genPw: $("genPw"),
  cancelEdit: $("cancelEdit"),
  saveEdit: $("saveEdit"),
  toast: $("toast"),
};

let toastTimer = null;
function toast(msg) {
  el.toast.textContent = msg;
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.toast.hidden = true), 2200);
}

function setUnlockError(msg) {
  el.unlockError.textContent = msg || "";
}

// ---------- unlock screen state ----------
async function initUnlockScreen() {
  const hasLocal = await vault.hasLocalVault();
  if (hasLocal) {
    el.unlockHint.textContent = "Enter your master password to unlock your vault.";
    el.confirmField.hidden = true;
    el.unlockBtn.hidden = false;
    el.createBtn.hidden = true;
  } else {
    el.unlockHint.textContent =
      "No vault found on this device. Create a new one, or load an existing vault from Google Drive.";
    el.confirmField.hidden = false;
    el.unlockBtn.hidden = true;
    el.createBtn.hidden = false;
  }
}

function showVaultScreen() {
  el.unlockScreen.hidden = true;
  el.vaultScreen.hidden = false;
  el.lockBtn.hidden = false;
  renderList();
}

function showUnlockScreen() {
  el.vaultScreen.hidden = true;
  el.unlockScreen.hidden = false;
  el.lockBtn.hidden = true;
  el.masterPassword.value = "";
  el.masterPasswordConfirm.value = "";
  initUnlockScreen();
}

// ---------- unlock actions ----------
el.unlockBtn.addEventListener("click", async () => {
  setUnlockError("");
  const pw = el.masterPassword.value;
  if (!pw) return setUnlockError("Enter your master password.");
  try {
    await vault.unlockFromLocal(pw);
    showVaultScreen();
  } catch (e) {
    setUnlockError("Could not unlock. Wrong password or corrupted vault.");
  }
});

el.createBtn.addEventListener("click", async () => {
  setUnlockError("");
  const pw = el.masterPassword.value;
  const pw2 = el.masterPasswordConfirm.value;
  if (!pw || pw.length < 8) return setUnlockError("Use a master password of at least 8 characters.");
  if (pw !== pw2) return setUnlockError("Passwords do not match.");
  try {
    await vault.createVault(pw);
    toast("Vault created");
    showVaultScreen();
  } catch (e) {
    setUnlockError(e.message || "Could not create vault.");
  }
});

el.pullBtn.addEventListener("click", async () => {
  setUnlockError("");
  try {
    el.pullBtn.textContent = "Connecting to Google Drive...";
    const res = await vault.syncFromDrive(true);
    if (res.pulled) {
      toast("Vault pulled from Drive");
      await initUnlockScreen();
    } else {
      setUnlockError(res.reason || "No vault found in Drive.");
    }
  } catch (e) {
    setUnlockError(e.message || "Drive sync failed.");
  } finally {
    el.pullBtn.textContent = "Load vault from Google Drive";
  }
});

el.lockBtn.addEventListener("click", () => {
  vault.lock();
  showUnlockScreen();
});

[el.masterPassword, el.masterPasswordConfirm].forEach((input) => {
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
      if (!el.unlockBtn.hidden) el.unlockBtn.click();
      else el.createBtn.click();
    }
  });
});

// ---------- sync actions ----------
el.syncDownBtn.addEventListener("click", async () => {
  el.syncStatus.textContent = "Pulling...";
  try {
    const res = await vault.syncFromDrive(true);
    if (res.pulled) {
      // syncFromDrive locks the session; user must re-unlock against pulled data.
      toast("Pulled from Drive. Re-enter master password.");
      showUnlockScreen();
    } else {
      el.syncStatus.textContent = res.reason || "Nothing to pull.";
    }
  } catch (e) {
    el.syncStatus.textContent = "";
    toast(e.message || "Pull failed");
  }
});

el.syncUpBtn.addEventListener("click", async () => {
  el.syncStatus.textContent = "Pushing...";
  try {
    const meta = await vault.syncToDrive(true);
    el.syncStatus.textContent = "Synced " + new Date(meta.modifiedTime || Date.now()).toLocaleTimeString();
    toast("Pushed to Drive");
  } catch (e) {
    el.syncStatus.textContent = "";
    toast(e.message || "Push failed");
  }
});

// ---------- list rendering ----------
function matchesFilter(entry, q) {
  if (!q) return true;
  q = q.toLowerCase();
  return (
    (entry.domain || "").toLowerCase().includes(q) ||
    (entry.username || "").toLowerCase().includes(q) ||
    (entry.url || "").toLowerCase().includes(q)
  );
}

function renderList() {
  const q = el.search.value.trim();
  const groups = vault.getEntriesByDomain();
  el.list.innerHTML = "";

  const domains = [...groups.keys()].sort();
  let shown = 0;

  for (const domain of domains) {
    const entries = groups.get(domain).filter((e) => matchesFilter(e, q));
    if (entries.length === 0) continue;
    shown += entries.length;

    const group = document.createElement("div");
    group.className = "domain-group";

    const head = document.createElement("div");
    head.className = "domain-head";
    head.innerHTML = `<span>${escapeHtml(domain)}</span><span class="count">${entries.length}</span>`;
    group.appendChild(head);

    for (const e of entries) {
      group.appendChild(renderEntry(e));
    }
    el.list.appendChild(group);
  }

  if (shown === 0) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = q ? "No matches." : "No credentials yet. Click + Add to create one.";
    el.list.appendChild(empty);
  }
}

function renderEntry(e) {
  const row = document.createElement("div");
  row.className = "entry";

  const info = document.createElement("div");
  info.className = "entry-info";
  info.innerHTML =
    `<div class="entry-user">${escapeHtml(e.username || "(no username)")}</div>` +
    `<div class="entry-sub">${escapeHtml(e.url || e.domain || "")}</div>`;
  row.appendChild(info);

  const actions = document.createElement("div");
  actions.className = "entry-actions";

  actions.appendChild(iconButton("Copy user", "👤", () => copy(e.username, "Username copied")));
  actions.appendChild(iconButton("Copy password", "🔑", () => copy(e.password, "Password copied")));
  actions.appendChild(iconButton("Edit", "✎", () => openEdit(e)));
  actions.appendChild(iconButton("Delete", "🗑", () => onDelete(e)));

  row.appendChild(actions);
  return row;
}

function iconButton(title, label, handler) {
  const b = document.createElement("button");
  b.className = "icon-btn";
  b.title = title;
  b.textContent = label;
  b.addEventListener("click", handler);
  return b;
}

async function copy(text, msg) {
  try {
    await navigator.clipboard.writeText(text || "");
    toast(msg);
  } catch {
    toast("Copy failed");
  }
}

async function onDelete(e) {
  if (!confirm(`Delete credential for ${e.domain} (${e.username || "no user"})?`)) return;
  await vault.deleteEntry(e.id);
  toast("Deleted");
  renderList();
}

el.search.addEventListener("input", renderList);

// ---------- add / edit dialog ----------
function openEdit(entry) {
  el.editError.textContent = "";
  if (entry) {
    el.editTitle.textContent = "Edit credential";
    el.editId.value = entry.id;
    el.editDomain.value = entry.domain || "";
    el.editUrl.value = entry.url || "";
    el.editUsername.value = entry.username || "";
    el.editPassword.value = entry.password || "";
    el.editNotes.value = entry.notes || "";
  } else {
    el.editTitle.textContent = "Add credential";
    el.editId.value = "";
    el.editDomain.value = "";
    el.editUrl.value = "";
    el.editUsername.value = "";
    el.editPassword.value = "";
    el.editNotes.value = "";
  }
  el.editPassword.type = "password";
  el.editOverlay.hidden = false;
}

el.addBtn.addEventListener("click", () => openEdit(null));
el.cancelEdit.addEventListener("click", () => (el.editOverlay.hidden = true));

el.togglePw.addEventListener("click", () => {
  el.editPassword.type = el.editPassword.type === "password" ? "text" : "password";
});

el.genPw.addEventListener("click", () => {
  el.editPassword.value = generatePassword(20);
  el.editPassword.type = "text";
});

el.saveEdit.addEventListener("click", async () => {
  el.editError.textContent = "";
  const id = el.editId.value;
  const domain = el.editDomain.value.trim();
  const url = el.editUrl.value.trim();
  const username = el.editUsername.value;
  const password = el.editPassword.value;
  const notes = el.editNotes.value;

  if (!domain && !url) {
    el.editError.textContent = "Enter a website/domain or URL.";
    return;
  }
  try {
    if (id) {
      await vault.updateEntry(id, { domain, url, username, password, notes });
      toast("Updated");
    } else {
      await vault.addEntry({ domain, url, username, password, notes });
      toast("Added");
    }
    el.editOverlay.hidden = true;
    renderList();
  } catch (e) {
    el.editError.textContent = e.message || "Could not save.";
  }
});

// ---------- utils ----------
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

// ---------- boot ----------
async function boot() {
  // If the vault is still unlocked from earlier in this browser session
  // (memory-only cache), go straight to the list; otherwise show unlock.
  try {
    if (await vault.restoreSession()) {
      showVaultScreen();
      return;
    }
  } catch {
    /* fall through to unlock screen */
  }
  initUnlockScreen();
}

boot();
