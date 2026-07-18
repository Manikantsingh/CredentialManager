// CredManager content script: detects logins on web pages and offers to save
// them to the vault via an in-page banner. This runs in an UNTRUSTED page, so
// it never receives vault data or keys — only the user-typed capture flows out.

(() => {
  "use strict";

  // Message constants (kept in sync with messages.js; content scripts are not
  // ES modules, so we inline the string literals here).
  const MSG = {
    CAPTURE: "credmanager:capture",
    SAVE_CONFIRM: "credmanager:save_confirm",
    NEVER_SITE: "credmanager:never_site",
    AUTOFILL_QUERY: "credmanager:autofill_query",
    AUTOFILL_FILL: "credmanager:autofill_fill",
    OPEN_POPUP: "credmanager:open_popup",
    STEP1_CAPTURE: "credmanager:step1_capture",
    GET_TAB_PENDING: "credmanager:get_tab_pending",
    CLEAR_PENDING_CAPTURE: "credmanager:clear_pending_capture",
  };

  // Avoid double-injection if the script runs more than once.
  if (window.__credManagerDetectorLoaded) return;
  window.__credManagerDetectorLoaded = true;

  let lastCapture = null; // { url, username, password }
  let bannerHost = null;
  // Record when this content script loaded. Used by checkTabPending() to
  // avoid consuming a stash that was written by tryCapture() on THIS page
  // (which would leave nothing for the landing page after navigation).
  const PAGE_LOAD_TS = Date.now();

  // ---------- field detection ----------

  function isVisible(elm) {
    if (!elm) return false;
    const style = window.getComputedStyle(elm);
    if (style.display === "none" || style.visibility === "hidden") return false;
    const rect = elm.getBoundingClientRect();
    return rect.width > 0 || rect.height > 0;
  }

  function passwordFields(root = document) {
    return Array.from(
      root.querySelectorAll('input[type="password"]')
    ).filter(isVisible);
  }

  // Guess the username/email field associated with a password field.
  function findUsernameField(pwField) {
    const form = pwField.form;
    const scope = form || document;
    const candidates = Array.from(
      scope.querySelectorAll(
        'input[type="email"], input[type="text"], input[type="tel"], input:not([type])'
      )
    ).filter(isVisible);

    if (candidates.length === 0) return null;

    // Prefer email inputs, then autocomplete=username, then name/id hints.
    const scored = candidates
      .map((c) => {
        let score = 0;
        const type = (c.getAttribute("type") || "").toLowerCase();
        const ac = (c.getAttribute("autocomplete") || "").toLowerCase();
        const hint = `${c.name} ${c.id} ${c.getAttribute("aria-label") || ""} ${
          c.placeholder || ""
        }`.toLowerCase();
        if (type === "email") score += 5;
        if (ac.includes("username") || ac.includes("email")) score += 5;
        if (/user|email|login|account|phone|mobile/.test(hint)) score += 3;
        // Prefer a field that appears before the password field in DOM order.
        if (
          c.compareDocumentPosition(pwField) &
          Node.DOCUMENT_POSITION_FOLLOWING
        ) {
          score += 2;
        }
        return { c, score };
      })
      .sort((a, b) => b.score - a.score);

    return scored[0].c;
  }

  function captureFrom(pwField) {
    const password = pwField.value;
    if (!password) return null;
    const userField = findUsernameField(pwField);
    const username = userField ? userField.value : "";
    return { url: location.href, username, password };
  }

  // ---------- capture triggers ----------

  function tryCapture(pwField) {
    const cap = captureFrom(pwField);
    if (!cap || !cap.password) return;
    // De-dupe identical repeated captures.
    if (
      lastCapture &&
      lastCapture.username === cap.username &&
      lastCapture.password === cap.password
    ) {
      return;
    }
    lastCapture = cap;
    chrome.runtime.sendMessage(
      { type: MSG.CAPTURE, payload: cap },
      (res) => {
        if (chrome.runtime.lastError) return; // extension reloaded, etc.
        if (!res || !res.mode) return;
        if (res.mode === "nochange") return; // already saved, stay quiet
        showBanner(res.mode, cap, res);
      }
    );
  }

  // Detects email/username submission on step-1 pages that have no password
  // field (e.g. Google's email-only screen). Stashes the username in the
  // background so it can be paired with the password on the next page.
  function tryStep1Capture(form) {
    if (passwordFields(form || document).length > 0) return;
    const scope = form || document;
    const candidates = Array.from(
      scope.querySelectorAll(
        'input[type="email"], input[type="text"], input[type="tel"], input:not([type])'
      )
    ).filter(isVisible);
    const scored = candidates
      .map((c) => {
        let score = 0;
        const type = (c.getAttribute("type") || "").toLowerCase();
        const ac = (c.getAttribute("autocomplete") || "").toLowerCase();
        const hint = `${c.name} ${c.id} ${c.getAttribute("aria-label") || ""} ${
          c.placeholder || ""
        }`.toLowerCase();
        if (type === "email") score += 5;
        if (ac.includes("username") || ac.includes("email")) score += 5;
        if (/user|email|login|account|phone|mobile/.test(hint)) score += 3;
        return { c, score };
      })
      .sort((a, b) => b.score - a.score);
    if (!scored.length || scored[0].score === 0) return;
    const username = scored[0].c.value.trim();
    if (!username) return;
    chrome.runtime.sendMessage(
      { type: MSG.STEP1_CAPTURE, payload: { url: location.href, username } },
      () => void chrome.runtime.lastError
    );
  }

  function attachFormHandlers() {
    // Capture on form submit.
    document.addEventListener(
      "submit",
      (ev) => {
        const form = ev.target;
        if (!(form instanceof HTMLFormElement)) return;
        const pw = passwordFields(form)[0];
        if (pw) tryCapture(pw);
        else tryStep1Capture(form);
      },
      true
    );

    // Capture on Enter within a password field (SPA logins without submit).
    document.addEventListener(
      "keydown",
      (ev) => {
        if (ev.key !== "Enter") return;
        const t = ev.target;
        if (t && t.matches) {
          if (t.matches('input[type="password"]')) {
            setTimeout(() => tryCapture(t), 0);
          } else if (t.matches('input[type="email"], input[type="text"], input[type="tel"], input:not([type])')) {
            setTimeout(() => tryStep1Capture(), 0);
          }
        }
      },
      true
    );

    // Capture on click of likely submit buttons (SPA logins).
    document.addEventListener(
      "click",
      (ev) => {
        const btn =
          ev.target &&
          ev.target.closest &&
          ev.target.closest('button, input[type="submit"], [role="button"]');
        if (!btn) return;
        const label = `${btn.textContent || ""} ${btn.value || ""} ${
          btn.id || ""
        } ${btn.name || ""}`.toLowerCase();
        if (!/log\s?in|sign\s?in|sign\s?up|register|continue|submit/.test(label)) {
          return;
        }
        const pw = passwordFields()[0];
        if (pw && pw.value) setTimeout(() => tryCapture(pw), 0);
        else setTimeout(() => tryStep1Capture(), 0);
      },
      true
    );
  }

  // ---------- banner UI (closed Shadow DOM) ----------

  function removeBanner() {
    if (bannerHost && bannerHost.parentNode) {
      bannerHost.parentNode.removeChild(bannerHost);
    }
    bannerHost = null;
  }

  function showBanner(mode, cap, res) {
    removeBanner();

    bannerHost = document.createElement("div");
    bannerHost.style.cssText =
      "all: initial; position: fixed; top: 16px; right: 16px; z-index: 2147483647;";
    const shadow = bannerHost.attachShadow({ mode: "closed" });

    const iconUrl = chrome.runtime.getURL("icons/icon48.png");
    const domain = (res && res.domain) || location.hostname;
    const user = (cap && cap.username) || "";

    let title, primaryLabel;
    if (mode === "update") {
      title = "Update saved password?";
      primaryLabel = "Update";
    } else if (mode === "locked") {
      title = "Unlock CredManager to save";
      primaryLabel = "Unlock & save";
    } else {
      title = "Save password to CredManager?";
      primaryLabel = "Save";
    }

    const wrap = document.createElement("div");
    wrap.innerHTML = `
      <style>
        .cm-card {
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
          width: 320px; background: #ffffff; color: #1f2328;
          border: 1px solid #d0d7de; border-radius: 12px;
          box-shadow: 0 8px 28px rgba(0,0,0,0.22); overflow: hidden;
        }
        .cm-head { display: flex; align-items: center; gap: 10px; padding: 14px 16px 6px; }
        .cm-head img { width: 24px; height: 24px; }
        .cm-title { font-size: 14px; font-weight: 600; }
        .cm-body { padding: 4px 16px 8px; font-size: 13px; color: #57606a; }
        .cm-body b { color: #1f2328; font-weight: 600; }
        .cm-actions { display: flex; gap: 8px; align-items: center; padding: 10px 16px 14px; }
        .cm-btn { font: inherit; font-size: 13px; cursor: pointer; border-radius: 8px;
          padding: 7px 14px; border: 1px solid #d0d7de; background: #f6f8fa; color: #1f2328; }
        .cm-btn:hover { background: #eef1f4; }
        .cm-btn.primary { background: #1f6feb; border-color: #1f6feb; color: #fff; }
        .cm-btn.primary:hover { background: #1a5fd0; }
        .cm-never { background: none; border: none; color: #57606a; font-size: 12px;
          cursor: pointer; padding: 0; margin-right: auto; text-decoration: underline; }
        .cm-never:hover { color: #cf222e; }
      </style>
      <div class="cm-card">
        <div class="cm-head">
          <img src="${iconUrl}" alt="" />
          <span class="cm-title"></span>
        </div>
        <div class="cm-body">
          <div><b class="cm-domain"></b></div>
          <div class="cm-user"></div>
        </div>
        <div class="cm-actions">
          <button class="cm-never" type="button">Never for this site</button>
          <button class="cm-btn cm-dismiss" type="button">Not now</button>
          <button class="cm-btn primary cm-save" type="button"></button>
        </div>
      </div>
    `;
    // Set text via textContent to avoid injecting page-controlled markup.
    wrap.querySelector(".cm-title").textContent = title;
    wrap.querySelector(".cm-domain").textContent = domain;
    wrap.querySelector(".cm-user").textContent = user
      ? user
      : "(no username detected)";
    wrap.querySelector(".cm-save").textContent = primaryLabel;

    wrap.querySelector(".cm-save").addEventListener("click", () => {
      chrome.runtime.sendMessage(
        { type: MSG.SAVE_CONFIRM, payload: cap },
        () => void chrome.runtime.lastError
      );
      removeBanner();
    });
    wrap.querySelector(".cm-dismiss").addEventListener("click", () => {
      chrome.runtime.sendMessage(
        { type: MSG.CLEAR_PENDING_CAPTURE },
        () => void chrome.runtime.lastError
      );
      removeBanner();
    });
    wrap.querySelector(".cm-never").addEventListener("click", () => {
      chrome.runtime.sendMessage(
        { type: MSG.NEVER_SITE, payload: { url: location.href } },
        () => void chrome.runtime.lastError
      );
      chrome.runtime.sendMessage(
        { type: MSG.CLEAR_PENDING_CAPTURE },
        () => void chrome.runtime.lastError
      );
      removeBanner();
    });

    shadow.appendChild(wrap);
    document.documentElement.appendChild(bannerHost);

    // Auto-dismiss after 30s so it doesn't linger.
    setTimeout(removeBanner, 30000);
  }

  // ---------- autofill (in-page picker) ----------
  //
  // Security posture matches the rest of this file: the page is untrusted. The
  // picker only ever shows usernames returned by the service worker, and a
  // password is requested one-at-a-time — and only for THIS tab's domain — when
  // the user explicitly chooses an account. Nothing is filled without a click.

  let afHost = null;   // shadow host for the key icon + menu
  let afShadow = null;
  let afKeyBtn = null;
  let afMenu = null;
  let afAnchor = null; // the focused login field the icon is pinned to
  let afCtx = null;    // { pw, user } login context for filling
  let afMenuOpen = false;
  let afRequestId = 0; // guards against stale async AUTOFILL_QUERY responses

  // Decide whether a focused field is part of a login and, if so, which
  // password + username fields to fill.
  function getLoginContext(field) {
    if (!field || !field.matches) return null;
    if (field.matches('input[type="password"]')) {
      return { pw: field, user: findUsernameField(field) };
    }
    if (
      field.matches(
        'input[type="email"], input[type="text"], input[type="tel"], input:not([type])'
      )
    ) {
      const scope = field.form || document;
      const pw = passwordFields(scope)[0] || passwordFields()[0];
      if (!pw) return null; // no password field => not a login context
      return { pw, user: field };
    }
    return null;
  }

  // Set an input's value so that frameworks (React/Vue/Angular) notice it, by
  // going through the native value setter and firing input + change events.
  function setNativeValue(el, value) {
    try {
      const proto =
        el instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
      const desc = Object.getOwnPropertyDescriptor(proto, "value");
      if (desc && desc.set) desc.set.call(el, value);
      else el.value = value;
    } catch {
      el.value = value;
    }
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function fillCredential(ctx, username, password) {
    if (!ctx) return;
    if (ctx.user && username) {
      ctx.user.focus();
      setNativeValue(ctx.user, username);
    }
    if (ctx.pw) {
      ctx.pw.focus();
      setNativeValue(ctx.pw, password || "");
    }
  }

  function ensureAfHost() {
    if (afHost) return;
    afHost = document.createElement("div");
    // pointer-events: none on the host lets clicks/typing pass through to the
    // page; only the key button and menu re-enable pointer events. top/left:0
    // anchors the fixed host at the viewport origin so the absolutely-positioned
    // key/menu children (positioned with viewport coordinates) line up.
    afHost.style.cssText =
      "all: initial; position: fixed; top: 0; left: 0; z-index: 2147483647; pointer-events: none;";
    afShadow = afHost.attachShadow({ mode: "closed" });

    const iconUrl = chrome.runtime.getURL("icons/icon48.png");
    const root = document.createElement("div");
    root.innerHTML = `
      <style>
        .af-key {
          all: initial; position: absolute; width: 22px; height: 22px;
          border-radius: 5px; border: 1px solid #d0d7de; background: #fff center/16px no-repeat;
          box-shadow: 0 1px 3px rgba(0,0,0,0.2); cursor: pointer; pointer-events: auto;
          display: inline-block;
        }
        .af-key:hover { background-color: #f1f4f8; }
        .af-menu {
          position: absolute; min-width: 240px; max-width: 320px; max-height: 260px;
          overflow-y: auto; background: #fff; color: #1f2328; pointer-events: auto;
          border: 1px solid #d0d7de; border-radius: 10px; box-shadow: 0 8px 28px rgba(0,0,0,0.22);
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
          padding: 6px; box-sizing: border-box;
        }
        .af-menu[hidden] { display: none; }
        .af-head { font-size: 11px; color: #8b949e; padding: 4px 8px 6px; text-transform: uppercase; letter-spacing: .04em; }
        .af-item {
          display: block; width: 100%; text-align: left; border: none; background: none;
          font: inherit; font-size: 13px; color: #1f2328; padding: 8px 8px; border-radius: 6px;
          cursor: pointer; box-sizing: border-box;
        }
        .af-item:hover { background: #eef1f4; }
        .af-item .af-user { font-weight: 600; }
        .af-item .af-sub { font-size: 11px; color: #57606a; margin-top: 2px; }
        .af-empty { font-size: 13px; color: #57606a; padding: 8px; }
      </style>
      <button class="af-key" type="button" title="CredManager autofill" style="background-image:url('${iconUrl}')"></button>
      <div class="af-menu" hidden></div>
    `;
    afShadow.appendChild(root);
    afKeyBtn = afShadow.querySelector(".af-key");
    afMenu = afShadow.querySelector(".af-menu");

    afKeyBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      toggleMenu();
    });

    document.documentElement.appendChild(afHost);
  }

  function positionAf() {
    if (!afHost || !afAnchor) return;
    const r = afAnchor.getBoundingClientRect();
    // Hide if the field scrolled out of view.
    if (r.width === 0 && r.height === 0) {
      hideAf();
      return;
    }
    const keySize = 22;
    afKeyBtn.style.top = `${r.top + (r.height - keySize) / 2}px`;
    afKeyBtn.style.left = `${r.right - keySize - 6}px`;
    afMenu.style.top = `${r.bottom + 4}px`;
    afMenu.style.left = `${Math.max(8, r.right - 240)}px`;
  }

  const repositionAf = () => positionAf();

  function showAfIcon(anchor, ctx) {
    ensureAfHost();
    afAnchor = anchor;
    afCtx = ctx;
    afHost.style.display = "";
    afKeyBtn.style.display = "";
    closeMenu();
    positionAf();
    window.addEventListener("scroll", repositionAf, true);
    window.addEventListener("resize", repositionAf, true);
  }

  function hideAf() {
    if (!afHost) return;
    closeMenu();
    afHost.style.display = "none";
    afAnchor = null;
    afCtx = null;
    window.removeEventListener("scroll", repositionAf, true);
    window.removeEventListener("resize", repositionAf, true);
  }

  function closeMenu() {
    afMenuOpen = false;
    if (afMenu) {
      afMenu.hidden = true;
      afMenu.innerHTML = "";
    }
  }

  function toggleMenu() {
    if (afMenuOpen) {
      closeMenu();
      return;
    }
    openMenu();
  }

  function openMenu() {
    afMenuOpen = true;
    afMenu.hidden = false;
    renderMenuLoading();
    positionAf();
    // Snapshot the fill context + a request token now; focus may move (and the
    // menu may be reopened on another field) while this query is in flight.
    const ctx = afCtx;
    const reqId = ++afRequestId;
    chrome.runtime.sendMessage({ type: MSG.AUTOFILL_QUERY }, (res) => {
      if (chrome.runtime.lastError) return;
      if (!afMenuOpen || reqId !== afRequestId || ctx !== afCtx) return;
      if (!res || res.ok === false) {
        renderMenuMessage("Autofill unavailable.");
        return;
      }
      if (res.locked) {
        renderMenuLocked();
        return;
      }
      renderMenuEntries(res.entries || [], ctx);
    });
  }

  function menuShell() {
    afMenu.innerHTML = "";
    const head = document.createElement("div");
    head.className = "af-head";
    head.textContent = "CredManager";
    afMenu.appendChild(head);
    return afMenu;
  }

  function renderMenuLoading() {
    const m = menuShell();
    const el = document.createElement("div");
    el.className = "af-empty";
    el.textContent = "Loading…";
    m.appendChild(el);
  }

  function renderMenuMessage(text) {
    const m = menuShell();
    const el = document.createElement("div");
    el.className = "af-empty";
    el.textContent = text;
    m.appendChild(el);
  }

  function renderMenuLocked() {
    const m = menuShell();
    const btn = document.createElement("button");
    btn.className = "af-item";
    btn.type = "button";
    btn.textContent = "Unlock CredManager to autofill";
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      chrome.runtime.sendMessage(
        { type: MSG.OPEN_POPUP },
        () => void chrome.runtime.lastError
      );
      hideAf();
    });
    m.appendChild(btn);
  }

  function renderMenuEntries(entries, ctx) {
    const m = menuShell();
    if (!entries.length) {
      const el = document.createElement("div");
      el.className = "af-empty";
      el.textContent = "No saved logins for this site.";
      m.appendChild(el);
      return;
    }
    for (const entry of entries) {
      const btn = document.createElement("button");
      btn.className = "af-item";
      btn.type = "button";

      const user = document.createElement("div");
      user.className = "af-user";
      user.textContent = entry.username || "(no username)";
      btn.appendChild(user);

      if (entry.url) {
        const sub = document.createElement("div");
        sub.className = "af-sub";
        sub.textContent = entry.url;
        btn.appendChild(sub);
      }

      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        selectEntry(entry.id, ctx);
      });
      m.appendChild(btn);
    }
  }

  function selectEntry(id, ctx) {
    chrome.runtime.sendMessage(
      { type: MSG.AUTOFILL_FILL, payload: { id } },
      (res) => {
        if (chrome.runtime.lastError) return;
        if (!res || !res.ok) return;
        fillCredential(ctx, res.username, res.password);
        hideAf();
      }
    );
  }

  function attachAutofill() {
    // Show the key icon when a login field gains focus.
    document.addEventListener(
      "focusin",
      (ev) => {
        const t = ev.target;
        if (t === afHost) return; // focus retargeted from our own shadow menu
        const ctx = getLoginContext(t);
        if (ctx && ctx.pw) {
          showAfIcon(t, ctx);
        } else if (afHost && afHost.style.display !== "none") {
          // Focus moved to an unrelated field: dismiss.
          hideAf();
        }
      },
      true
    );

    // Dismiss when clicking outside the field and outside our UI.
    document.addEventListener(
      "mousedown",
      (ev) => {
        if (!afHost || afHost.style.display === "none") return;
        if (ev.target === afHost) return; // click inside our (closed) shadow UI
        if (ev.target === afAnchor) return; // click back on the field
        hideAf();
      },
      true
    );

    // Escape closes the menu / dismisses the icon.
    document.addEventListener(
      "keydown",
      (ev) => {
        if (ev.key !== "Escape" || !afHost || afHost.style.display === "none") {
          return;
        }
        if (afMenuOpen) closeMenu();
        else hideAf();
      },
      true
    );
  }

  // On each page load, check whether a capture from a previous page survived
  // navigation (race condition: page navigated before the user could respond
  // to the save banner). Re-show the banner here if so.
  function checkTabPending() {
    chrome.runtime.sendMessage(
      { type: MSG.GET_TAB_PENDING, payload: { url: location.href, pageLoadTs: PAGE_LOAD_TS } },
      (res) => {
        if (chrome.runtime.lastError) return;
        if (!res || !res.cap) return;
        showBanner(res.mode, res.cap, res);
      }
    );
  }

  checkTabPending();
  attachFormHandlers();
  attachAutofill();
})();
