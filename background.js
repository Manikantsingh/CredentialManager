// CredManager service worker: coordinates the auto-detect feature.
//
// Responsibilities:
//  - Receive captured logins from the content script and classify them
//    (new / update / nochange / locked) without exposing any vault data.
//  - On user confirmation, upsert the credential when unlocked, or stash it
//    and open the popup when the vault is locked.
//  - Maintain a per-site ignore list ("Never for this site").
//
// Security: plaintext captures live only in the service-worker memory and, for
// the locked flow, briefly in chrome.storage.session (memory-only). No vault
// entries or keys are ever sent back to the page.

import * as vault from "./vault.js";
import { MSG, PENDING_CAPTURE_KEY, PENDING_CAP_PREFIX, STEP1_KEY_PREFIX } from "./messages.js";

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === "install") {
    console.log(
      "CredManager installed. Configure config.js with your Google OAuth client id."
    );
  }
});

// Short-lived plaintext captures, keyed by tabId (used for the locked flow).
const pendingByTab = new Map();
const CAPTURE_TTL_MS = 2 * 60 * 1000;
const STEP1_TTL_MS   = 5 * 60 * 1000;

// Returns the registrable domain (eTLD+1) for cross-subdomain matching,
// e.g. accounts.google.com and myaccount.google.com both yield "google.com".
function registrableDomain(url) {
  try {
    const h = new URL(url).hostname;
    const parts = h.split(".");
    return parts.length >= 2 ? parts.slice(-2).join(".") : h;
  } catch {
    return "";
  }
}

function stashTabCapture(tabId, capture) {
  if (tabId == null) return;
  pendingByTab.set(tabId, { capture, at: Date.now() });
  setTimeout(() => {
    const rec = pendingByTab.get(tabId);
    if (rec && Date.now() - rec.at >= CAPTURE_TTL_MS) pendingByTab.delete(tabId);
  }, CAPTURE_TTL_MS + 100);
}

async function setBadge(on) {
  try {
    await chrome.action.setBadgeText({ text: on ? "1" : "" });
    if (on) {
      await chrome.action.setBadgeBackgroundColor({ color: "#1f6feb" });
    }
  } catch {
    /* action badge may be unavailable */
  }
}

async function openPopupSafely() {
  // chrome.action.openPopup() requires Chrome 127+ and usually a user gesture.
  // If it fails, the badge tells the user to click the toolbar icon.
  try {
    if (chrome.action && typeof chrome.action.openPopup === "function") {
      await chrome.action.openPopup();
      return true;
    }
  } catch {
    /* fall back to badge */
  }
  return false;
}

// ---------- message router ----------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;

  const tabId = sender && sender.tab ? sender.tab.id : null;

  if (msg.type === MSG.CAPTURE) {
    handleCapture(msg.payload, tabId).then(sendResponse);
    return true; // async response
  }

  if (msg.type === MSG.SAVE_CONFIRM) {
    handleSaveConfirm(msg.payload, tabId).then(sendResponse);
    return true;
  }

  if (msg.type === MSG.NEVER_SITE) {
    handleNever(msg.payload).then(sendResponse);
    return true;
  }

  if (msg.type === MSG.GET_PENDING) {
    handleGetPending().then(sendResponse);
    return true;
  }

  if (msg.type === MSG.STEP1_CAPTURE) {
    handleStep1Capture(msg.payload, tabId).then(sendResponse);
    return true;
  }

  if (msg.type === MSG.GET_TAB_PENDING) {
    handleGetTabPending(msg.payload, tabId).then(sendResponse);
    return true;
  }

  if (msg.type === MSG.CLEAR_PENDING_CAPTURE) {
    handleClearPendingCapture(tabId).then(sendResponse);
    return true;
  }

  if (msg.type === MSG.AUTOFILL_QUERY) {
    handleAutofillQuery(sender).then(sendResponse);
    return true;
  }

  if (msg.type === MSG.AUTOFILL_FILL) {
    handleAutofillFill(msg.payload, sender).then(sendResponse);
    return true;
  }

  if (msg.type === MSG.OPEN_POPUP) {
    openPopupSafely().then((opened) => sendResponse({ opened }));
    return true;
  }
});

