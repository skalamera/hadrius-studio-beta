// Hadrius Studio — thin client for the Google Drive v3 REST API, used to mirror every rendered
// walkthrough video into the "Hadrius Academy" folder in My Drive (module subfolder matching the
// workflow's module, same grouping as PYLON_MODULE_COLLECTION_MAP) as a shareable "Anyone with the
// link" viewer copy, alongside the Pylon KB article. Same .env pattern as PYLON_API_TOKEN /
// GEMINI_API_KEY — see tools/ai-bridge.mjs's loadDotEnv().
//
// Auth is a standard OAuth "installed app" refresh token (not a service account — a personal Drive
// upload needs a real user identity, and a service account's own Drive is a separate, unrelated
// storage quota). One-time setup to obtain GOOGLE_REFRESH_TOKEN is documented in README/setup.sh.
import fs from 'node:fs';
import path from 'node:path';

// Read lazily (not as top-level consts) — these are per-user secrets with no safe default, unlike
// pylon.mjs's IDs which fall back to hardcoded values. A top-level read would run at import time,
// before ai-bridge.mjs's loadDotEnv() has populated process.env from .env.
function creds() {
  return {
    clientId: (process.env.GOOGLE_CLIENT_ID || '').trim(),
    clientSecret: (process.env.GOOGLE_CLIENT_SECRET || '').trim(),
    refreshToken: (process.env.GOOGLE_REFRESH_TOKEN || '').trim(),
    // Optional override — when unset, uploads route into the Hadrius Academy folder's per-module
    // subfolder (googleDriveFolderForModule below) instead.
    folderId: (process.env.GOOGLE_DRIVE_FOLDER_ID || '').trim(),
  };
}

export function googleDriveConfigured() {
  const c = creds();
  return !!(c.clientId && c.clientSecret && c.refreshToken);
}

// The "Hadrius Academy" folder in My Drive (https://drive.google.com/drive/folders/1MlLinwFLBprG3Ybz8JAHhuL0V_VubTJr),
// with one subfolder per workflow module — same six modules (plus "Other") as
// PYLON_MODULE_COLLECTION_MAP in pylon.mjs, just a Drive folder id instead of a Pylon collection
// id. Hardcoded rather than env-configured, same call as that map: these are fixed destinations
// for this one folder tree, not something a install-specific .env should override.
export const HADRIUS_ACADEMY_FOLDER_ID = '1MlLinwFLBprG3Ybz8JAHhuL0V_VubTJr';
const MODULE_FOLDER_IDS = {
  'testing program': '1O2il8Fis3R7JncdY3MYqfkyDMIxtKol4',
  'people oversight': '1yAMHz8inOU_iaFtxv8vH5VeKg7Cu592-',
  'branches': '1jUnGi4BmsRYzvq68lxgdU1h-G2CMHXt3',
  'communications': '1n-mseLIM0HVxOrxPOxjlwaWTnkJoFdNd',
  'marketing': '1-4ZUTzlx1Cftm0VOCIFTKvjZCVqVBRAn',
  'account surveillance': '1sQFEs6yJhK8HXzbNjKZNak3PzcVX3JEX',
  'other': '1b8s4ZCWh1jimRiWjFpVh-rzNRdlLNfKK',
};
/** The right module subfolder under the Hadrius Academy folder, or "Other" if unrecognized. */
export function googleDriveFolderForModule(module) {
  const m = String(module || '').trim().toLowerCase();
  return MODULE_FOLDER_IDS[m] || MODULE_FOLDER_IDS.other;
}

const GOOGLE_DRIVE_SETUP_HINT = 'Google Drive isn\'t connected. See the "Google Drive" section in README.md for the one-time OAuth setup (GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET/GOOGLE_REFRESH_TOKEN in .env), then restart the bridge.';

let driveState = { connected: null, checkedAt: 0, detail: null };
/** Live check for the panel's header status dot — same shape/caching pattern as
 * checkClaudeAuth/checkCodebaseMcp in ai-bridge.mjs. Actually exchanges the refresh token rather
 * than just checking presence, so a revoked/expired token shows as disconnected, not falsely OK. */
export async function checkGoogleDrive({ maxAgeMs = 60000 } = {}) {
  if (Date.now() - driveState.checkedAt < maxAgeMs) return driveState;
  if (!googleDriveConfigured()) {
    driveState = { connected: false, checkedAt: Date.now(), detail: GOOGLE_DRIVE_SETUP_HINT };
    return driveState;
  }
  try {
    cachedToken = null; // force a real refresh-token exchange, not a cached access token
    await getAccessToken();
    driveState = { connected: true, checkedAt: Date.now(), detail: null };
  } catch (e) {
    driveState = { connected: false, checkedAt: Date.now(), detail: `Google Drive token refresh failed: ${String(e?.message || e).slice(0, 160)} — the refresh token may have been revoked; redo the OAuth setup in README.md.` };
  }
  return driveState;
}

let cachedToken = null; // { accessToken, expiresAt }

async function getAccessToken() {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 30_000) return cachedToken.accessToken;
  const { clientId, clientSecret, refreshToken } = creds();
  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(`Google token refresh failed: ${data.error_description || data.error || resp.status}`);
  cachedToken = { accessToken: data.access_token, expiresAt: Date.now() + (data.expires_in || 3600) * 1000 };
  return cachedToken.accessToken;
}

/**
 * Upload a local video file into the Hadrius Academy folder's subfolder for `module` (or the
 * explicit GOOGLE_DRIVE_FOLDER_ID override, or "Other" if the module isn't recognized), share it
 * "Anyone with the link" as a viewer, and return the shareable link. Simple (non-resumable)
 * multipart upload — fine for walkthrough videos, which run well under Drive's ~5GB ceiling for it.
 */
export async function googleDriveUploadVideo(filePath, title, module) {
  if (!googleDriveConfigured()) throw new Error('Google Drive is not configured (GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET/GOOGLE_REFRESH_TOKEN missing from .env)');
  const accessToken = await getAccessToken();
  const { folderId: overrideFolderId } = creds();
  const folderId = overrideFolderId || googleDriveFolderForModule(module);
  const buf = fs.readFileSync(filePath);
  const metadata = { name: `${title}.mp4`, parents: [folderId] };

  const boundary = `hadrius-studio-${Date.now()}`;
  const preamble = Buffer.from(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\nContent-Type: video/mp4\r\n\r\n`
  );
  const epilogue = Buffer.from(`\r\n--${boundary}--`);
  const body = Buffer.concat([preamble, buf, epilogue]);

  // supportsAllDrives is a no-op for a plain My Drive folder but required if this ever points at a
  // Shared Drive folder instead — cheap to always send.
  const uploadResp = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id,webViewLink', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': `multipart/related; boundary=${boundary}` },
    body,
  });
  const file = await uploadResp.json();
  if (!uploadResp.ok) throw new Error(`Google Drive upload failed: ${file.error?.message || uploadResp.status}`);

  await googleDriveShareAnyoneReader(file.id, accessToken);
  return { id: file.id, url: file.webViewLink || `https://drive.google.com/file/d/${file.id}/view?usp=sharing` };
}

async function googleDriveShareAnyoneReader(fileId, accessToken) {
  const resp = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}/permissions?supportsAllDrives=true`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: 'reader', type: 'anyone' }),
  });
  if (!resp.ok) {
    const data = await resp.json().catch(() => ({}));
    throw new Error(`Google Drive sharing failed: ${data.error?.message || resp.status}`);
  }
}
