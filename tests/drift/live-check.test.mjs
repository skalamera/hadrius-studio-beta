import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { previewBaseIsLive } from '../../tools/drift/live-check.mjs';

const sha = (b) => createHash('sha256').update(b).digest('hex');
const md5 = (b) => createHash('md5').update(b).digest('hex');

function world({ frozen = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'live-check-')); const repo = join(root, 'repo'); const base = join(root, 'baseline');
  const orig = Buffer.from('original-published-mp4');
  mkdirSync(join(base, 'source'), { recursive: true }); mkdirSync(join(repo, 'out', 'Vid'), { recursive: true });
  writeFileSync(join(base, 'baseline-manifest.json'), JSON.stringify({ original: { sha256: sha(orig) } }));
  if (frozen) writeFileSync(join(base, 'source', 'Vid.mp4'), orig); else writeFileSync(join(repo, 'out', 'Vid', 'Vid.mp4'), orig);
  const payload = { video_name: 'Vid', kind: 'auto_update', details: { execution: { automaticResult: { baselineDir: base } } } };
  return { repo, base, orig, payload, readScript: () => ({ driveVideoId: 'FILE1' }) };
}

test('preview built on the live Drive video -> ok', async () => {
  const w = world();
  const r = await previewBaseIsLive(w.payload, { repo: w.repo, readScript: w.readScript, drive: { getFile: async (id) => ({ id, md5Checksum: md5(w.orig) }) } });
  assert.equal(r.ok, true);
});

test('Drive holds something else (e.g. an earlier drift update or a manual re-render) -> not offered', async () => {
  const w = world({ frozen: false });
  const r = await previewBaseIsLive(w.payload, { repo: w.repo, readScript: w.readScript, drive: { getFile: async (id) => ({ id, md5Checksum: md5('newer-video') }) } });
  assert.equal(r.ok, false); assert.equal(r.reason, 'live_video_differs_from_preview_base');
});

test('missing baseline original / Drive id / unreadable Drive -> not offered (fail closed)', async () => {
  const w = world();
  const okDrive = { getFile: async (id) => ({ id, md5Checksum: md5(w.orig) }) };
  assert.equal((await previewBaseIsLive({ ...w.payload, details: { execution: {} } }, { repo: w.repo, readScript: w.readScript, drive: okDrive })).reason, 'baseline_unknown');
  assert.equal((await previewBaseIsLive(w.payload, { repo: w.repo, readScript: () => ({}), drive: okDrive })).reason, 'no_drive_video_id');
  assert.equal((await previewBaseIsLive(w.payload, { repo: w.repo, readScript: w.readScript, drive: { getFile: async () => { throw new Error('401'); } } })).reason, 'drive_unreadable');
  assert.equal((await previewBaseIsLive(w.payload, { repo: w.repo, readScript: w.readScript, drive: { getFile: async (id) => ({ id, trashed: true, md5Checksum: md5(w.orig) }) } })).reason, 'drive_file_missing_or_trashed');
  writeFileSync(join(w.base, 'source', 'Vid.mp4'), 'tampered');
  assert.equal((await previewBaseIsLive(w.payload, { repo: w.repo, readScript: w.readScript, drive: okDrive })).reason, 'baseline_original_missing');
});
