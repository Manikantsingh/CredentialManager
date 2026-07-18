// Shared message-type constants for communication between the content script,
// the background service worker, and the popup. Keeping these in one place
// avoids typos and documents the full message surface.

export const MSG = {
  // content script -> background: a login was captured on a page.
  // payload: { url, username, password }
  CAPTURE: "credmanager:capture",

  // background -> content script (response to CAPTURE): what to offer.
  // payload: { mode: "new" | "update" | "nochange" | "locked", domain, username }
  CAPTURE_RESULT: "credmanager:capture_result",

  // content script -> background: user clicked Save/Update on the banner.
  // payload: { url, username, password }
  SAVE_CONFIRM: "credmanager:save_confirm",

  // content script -> background: user clicked "Never for this site".
  // payload: { url }
  NEVER_SITE: "credmanager:never_site",

  // popup -> background: fetch (and clear) a pending capture that was stashed
  // while the vault was locked. Returns { pending: {...} | null }.
  GET_PENDING: "credmanager:get_pending",

  // content script -> background: which saved accounts match this page's domain?
  // Uses the authenticated sender tab URL, not page-supplied data. Returns
  // { ok, locked, entries: [{ id, username, url }] } (no passwords).
  AUTOFILL_QUERY: "credmanager:autofill_query",

  // content script -> background: user picked an account to autofill.
  // payload: { id }. Returns { ok, username, password } only when the entry
  // belongs to the sender tab's domain; otherwise { ok: false }.
  AUTOFILL_FILL: "credmanager:autofill_fill",

  // content script -> background: ask to open the popup (e.g. to unlock before
  // autofilling). Returns { opened: boolean }.
  OPEN_POPUP: "credmanager:open_popup",

  // content script -> background: email/username submitted on a step-1 login
  // page that has no password field (e.g. Google's email screen).
  // payload: { url, username }
  STEP1_CAPTURE: "credmanager:step1_capture",

  // content script -> background: on page load, check whether a capture
  // survived a page navigation and needs to be re-shown as a banner.
  // payload: { url }. Returns { cap, mode, domain } | { cap: null }.
  GET_TAB_PENDING: "credmanager:get_tab_pending",

  // content script -> background: user dismissed the banner (Not now / Never);
  // clear the navigation-survive stash for this tab.
  CLEAR_PENDING_CAPTURE: "credmanager:clear_pending_capture",
};

// Result modes returned to the banner.
export const CAPTURE_MODE = {
  NEW: "new",
  UPDATE: "update",
  NOCHANGE: "nochange",
  LOCKED: "locked",
};

// chrome.storage keys used by the auto-detect feature.
export const IGNORED_SITES_KEY = "credmanager_ignored_sites"; // storage.local: string[]
export const PENDING_CAPTURE_KEY = "credmanager_pending_capture"; // storage.session: locked-vault flow
export const PENDING_CAP_PREFIX = "credmanager_pending_cap_";  // storage.session, keyed by tabId: navigation-survive flow
export const STEP1_KEY_PREFIX   = "credmanager_step1_";        // storage.session, keyed by tabId: multi-step login flow
