// Pre-post check for preview-bound approvals: a certified preview may be offered for approval only when it was built
// on EXACTLY the video that is live on Drive right now. Otherwise Approve could only ever fail at publish
// (publish.mjs refuses `drive_content_changed_since_baseline`), e.g. after an earlier drift update or a manual
// re-render replaced the Drive file. Read-only: one Drive metadata GET per video, local hashing; nothing is written.
import fs from 'node:fs';
import path from 'node:path';
import { readPyJson } from './executor.mjs';
import { sha256File, md5File } from './publish.mjs';
import { expectedLiveMd5 } from './live-version.mjs';

/**
 * -> {ok:true, driveMd5, baselineMd5} | {ok:false, reason, detail?}
 * deps: {repo, drive:{getFile(id)}, readScript(name)->script|null}
 */
export async function previewBaseIsLive(payload, { repo, drive, readScript }) {
  const name = payload?.video_name;
  const ex = payload?.details?.execution || {};
  const baseDir = ex.automaticResult?.baselineDir || ex.rebaselineDir || null;
  if (!name || !baseDir) return { ok: false, reason: 'baseline_unknown' };
  let manifest;
  try { manifest = readPyJson(path.join(baseDir, 'baseline-manifest.json')); } catch { return { ok: false, reason: 'baseline_manifest_unreadable' }; }
  const want = manifest?.original?.sha256;
  if (!/^[0-9a-f]{64}$/.test(String(want || ''))) return { ok: false, reason: 'baseline_original_unrecorded' };
  // The baseline's original MP4: the frozen copy beside its source build, else the local render output.
  const original = [path.join(baseDir, 'source', `${name}.mp4`), path.join(repo, 'out', name, `${name}.mp4`)]
    .find((p) => fs.existsSync(p) && sha256File(p) === want);
  if (!original) return { ok: false, reason: 'baseline_original_missing' };
  const script = readScript(name);
  const fileId = script?.driveVideoId;
  if (!fileId) return { ok: false, reason: 'no_drive_video_id' };
  let f;
  try { f = await drive.getFile(fileId); } catch (e) { return { ok: false, reason: 'drive_unreadable', detail: String(e?.message || e).slice(0, 200) }; }
  if (!f || f.id !== fileId || f.trashed) return { ok: false, reason: 'drive_file_missing_or_trashed' };
  const baselineMd5 = expectedLiveMd5({ repo, name, originalSha256: want, originalPath: original })?.md5 || md5File(original);
  if (f.md5Checksum !== baselineMd5) return { ok: false, reason: 'live_video_differs_from_preview_base', detail: { drive: f.md5Checksum, baseline: baselineMd5, driveModified: f.modifiedTime ?? null } };
  return { ok: true, driveMd5: f.md5Checksum, baselineMd5 };
}
