import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { promotePublishedUpdate, revertPromotion } from '../../tools/drift/promote.mjs';
import { expectedLiveMd5, liveRecordPath } from '../../tools/drift/live-version.mjs';

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const md5 = (b) => crypto.createHash('md5').update(b).digest('hex');
const NAME = 'How-to-test-promotion';
const JOB = '0f976789-ce06-4021-9695-22eab08e4b64';

// A fake repo + a fake python runner that "renders" (writes verification.json) and "stages" (writes the staged files).
function world({ renderSha = null, controlOk = true, scriptJob = JOB } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'promote-test-'));
  const repo = path.join(root, 'repo'), scratch = path.join(root, 'scratch'), stateDir = path.join(repo, '.drift-cache', 'exec', JOB);
  const out = path.join(repo, 'out', NAME);
  fs.mkdirSync(path.join(out, '_build'), { recursive: true });
  fs.writeFileSync(path.join(out, `${NAME}.mp4`), 'OLD-ORIGINAL');
  fs.writeFileSync(path.join(out, 'assembly.json'), '{"old":true}');
  fs.writeFileSync(path.join(out, '_build', 'seg01.mp4'), 'OLD-SEG');
  fs.writeFileSync(path.join(out, 'report.json'), '{}');
  const steps = [{ id: 's1', index: 0, media: { pre: 'step_1.png' } }, { id: 's2', index: 1, media: { pre: 'step_2.png' } }];
  fs.mkdirSync(path.join(repo, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'scripts', `${NAME}.script.json`), JSON.stringify({ name: NAME, steps, recording: { id: 'drift-published' }, driftUpdate: { jobId: scriptJob } }));
  const rec = path.join(repo, 'out', '_recordings', 'drift-published');
  fs.mkdirSync(rec, { recursive: true });
  fs.writeFileSync(path.join(rec, 'step_1.png'), 'PNG1'); fs.writeFileSync(path.join(rec, 'step_2.png'), 'PNG2');
  const published = path.join(root, 'published.mp4');
  fs.writeFileSync(published, 'PUBLISHED-BYTES');
  const calls = [], seen = {};
  const run = async (cmd, args) => {
    const mod = args[args.indexOf('-m') + 1], o = args[args.indexOf('--output') + 1];
    calls.push(mod + (o.endsWith('control') ? ':control' : ''));
    if (mod === 'renderer.drift_update') {
      fs.mkdirSync(o, { recursive: true });
      const control = o.endsWith('control');
      if (control) seen.controlScriptId = JSON.parse(fs.readFileSync(args[args.indexOf('--script') + 1], 'utf8')).id;
      fs.writeFileSync(path.join(o, 'verification.json'), JSON.stringify({ ok: control ? controlOk : true,
        candidate_sha256: control ? 'f'.repeat(64) : (renderSha || sha('PUBLISHED-BYTES')) }));
      return { code: 0, stdout: '{"ok": true}', stderr: '' };
    }
    // renderer.promote_baseline: stage files
    const src = path.join(o, 'source'), srec = path.join(o, 'rec');
    fs.mkdirSync(path.join(src, '_build'), { recursive: true }); fs.mkdirSync(srec, { recursive: true });
    fs.writeFileSync(path.join(src, `${NAME}.mp4`), 'NEW-ORIGINAL'); fs.writeFileSync(path.join(src, 'assembly.json'), '{"new":true}');
    fs.writeFileSync(path.join(src, '_build', 'seg01.mp4'), 'NEW-SEG');
    fs.writeFileSync(path.join(src, 'script.json'), JSON.stringify({ name: NAME, steps, recording: { id: 'drift-render' } }));
    fs.writeFileSync(path.join(srec, 'step_1.png'), 'PNG1'); fs.writeFileSync(path.join(srec, 'step_2.png'), 'PNG2');
    const st = { ok: true, original: path.join(src, `${NAME}.mp4`), original_sha256: sha('NEW-ORIGINAL'), assembly: path.join(src, 'assembly.json'),
      assembly_sha256: sha('{"new":true}'), build: path.join(src, '_build'), script: path.join(src, 'script.json'), recordings: srec,
      similarity_to_published: { psnr_min: 43.7 }, font_layout: 'basic' };
    return { code: 0, stdout: JSON.stringify(st), stderr: '' };
  };
  const enrolled = [];
  const enroll = async (a) => {
    enrolled.push(a);
    const dir = path.join(repo, 'out', 'drift-baselines', NAME, 'b'.repeat(64));
    fs.mkdirSync(path.join(dir, 'source', '_recordings', 'drift-published'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'source', '_recordings', 'drift-published', 'step_1.png'), 'PNG1');
    fs.writeFileSync(path.join(dir, 'source', '_recordings', 'drift-published', 'step_2.png'), 'PNG2');
    fs.writeFileSync(path.join(dir, 'baseline-script.json'), JSON.stringify({ name: NAME, steps }));
    fs.writeFileSync(path.join(dir, 'baseline-manifest.json'), JSON.stringify({ original: { sha256: sha(fs.readFileSync(path.join(out, `${NAME}.mp4`))) }, final: { sha256: 'f'.repeat(64) } }));
    return { status: 'baseline_ready', directory: dir, manifestSha256: 'b'.repeat(64), snapshotComplete: true, scriptPath: path.join(dir, 'baseline-script.json'),
      recordingsDir: path.join(dir, 'source', '_recordings', 'drift-published'), buildDir: path.join(dir, 'source', '_build'), reportPath: null };
  };
  const render = { rebaselineDir: '/old/baseline', script: '/old/identified.json', recordingsDir: '/old/rec', buildDir: '/old/build', reportPath: null, changes: '/old/changes.json', fontLayout: 'basic' };
  const args = { name: NAME, jobId: JOB, published, render, stateDir, repo, run, enroll, scratch, log: () => {} };
  return { root, repo, out, stateDir, published, calls, seen, enrolled, args };
}

