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
 * Upload a local video file to Drive, share it "Anyone with the link" as a viewer, and return the
 * shareable link.
 *
 * Re-renders REPLACE the existing Drive file's content in place (a new revision of the same file)
 * instead of creating a new file, so the file id and share link never change. That link is what's
 * embedded in the Circle training modules — keeping it stable is what makes an updated render show
 * up in Circle automatically. The existing file is found by `existingId` (the driveVideoId saved on
 * the script) first, then by exact filename in the module folder, for scripts whose saved id was
 * lost. Only when neither finds a live file is a new one created, in the Hadrius Academy folder's
 * subfolder for `module` (or the explicit GOOGLE_DRIVE_FOLDER_ID override, or "Other" if the module
 * isn't recognized).
 *
 * Simple (non-resumable) multipart upload — fine for walkthrough videos, which run well under
 * Drive's ~5GB ceiling for it.
 */
export async function googleDriveUploadVideo(filePath, title, module, { existingId } = {}) {
  if (!googleDriveConfigured()) throw new Error('Google Drive is not configured (GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET/GOOGLE_REFRESH_TOKEN missing from .env)');
  const accessToken = await getAccessToken();
  const { folderId: overrideFolderId } = creds();
  const folderId = overrideFolderId || googleDriveFolderForModule(module);
  const fileName = `${title}.mp4`;

  let target = existingId ? await googleDriveGetLiveFile(existingId, accessToken) : null;
  if (!target) target = await googleDriveFindByName(fileName, folderId, accessToken);

  // supportsAllDrives is a no-op for a plain My Drive folder but required for a Shared Drive
  // folder — cheap to always send.
  const url = target
    ? `https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(target.id)}?uploadType=multipart&supportsAllDrives=true&fields=id,webViewLink`
    : 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id,webViewLink';
  // Replacing: leave the file's name/folder alone (the Drive API rejects `parents` on an update, and
  // a rename or move isn't needed to keep the link working). Creating: name it and file it.
  const metadata = target ? {} : { name: fileName, parents: [folderId] };

  const buf = fs.readFileSync(filePath);
  const boundary = `hadrius-studio-${Date.now()}`;
  const preamble = Buffer.from(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\nContent-Type: video/mp4\r\n\r\n`
  );
  const epilogue = Buffer.from(`\r\n--${boundary}--`);
  const body = Buffer.concat([preamble, buf, epilogue]);

  const uploadResp = await fetch(url, {
    method: target ? 'PATCH' : 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': `multipart/related; boundary=${boundary}` },
    body,
  });
  const file = await uploadResp.json();
  if (!uploadResp.ok) throw new Error(`Google Drive ${target ? 'update' : 'upload'} failed: ${file.error?.message || uploadResp.status}`);

  // Re-assert link sharing on replace too, in case someone tightened it by hand — a restricted file
  // would silently break every Circle embed pointing at it.
  await googleDriveShareAnyoneReader(file.id, accessToken);
  processedIds.delete(file.id); // new content — Drive has to process it again before it plays
  return {
    id: file.id,
    url: file.webViewLink || `https://drive.google.com/file/d/${file.id}/view?usp=sharing`,
    replaced: !!target,
  };
}

// Drive transcodes a video after every upload — including an in-place replace — and until that's
// done its share link shows "It's taking longer than expected to process this video". That can take
// anywhere from under a minute to 20+ when Drive is busy. videoMediaMetadata only appears once the
// video is actually playable, so it's the signal. A processed id stays processed until this bridge
// uploads new content to it (the upload above clears it), so only pending videos cost an API call.
const processedIds = new Set();

/** { [fileId]: true (playable) | false (still processing) | null (couldn't check) } */
export async function googleDriveProcessingStatus(ids) {
  const out = {};
  const pending = [...new Set(ids)].filter((id) => {
    if (processedIds.has(id)) { out[id] = true; return false; }
    return true;
  });
  if (!pending.length) return out;
  const accessToken = await getAccessToken();
  await Promise.all(pending.map(async (id) => {
    try {
      const r = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?supportsAllDrives=true&fields=videoMediaMetadata`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!r.ok) { out[id] = null; return; }
      const f = await r.json();
      out[id] = !!f.videoMediaMetadata;
      if (out[id]) processedIds.add(id);
    } catch { out[id] = null; }
  }));
  return out;
}

/** Drive file id from a share link like https://drive.google.com/file/d/<id>/view?... */
export function googleDriveIdFromUrl(url) {
  return String(url || '').match(/\/file\/d\/([\w-]+)/)?.[1] || null;
}

/** The file's metadata if it exists and isn't trashed, else null (deleted, trashed, or no access). */
async function googleDriveGetLiveFile(fileId, accessToken) {
  const resp = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?supportsAllDrives=true&fields=id,trashed,webViewLink`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (resp.status === 404) return null;
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(`Google Drive lookup failed: ${data.error?.message || resp.status}`);
  return data.trashed ? null : data;
}

/**
 * The existing video with exactly this filename in `folderId`, or null. If a video was uploaded
 * more than once (every render created a new file before this replaced in place), picks the OLDEST
 * copy — the first link handed out is the one most likely already embedded in Circle — and warns so
 * the duplicates can be cleaned up.
 */
async function googleDriveFindByName(fileName, folderId, accessToken) {
  const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const q = `name = '${esc(fileName)}' and '${esc(folderId)}' in parents and trashed = false`;
  const params = new URLSearchParams({
    q,
    fields: 'files(id,webViewLink,createdTime)',
    orderBy: 'createdTime',
    pageSize: '10',
    supportsAllDrives: 'true',
    includeItemsFromAllDrives: 'true',
  });
  const resp = await fetch(`https://www.googleapis.com/drive/v3/files?${params}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(`Google Drive search failed: ${data.error?.message || resp.status}`);
  const files = data.files || [];
  if (files.length > 1) {
    console.warn(`[gdrive] ${files.length} copies of "${fileName}" in folder ${folderId}; updating the oldest (${files[0].id}). Others: ${files.slice(1).map((f) => f.id).join(', ')}`);
  }
  return files[0] || null;
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

// ---- Recording screenshots ----
// A saved script carries its narration and captions, but the slides it renders from are PNGs the
// extension captured onto the recorder's own disk (out/_recordings/<recordingId>/). Mirroring them
// into Hadrius Academy/_recordings/<recordingId>/ is what lets a coworker load anyone's shared script
// and render it on their own machine. Files are named by the step's captureId (step_<id>.png), so a
// name already in the folder is the same capture — only missing names are uploaded.
const RECORDINGS_FOLDER_NAME = '_recordings';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const folderIdCache = new Map(); // `${parentId}/${name}` -> folder id

async function driveJson(url, init, what) {
  const resp = await fetch(url, init);
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(`Google Drive ${what} failed: ${data.error?.message || resp.status}`);
  return data;
}

async function findChildFolder(name, parentId, accessToken, { create }) {
  const key = `${parentId}/${name}`;
  if (folderIdCache.has(key)) return folderIdCache.get(key);
  const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const params = new URLSearchParams({
    q: `name = '${esc(name)}' and '${esc(parentId)}' in parents and mimeType = '${FOLDER_MIME}' and trashed = false`,
    fields: 'files(id)', orderBy: 'createdTime', pageSize: '1',
    supportsAllDrives: 'true', includeItemsFromAllDrives: 'true',
  });
  const found = (await driveJson(`https://www.googleapis.com/drive/v3/files?${params}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }, 'folder search')).files?.[0];
  let id = found?.id || null;
  if (!id && create) {
    id = (await driveJson('https://www.googleapis.com/drive/v3/files?supportsAllDrives=true&fields=id', {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parentId] }),
    }, 'folder create')).id;
  }
  if (id) folderIdCache.set(key, id);
  return id;
}

async function recordingFolder(recordingId, accessToken, { create }) {
  const root = await findChildFolder(RECORDINGS_FOLDER_NAME, HADRIUS_ACADEMY_FOLDER_ID, accessToken, { create });
  return root ? findChildFolder(recordingId, root, accessToken, { create }) : null;
}

async function listFolderFiles(folderId, accessToken) {
  const files = new Map();
  let pageToken;
  do {
    const params = new URLSearchParams({
      q: `'${folderId}' in parents and trashed = false`, fields: 'nextPageToken,files(id,name)',
      pageSize: '1000', supportsAllDrives: 'true', includeItemsFromAllDrives: 'true',
      ...(pageToken ? { pageToken } : {}),
    });
    const data = await driveJson(`https://www.googleapis.com/drive/v3/files?${params}`,
      { headers: { Authorization: `Bearer ${accessToken}` } }, 'folder listing');
    for (const f of data.files || []) if (!files.has(f.name)) files.set(f.name, f.id);
    pageToken = data.nextPageToken;
  } while (pageToken);
  return files;
}

/** Upload whichever of `fileNames` exist in `localDir` but not yet in Drive. Returns the count sent. */
export async function googleDriveUploadRecording(recordingId, localDir, fileNames) {
  if (!googleDriveConfigured()) return 0;
  const present = fileNames.filter((n) => fs.existsSync(path.join(localDir, n)));
  if (!present.length) return 0;
  const accessToken = await getAccessToken();
  const folderId = await recordingFolder(recordingId, accessToken, { create: true });
  const remote = await listFolderFiles(folderId, accessToken);
  let sent = 0;
  for (const name of present) {
    if (remote.has(name)) continue;
    const boundary = `hadrius-studio-${Date.now()}`;
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name, parents: [folderId] })}\r\n--${boundary}\r\nContent-Type: image/png\r\n\r\n`),
      fs.readFileSync(path.join(localDir, name)),
      Buffer.from(`\r\n--${boundary}--`),
    ]);
    await driveJson('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id', {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': `multipart/related; boundary=${boundary}` },
      body,
    }, `upload of ${name}`);
    sent++;
  }
  return sent;
}

/** Download whichever of `fileNames` are missing from `localDir` but present in Drive. Returns the count fetched. */
export async function googleDriveDownloadRecording(recordingId, localDir, fileNames) {
  if (!googleDriveConfigured()) return 0;
  const missing = fileNames.filter((n) => !fs.existsSync(path.join(localDir, n)));
  if (!missing.length) return 0;
  const accessToken = await getAccessToken();
  const folderId = await recordingFolder(recordingId, accessToken, { create: false });
  if (!folderId) return 0;
  const remote = await listFolderFiles(folderId, accessToken);
  fs.mkdirSync(localDir, { recursive: true });
  let got = 0;
  for (const name of missing) {
    const id = remote.get(name);
    if (!id) continue;
    const resp = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?alt=media&supportsAllDrives=true`,
      { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!resp.ok) throw new Error(`Google Drive download of ${name} failed: ${resp.status}`);
    const dest = path.join(localDir, name);
    fs.writeFileSync(`${dest}.part`, Buffer.from(await resp.arrayBuffer()));
    fs.renameSync(`${dest}.part`, dest);
    got++;
  }
  return got;
}
