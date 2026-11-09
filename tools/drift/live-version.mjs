// Which bytes Drive should hold for a video's CURRENT baseline. Normally the baseline's original MP4 itself. After a
// published drift update was promoted to the baseline (promote.mjs), Drive holds the published file while the
// baseline's original is the renderer's equivalent of it (visually identical, not byte-identical), so promotion
// records the published file's md5 in out/<name>/drive-live.json, bound to the promoted original's sha256.
import fs from 'node:fs';
import path from 'node:path';
import { md5File } from './publish.mjs';

export const LIVE_RECORD = 'drive-live.json';
const HEX32 = /^[0-9a-f]{32}$/, HEX64 = /^[0-9a-f]{64}$/;

export const liveRecordPath = (repo, name) => path.join(repo, 'out', name, LIVE_RECORD);

export function readLiveRecord(repo, name) {
  const p = liveRecordPath(repo, name);
  if (!fs.existsSync(p)) return null;
  try {
    const r = JSON.parse(fs.readFileSync(p, 'utf8'));
    return r && r.schema === 1 && HEX64.test(r.originalSha256 || '') && HEX32.test(r.driveMd5 || '') ? r : null;
  } catch { return null; }
}

/** -> {md5, source:'promoted'|'original', jobId?} | null. originalSha256 = the baseline manifest's original.sha256. */
export function expectedLiveMd5({ repo, name, originalSha256, originalPath }) {
  const rec = readLiveRecord(repo, name);
  if (rec && rec.originalSha256 === originalSha256) return { md5: rec.driveMd5, source: 'promoted', jobId: rec.jobId || null };
  return originalPath && fs.existsSync(originalPath) ? { md5: md5File(originalPath), source: 'original' } : null;
}