test('promotion: published bytes reproduced -> new files installed, Drive md5 recorded, new baseline enrolled with supersede, full control run', async () => {
  const w = world();
  const r = await promotePublishedUpdate(w.args);
  assert.equal(r.status, 'promoted');
  assert.deepEqual(w.calls, ['renderer.drift_update', 'renderer.promote_baseline', 'renderer.drift_update:control']);
  assert.equal(fs.readFileSync(path.join(w.out, `${NAME}.mp4`), 'utf8'), 'NEW-ORIGINAL');
  assert.equal(fs.readFileSync(path.join(w.out, '_build', 'seg01.mp4'), 'utf8'), 'NEW-SEG');
  assert.equal(fs.readFileSync(path.join(w.out, 'report.json'), 'utf8'), '{}'); // untouched
  assert.deepEqual(w.enrolled[0].supersede, { jobId: JOB });
  // drift_update only accepts the identified script form (top-level id), or it rejects candidate_base_mismatch
  assert.equal(w.seen.controlScriptId, `promotion-control-${JOB}`);
  const live = JSON.parse(fs.readFileSync(liveRecordPath(w.repo, NAME), 'utf8'));
  assert.equal(live.driveMd5, md5('PUBLISHED-BYTES')); assert.equal(live.originalSha256, sha('NEW-ORIGINAL'));
  // Drive is expected to hold the PUBLISHED file for the new baseline, the original md5 for any other baseline.
  assert.equal(expectedLiveMd5({ repo: w.repo, name: NAME, originalSha256: sha('NEW-ORIGINAL'), originalPath: path.join(w.out, `${NAME}.mp4`) }).md5, md5('PUBLISHED-BYTES'));
  assert.equal(expectedLiveMd5({ repo: w.repo, name: NAME, originalSha256: sha('OTHER'), originalPath: path.join(w.out, `${NAME}.mp4`) }).md5, md5('NEW-ORIGINAL'));
  // previous files kept durably for Undo
  assert.equal(fs.readFileSync(path.join(r.backup, `${NAME}.mp4`), 'utf8'), 'OLD-ORIGINAL');
  // idempotent
  assert.equal((await promotePublishedUpdate(w.args)).resumed, true);
});

test('promotion refuses when the re-render does not reproduce the published bytes (nothing installed)', async () => {
  const w = world({ renderSha: 'a'.repeat(64) });
  await assert.rejects(promotePublishedUpdate(w.args), (e) => e.code === 'promotion_published_not_reproduced');
  assert.equal(fs.readFileSync(path.join(w.out, `${NAME}.mp4`), 'utf8'), 'OLD-ORIGINAL');
  assert.equal(fs.existsSync(liveRecordPath(w.repo, NAME)), false);
});

test('promotion refuses when the local script is not the published version of THIS job', async () => {
  const w = world({ scriptJob: '11111111-1111-1111-1111-111111111111' });
  await assert.rejects(promotePublishedUpdate(w.args), (e) => e.code === 'promotion_script_not_from_this_job');
  assert.equal(fs.readFileSync(path.join(w.out, `${NAME}.mp4`), 'utf8'), 'OLD-ORIGINAL');
});

test('promotion refuses when Drive does not hold the published file', async () => {
  const w = world();
  await assert.rejects(promotePublishedUpdate({ ...w.args, checkDrive: async () => 'e'.repeat(32) }), (e) => e.code === 'promotion_drive_not_published_version');
  assert.deepEqual(w.calls, []);
});

test('failed full control after install restores every previous file and removes the Drive record', async () => {
  const w = world({ controlOk: false });
  await assert.rejects(promotePublishedUpdate(w.args), (e) => e.code === 'promotion_control_failed');
  assert.equal(fs.readFileSync(path.join(w.out, `${NAME}.mp4`), 'utf8'), 'OLD-ORIGINAL');
  assert.equal(fs.readFileSync(path.join(w.out, 'assembly.json'), 'utf8'), '{"old":true}');
  assert.equal(fs.readFileSync(path.join(w.out, '_build', 'seg01.mp4'), 'utf8'), 'OLD-SEG');
  assert.equal(fs.existsSync(liveRecordPath(w.repo, NAME)), false);
  const rec = JSON.parse(fs.readFileSync(path.join(w.stateDir, 'promotion', 'promotion.json'), 'utf8'));
  assert.equal(rec.status, 'failed');
});

test('Undo: revertPromotion puts the previous files back and drops the Drive record', async () => {
  const w = world();
  await promotePublishedUpdate(w.args);
  const r = revertPromotion({ name: NAME, stateDir: w.stateDir, repo: w.repo });
  assert.equal(r.reverted, true);
  assert.equal(fs.readFileSync(path.join(w.out, `${NAME}.mp4`), 'utf8'), 'OLD-ORIGINAL');
  assert.equal(fs.readFileSync(path.join(w.out, '_build', 'seg01.mp4'), 'utf8'), 'OLD-SEG');
  assert.equal(fs.existsSync(liveRecordPath(w.repo, NAME)), false);
  assert.equal(revertPromotion({ name: NAME, stateDir: w.stateDir, repo: w.repo }).reverted, false);
});
