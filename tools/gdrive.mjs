// Hadrius Studio — thin client for the Google Drive v3 REST API, used to mirror every rendered
// walkthrough video into stephen@hadrius.com's Drive as a shareable "Anyone with the link" viewer
// copy, alongside the Pylon KB article. Same .env pattern as PYLON_API_TOKEN / GEMINI_API_KEY — see
// tools/ai-bridge.mjs's loadDotEnv().
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
    // Optional — uploads land in "My Drive" root when unset.
    folderId: (process.env.GOOGLE_DRIVE_FOLDER_ID || '').trim(),
  };
}

export function googleDriveConfigured() {
  const c = creds();
  return !!(c.clientId && c.clientSecret && c.refreshToken);
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
 * Upload a local video file to Drive, share it "Anyone with the link" as a viewer, and return the
 * shareable link. Simple (non-resumable) multipart upload — fine for walkthrough videos, which run
 * well under Drive's ~5GB simple-upload ceiling.
 */
export async function googleDriveUploadVideo(filePath, title) {
  if (!googleDriveConfigured()) throw new Error('Google Drive is not configured (GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET/GOOGLE_REFRESH_TOKEN missing from .env)');
  const accessToken = await getAccessToken();
  const { folderId } = creds();
  const buf = fs.readFileSync(filePath);
  const metadata = { name: `${title}.mp4`, ...(folderId ? { parents: [folderId] } : {}) };

  const boundary = `hadrius-studio-${Date.now()}`;
  const preamble = Buffer.from(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\nContent-Type: video/mp4\r\n\r\n`
  );
  const epilogue = Buffer.from(`\r\n--${boundary}--`);
  const body = Buffer.concat([preamble, buf, epilogue]);

  const uploadResp = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink', {
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
  const resp = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}/permissions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: 'reader', type: 'anyone' }),
  });
  if (!resp.ok) {
    const data = await resp.json().catch(() => ({}));
    throw new Error(`Google Drive sharing failed: ${data.error?.message || resp.status}`);
  }
}