async function handleCapture(payload, tabId) {
  try {
    if (!payload || !payload.password) return { mode: "nochange" };
    if (await vault.isIgnoredSite(payload.url)) return { mode: "nochange" };

    // Multi-step login (e.g. Google): if no username was found on this page,
    // check for a username stashed from the previous email-only step.
    let capture = payload;
    if (!payload.username && tabId != null) {
      const s1Key = `${STEP1_KEY_PREFIX}${tabId}`;
      const s1obj = await chrome.storage.session.get(s1Key);
      const s1 = s1obj[s1Key];
      if (
        s1 &&
        Date.now() - s1.ts < STEP1_TTL_MS &&
        registrableDomain(payload.url) === s1.regDomain
      ) {
        capture = { ...payload, username: s1.username };
        await chrome.storage.session.remove(s1Key);
      }
    }

    const result = await vault.classifyCapture(capture);
    stashTabCapture(tabId, capture);

    // Write the navigation-survive stash WITHOUT blocking the response. The
    // stash must exist before the landing-page content script loads, but page
    // navigation takes hundreds of ms (network round-trip + HTML parse) while
    // session.set completes in < 10 ms — so fire-and-forget is safe here.
    // Not awaiting also prevents a session.set failure from suppressing the banner.
    if (result.mode !== "nochange" && tabId != null) {
      chrome.storage.session
        .set({
          [`${PENDING_CAP_PREFIX}${tabId}`]: {
            cap: capture,
            mode: result.mode,
            domain: result.domain,
            regDomain: registrableDomain(capture.url),
            ts: Date.now(),
          },
        })
        .catch(() => {});
    }

    return result;
  } catch (e) {
    return { mode: "nochange", error: String(e && e.message) };
  }
}

async function handleSaveConfirm(payload, tabId) {
  try {
    const capture =
      payload && payload.password
        ? payload
        : (pendingByTab.get(tabId) || {}).capture;
    if (!capture || !capture.password) return { ok: false, reason: "no_capture" };

    if (!vault.isUnlocked()) await vault.restoreSession();

    if (!vault.isUnlocked()) {
      // Locked: stash the capture and prompt the user to unlock.
      await chrome.storage.session.set({ [PENDING_CAPTURE_KEY]: capture });
      const opened = await openPopupSafely();
      if (!opened) await setBadge(true);
      pendingByTab.delete(tabId);
      if (tabId != null) await chrome.storage.session.remove(`${PENDING_CAP_PREFIX}${tabId}`);
      return { ok: false, locked: true, opened };
    }

    const res = await vault.upsertCapture(capture);
    pendingByTab.delete(tabId);
    if (tabId != null) await chrome.storage.session.remove(`${PENDING_CAP_PREFIX}${tabId}`);
    await setBadge(false);
    return { ok: true, mode: res.mode };
  } catch (e) {
    return { ok: false, reason: String(e && e.message) };
  }
}

async function handleNever(payload) {
  try {
    await vault.addIgnoredSite(payload && payload.url);
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: String(e && e.message) };
  }
}

// Called by the popup after it opens: hand over (and clear) any pending capture.
async function handleGetPending() {
  try {
    const obj = await chrome.storage.session.get(PENDING_CAPTURE_KEY);
    const pending = obj[PENDING_CAPTURE_KEY] || null;
    if (pending) await chrome.storage.session.remove(PENDING_CAPTURE_KEY);
    await setBadge(false);
    return { pending };
  } catch (e) {
    return { pending: null, reason: String(e && e.message) };
  }
}

// ---------- autofill ----------

