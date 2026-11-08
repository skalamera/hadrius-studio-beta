import test from 'node:test';
import assert from 'node:assert/strict';
import { redesignJudgeFor, reclassifyRun } from '../../tools/drift/reclassify.mjs';

test('redesignJudgeFor: earlier reviews first, live judge only for labelled slides, otherwise unreviewed', async () => {
  const raw = { redesigned: true, changes: [], data_differences: [], reason: 'cached' };
  const reuse = { videos: [{ name: 'Vid', steps: [{ index: 0, redesign: { raw } }] }] };
  const live = async () => ({ redesigned: false, changes: [], data_differences: [], reason: 'live' });
  const j = redesignJudgeFor('Vid', { reuse, live, keys: new Set(['Vid#1']) });
  assert.equal((await j({ stepNumber: 1 })).reason, 'cached');
  assert.equal((await j({ stepNumber: 2 })).reason, 'live');
  assert.equal(await j({ stepNumber: 3 }), null);
  assert.equal(redesignJudgeFor('Vid', {}), null);
});

test('reclassifyRun --concurrency keeps the requested order and reports progress once per video', async () => {
  const seen = [];
  const r = await reclassifyRun({ runDir: '/nonexistent-run', names: ['B', 'A', 'C'], write: false, concurrency: 2, onVideo: (v, n, total) => seen.push([v.name, n, total]) });
  assert.deepEqual(r.videos.map((v) => [v.name, v.skipped]), [['B', 'no_capture_or_script'], ['A', 'no_capture_or_script'], ['C', 'no_capture_or_script']]);
  assert.deepEqual(seen.map((s) => s[1]).sort(), [1, 2, 3]); assert.ok(seen.every((s) => s[2] === 3));
});
