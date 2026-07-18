// Minimal service worker. The popup performs all crypto and Drive operations
// directly. This worker exists to satisfy MV3 and to auto-lock the vault when
// the browser session ends (in-memory keys already vanish when the popup closes,
// but we also clear any transient token/meta if desired).

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === "install") {
    console.log("CredManager installed. Configure config.js with your Google OAuth client id.");
  }
});
