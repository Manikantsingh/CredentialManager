import { CLIENT_ID, OAUTH_SCOPES, FOLDER_NAME, VAULT_FILENAME } from "./config.js";

const DRIVE_API = "https://www.googleapis.com/drive/v3";
const DRIVE_UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";

// ---------- OAuth via launchWebAuthFlow (implicit flow) ----------
let cachedToken = null;
let cachedTokenExpiry = 0;

export function getRedirectUrl() {
  return chrome.identity.getRedirectURL();
}

export async function getAccessToken(interactive = true) {
  const now = Date.now();
  if (cachedToken && now < cachedTokenExpiry - 60000) {
    return cachedToken;
  }
  if (CLIENT_ID.startsWith("REPLACE_WITH_")) {
    throw new Error(
      "Google OAuth CLIENT_ID is not configured. Edit config.js (see README)."
    );
  }

  const redirectUri = chrome.identity.getRedirectURL();
  const authUrl =
    "https://accounts.google.com/o/oauth2/v2/auth" +
    "?client_id=" + encodeURIComponent(CLIENT_ID) +
    "&response_type=token" +
    "&redirect_uri=" + encodeURIComponent(redirectUri) +
    "&scope=" + encodeURIComponent(OAUTH_SCOPES.join(" ")) +
    "&prompt=consent";

  const redirect = await chrome.identity.launchWebAuthFlow({
    url: authUrl,
    interactive,
  });

  if (!redirect) throw new Error("Authorization was cancelled.");

  const frag = redirect.split("#")[1] || "";
  const params = new URLSearchParams(frag);
  const token = params.get("access_token");
  const expiresIn = parseInt(params.get("expires_in") || "3600", 10);
  const error = params.get("error");
  if (error) throw new Error("OAuth error: " + error);
  if (!token) throw new Error("No access token returned by Google.");

  cachedToken = token;
  cachedTokenExpiry = Date.now() + expiresIn * 1000;
  return token;
}

export function clearToken() {
  cachedToken = null;
  cachedTokenExpiry = 0;
}

async function driveFetch(token, url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: "Bearer " + token,
      ...(options.headers || {}),
    },
  });
  if (res.status === 401) {
    clearToken();
    throw new Error("Google session expired. Please sign in again.");
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error("Drive API error (" + res.status + "): " + text);
  }
  return res;
}

// ---------- folder + file management ----------
export async function findOrCreateFolder(token, name = FOLDER_NAME) {
  const q =
    "mimeType='application/vnd.google-apps.folder' and trashed=false and name='" +
    name.replace(/'/g, "\\'") +
    "'";
  const url =
    DRIVE_API +
    "/files?q=" +
    encodeURIComponent(q) +
    "&fields=files(id,name)&spaces=drive";
  const res = await driveFetch(token, url);
  const json = await res.json();
  if (json.files && json.files.length > 0) return json.files[0].id;

  const createRes = await driveFetch(token, DRIVE_API + "/files", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name,
      mimeType: "application/vnd.google-apps.folder",
    }),
  });
  const created = await createRes.json();
  return created.id;
}

export async function findVaultFile(token, folderId, filename = VAULT_FILENAME) {
  const q =
    "trashed=false and name='" +
    filename.replace(/'/g, "\\'") +
    "' and '" +
    folderId +
    "' in parents";
  const url =
    DRIVE_API +
    "/files?q=" +
    encodeURIComponent(q) +
    "&fields=files(id,name,modifiedTime)&spaces=drive";
  const res = await driveFetch(token, url);
  const json = await res.json();
  if (json.files && json.files.length > 0) return json.files[0];
  return null;
}

export async function downloadVault(token, fileId) {
  const url = DRIVE_API + "/files/" + fileId + "?alt=media";
  const res = await driveFetch(token, url);
  return res.json();
}

// Create or update the vault file (multipart upload).
export async function uploadVault(token, { fileId, folderId, content, filename = VAULT_FILENAME }) {
  const boundary = "credmgr-" + Math.random().toString(36).slice(2);
  const metadata = fileId
    ? {}
    : { name: filename, parents: folderId ? [folderId] : undefined };

  const body =
    "--" + boundary + "\r\n" +
    "Content-Type: application/json; charset=UTF-8\r\n\r\n" +
    JSON.stringify(metadata) + "\r\n" +
    "--" + boundary + "\r\n" +
    "Content-Type: application/json\r\n\r\n" +
    JSON.stringify(content) + "\r\n" +
    "--" + boundary + "--";

  const method = fileId ? "PATCH" : "POST";
  const url = fileId
    ? DRIVE_UPLOAD + "/" + fileId + "?uploadType=multipart&fields=id,modifiedTime"
    : DRIVE_UPLOAD + "?uploadType=multipart&fields=id,modifiedTime";

  const res = await driveFetch(token, url, {
    method,
    headers: { "Content-Type": "multipart/related; boundary=" + boundary },
    body,
  });
  return res.json();
}
