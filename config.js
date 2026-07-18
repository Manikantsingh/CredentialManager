// User-editable configuration.
// 1. Create an OAuth 2.0 Client ID (type: "Web application") in Google Cloud Console.
// 2. Enable the "Google Drive API" for that project.
// 3. Add this extension's redirect URL to the OAuth client's
//    "Authorized redirect URIs":  https://<EXTENSION_ID>.chromiumapp.org/
//    (The exact URL is shown in the popup and printed by chrome.identity.getRedirectURL().)
// 4. Paste the client id below.
export const CLIENT_ID =
  "REPLACE_WITH_YOUR_GOOGLE_OAUTH_CLIENT_ID.apps.googleusercontent.com";

// OAuth scope: drive.file lets the app create and manage ONLY the files/folders it creates.
export const OAUTH_SCOPES = ["https://www.googleapis.com/auth/drive.file"];

// Drive layout.
export const FOLDER_NAME = "CredManager";
export const VAULT_FILENAME = "credmanager-vault.json";

// Crypto parameters.
export const PBKDF2_ITERATIONS = 310000; // OWASP-recommended minimum for PBKDF2-SHA256
export const PBKDF2_HASH = "SHA-256";
export const CIPHER = "AES-GCM-256";
export const VAULT_VERSION = 1;

// How long the vault stays unlocked across popup reopens (idle timeout).
// The key is cached only in chrome.storage.session (memory-only, cleared when
// Chrome closes and never written to disk). Set to 0 to disable persistence
// (locks every time the popup closes).
export const AUTO_LOCK_MINUTES = 15;