// The page asks which saved accounts match it. We derive the domain from the
// AUTHENTICATED sender tab URL (never from page-supplied data) so a hostile
// page can't fish for credentials belonging to another origin. Only usernames
// are returned here; passwords are released one at a time by handleAutofillFill.
async function handleAutofillQuery(sender) {
  try {
    const url = sender && sender.tab ? sender.tab.url : null;
    if (!url) return { ok: false, locked: false, entries: [] };
    if (!vault.isUnlocked()) await vault.restoreSession();
    if (!vault.isUnlocked()) return { ok: true, locked: true, entries: [] };
    const entries = vault.listAutofillCandidates(url);
    return { ok: true, locked: false, entries };
  } catch (e) {
    return { ok: false, reason: String(e && e.message), entries: [] };
  }
}

// The user picked an account in the in-page picker. Release exactly one
// credential, and only if it belongs to the sender tab's own domain.
async function handleAutofillFill(payload, sender) {
  try {
    const url = sender && sender.tab ? sender.tab.url : null;
    const id = payload && payload.id;
    if (!url || !id) return { ok: false };
    if (!vault.isUnlocked()) await vault.restoreSession();
    if (!vault.isUnlocked()) return { ok: false, locked: true };
    const secret = vault.getAutofillSecret(id, url); // domain-checked in vault
    if (!secret) return { ok: false };
    return { ok: true, username: secret.username, password: secret.password };
  } catch (e) {
    return { ok: false, reason: String(e && e.message) };
  }
}

// ---------- multi-step login (step 1: email-only page) ----------

async function handleStep1Capture(payload, tabId) {
  if (!payload || !payload.username || tabId == null) return { ok: false };
  await chrome.storage.session.set({
    [`${STEP1_KEY_PREFIX}${tabId}`]: {
      username: payload.username,
      regDomain: registrableDomain(payload.url),
      ts: Date.now(),
    },
  });
  return { ok: true };
}

// ---------- navigation-survive (race condition: page navigated before save) ----------

async function handleGetTabPending(payload, tabId) {
  if (tabId == null) return { cap: null };
  const key = `${PENDING_CAP_PREFIX}${tabId}`;
  const obj = await chrome.storage.session.get(key);
  const rec = obj[key];
  if (!rec) return { cap: null };
  if (Date.now() - rec.ts > CAPTURE_TTL_MS) {
    await chrome.storage.session.remove(key);
    return { cap: null };
  }
  const currentUrl = payload && payload.url;
  if (currentUrl && registrableDomain(currentUrl) !== rec.regDomain) {
    await chrome.storage.session.remove(key);
    return { cap: null };
  }
  // Guard: if the stash was written AFTER the requesting page loaded, it
  // belongs to a tryCapture() on THIS same page — keep it for the landing page.
  const pageLoadTs = payload && payload.pageLoadTs;
  if (pageLoadTs && rec.ts >= pageLoadTs) return { cap: null };
  // Remove now — the banner will be shown; the user's next action finalises it.
  await chrome.storage.session.remove(key);
  return { cap: rec.cap, mode: rec.mode, domain: rec.domain };
}

async function handleClearPendingCapture(tabId) {
  if (tabId == null) return { ok: false };
  await chrome.storage.session.remove(`${PENDING_CAP_PREFIX}${tabId}`);
  return { ok: true };
}

// Clean up stale per-tab session stashes when a tab navigates to a completely
// different registrable domain, preventing stale prompts on unrelated sites.
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (changeInfo.status !== "loading" || !changeInfo.url) return;
  const newReg = registrableDomain(changeInfo.url);
  const s1Key = `${STEP1_KEY_PREFIX}${tabId}`;
  const pcKey = `${PENDING_CAP_PREFIX}${tabId}`;
  const obj = await chrome.storage.session.get([s1Key, pcKey]);
  const toRemove = [];
  if (obj[s1Key] && obj[s1Key].regDomain !== newReg) toRemove.push(s1Key);
  if (obj[pcKey] && obj[pcKey].regDomain !== newReg) toRemove.push(pcKey);
  if (toRemove.length) await chrome.storage.session.remove(toRemove);
});
