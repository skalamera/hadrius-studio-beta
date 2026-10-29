import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { executeJob, pollOnce, rollbackJob, localJobState, buildChangeManifest, resolveInputs, checkVerification, acquireLock } from '../../tools/drift/executor.mjs';
import { fakeDrive, fakePylon, fakeLibrary, scripts, ARTICLE_BODY } from './publish-fakes.mjs';

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const md5 = (b) => crypto.createHash('md5').update(b).digest('hex');
const tmp = () => fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'drift-exec-'));
const PNG = Buffer.from('fake-png-new-screenshot');

/** Fake drift-job service with the real progress transition table and CAS. */
function fakeService(job) {
  const T = { approved: ['in_progress', 'failed'], in_progress: ['published', 'failed'], failed: ['in_progress'] };
  const notes = []; const progressLog = [];
  const err = (status, msg) => Object.assign(new Error(msg), { status, code: status === 409 ? 'conflict' : 'http_error' });
  return {
    job, notes, progressLog, noteRoute: true,
    async list() { return { jobs: [structuredClone(job)] }; },
    async get() { return { job: structuredClone(job) }; },
    async progress({ id, status, note, links, expectedVersion }) {
      if (expectedVersion != null && expectedVersion !== job.version) throw err(409, 'changed');
      if (!(T[job.status] || []).includes(status)) throw err(409, `illegal ${job.status} -> ${status}`);
      progressLog.push({ status, note, links }); job.status = status; job.version++; job.links = { ...(job.links || {}), ...(links || {}) };
      const back = structuredClone(job); delete back.details.execution; // the executor must keep the job it was given
      return { job: back };
    },
    async note({ note }) { if (!this.noteRoute) throw err(400, 'unknown action note'); notes.push(note); return { posted: true }; },
  };
}

/** A repo-like tree + weekly dir + rebaseline stand-in; render() writes a verified candidate. */
function world({ verificationOk = true, pylon = {}, drive = {} } = {}) {
  const root = tmp();
  const repo = path.join(root, 'repo');
  const { base } = scripts();
  const name = base.name;
  fs.mkdirSync(path.join(repo, 'out', name, '_build'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'out', '_recordings', 'rec-1'), { recursive: true });
  const original = Buffer.from('baseline-video');
  fs.writeFileSync(path.join(repo, 'out', name, `${name}.mp4`), original);
  const weekly = path.join(root, 'weekly', name);
  fs.mkdirSync(path.join(weekly, 'capture'), { recursive: true });
  fs.writeFileSync(path.join(weekly, 'job.json'), '{}');
  fs.writeFileSync(path.join(weekly, 'identified-base.script.json'), JSON.stringify(base));
  fs.writeFileSync(path.join(weekly, 'capture', 'step-02.png'), PNG);
  fs.writeFileSync(path.join(weekly, 'today-02.png'), PNG);
  fs.writeFileSync(path.join(weekly, 'candidate-manifest.json'), JSON.stringify({ baseHash: 'x', structuralChanges: [], changes: [{ stepId: 'step-2', beforeHash: 'b', imagePath: 'today-02.png', sha256: sha(PNG) }] }));
  const rebaselineDir = path.join(root, 'rebaseline');
  fs.mkdirSync(rebaselineDir);
  fs.writeFileSync(path.join(rebaselineDir, 'baseline-manifest.json'), JSON.stringify({ original: { name, sha256: sha(original) } }));
  const job = {
    id: crypto.randomUUID(), kind: 'auto_update', status: 'approved', version: 2, video_name: name, video_title: base.title, slack_ts: '1700000000.0001', created_at: new Date().toISOString(),
    details: { video: { name }, changes: [
      { step: 2, index: 1, changeTypes: ['screenshot'], oldNarration: 'Line 2.', after: { path: path.join(weekly, 'capture', 'step-02.png') } },
      { step: 3, index: 2, changeTypes: ['narration'], oldNarration: 'Line 3.', newNarration: 'A new line 3.' },
    ], execution: { schema: 1, scriptName: name, rebaselineDir } },
  };
  const renders = [];
  const render = async ({ args }) => {
    const out = args[args.indexOf('--output') + 1];
    renders.push({ args, manifest: JSON.parse(fs.readFileSync(args[args.indexOf('--changes') + 1], 'utf8')) });
    fs.mkdirSync(path.join(out, 'candidate', '_recordings', 'drift-rec-2'), { recursive: true });
    const cand = Buffer.from('candidate-video-bytes');
    fs.writeFileSync(path.join(out, 'candidate.mp4'), cand);
    const { cand: cs } = scripts();
    fs.writeFileSync(path.join(out, 'candidate-final.script.json'), JSON.stringify(cs));
    fs.writeFileSync(path.join(out, 'verification.json'), JSON.stringify({ ok: verificationOk, candidate: path.join(out, 'candidate.mp4'), candidate_sha256: sha(cand), candidate_script: path.join(out, 'candidate-final.script.json'),
      source_unchanged: true, elevenlabs_characters: 13, plan: { frames: { base: 810, new: 849 }, cell_map: [{ action: 'reuse', new: [0, 162] }, { action: 'render', new: [162, 650] }, { action: 'reuse', new: [650, 849] }] } }));
    return { ok: verificationOk };
  };
  const d = fakeDrive(drive); const p = fakePylon(pylon); const lib = fakeLibrary({ [name]: base });
  const svc = fakeService(job);
  const logs = [];
  const deps = {
    jobs: svc, whoami: 'tester', repo, stateRoot: path.join(root, 'state'), render, rebaseline: async () => { throw new Error('should not rebaseline'); },
    publishDeps: { drive: d, pylon: p, library: lib.library, local: lib.local, recordings: lib.recordings },
    getTargets: async () => ({ driveFileId: 'FILE1', pylonArticleId: 'ART1', title: base.title }),
    slackThreadReply: async (j, text) => { svc.notes.push(`[direct] ${text}`); },
    undoUrl: (j) => `https://pylon-webhook-service.vercel.app/api/studio-open?job=${j.id}`,
    log: (m) => logs.push(m),
  };
  return { root, repo, name, job, svc, deps, drive: d, pylon: p, lib, renders, base, weekly, rebaselineDir };
}

test('approved job -> claimed, rendered from the APPROVED changes, verified, published with links + Slack notes', async () => {
  const w = world();
  const r = await executeJob(w.job, w.deps);
  assert.equal(r.status, 'published', JSON.stringify(r));
  assert.deepEqual(w.svc.progressLog.map((p) => p.status), ['in_progress', 'published']);
  assert.deepEqual(Object.keys(w.svc.progressLog[1].links).sort(), ['drive', 'pylon', 'undo']);
  const m = w.renders[0].manifest;
  assert.equal(m.baselineManifestHash, sha(fs.readFileSync(path.join(w.rebaselineDir, 'baseline-manifest.json'))));
  assert.deepEqual(m.changes.map((c) => c.stepId), ['step-2', 'step-3']);
  assert.equal(m.changes[1].narration.newText, 'A new line 3.');
  assert.equal(w.drive.head().content.toString(), 'candidate-video-bytes');
  assert.match(w.pylon.article.current_published_content_html, /new-1\.mp4/);
  assert.equal(w.svc.notes.length, 3);
  assert.match(w.svc.notes[1], /≈42\.5% of frames reused unchanged, duration 0:27 → 0:28/);
  assert.match(w.svc.notes[2], /Published[\s\S]*Undo update/);
  assert.equal(localJobState(w.job.id, w.deps.stateRoot).canRollback, true);
});

test('verification fails -> job failed, nothing published, note says nothing changed', async () => {
  const w = world({ verificationOk: false });
  const r = await executeJob(w.job, w.deps);
  assert.equal(r.status, 'failed'); assert.equal(r.reason, 'verification_failed');
  assert.deepEqual(w.svc.progressLog.map((p) => p.status), ['in_progress', 'failed']);
  assert.equal(w.drive.file.revisions.length, 1); assert.equal(w.pylon.patches.length, 0);
  assert.match(w.svc.notes.at(-1), /Nothing was changed on Drive, Pylon or the shared script/);
});

test('someone else claimed it first (409) -> skipped, no render', async () => {
  const w = world();
  w.svc.job.version = 7; // stale expectedVersion
  const r = await executeJob({ ...w.job, version: 2 }, w.deps);
  assert.equal(r.status, 'skipped'); assert.equal(r.reason, 'claimed_elsewhere'); assert.equal(w.renders.length, 0);
});

test('Pylon fails after Drive succeeded -> Drive rolled back, job failed with rollback reported', async () => {
  const w = world({ pylon: { fail: { updateBody: true } } });
  const r = await executeJob(w.job, w.deps);
  assert.equal(r.status, 'failed'); assert.equal(r.stage, 'pylon'); assert.ok(r.applied.includes('drive')); assert.equal(r.rollback.ok, true);
  assert.equal(w.drive.head().content.toString(), 'baseline-video');
  assert.match(w.svc.notes.at(-1), /Automatic rollback: done, everything restored/);
  assert.equal(w.svc.progressLog.at(-1).status, 'failed');
});

test('pending draft -> blocked before any write, failed with reason', async () => {
  const w = world({ pylon: { draft: ARTICLE_BODY + '<p>wip</p>' } });
  const r = await executeJob(w.job, w.deps);
  assert.equal(r.reason, 'pylon_pending_draft'); assert.equal(w.drive.file.revisions.length, 1);
});

test('crash mid-publish -> re-run of the in_progress job resumes: no second render, no second Drive upload', async () => {
  const w = world({ pylon: { fail: { uploadAttachment: () => 'hang' } } });
  const first = executeJob(w.job, w.deps); first.catch(() => {});
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(w.svc.job.status, 'in_progress'); assert.equal(w.drive.calls.filter((c) => c === 'uploadContent').length, 1);
  fs.rmSync(path.join(w.deps.stateRoot, 'executor.lock')); // the process died (its pid would be dead)
  w.pylon.uploadAttachment = async () => ({ url: 'https://assets.usepylon.com/resumed.mp4' });
  const r = await executeJob(structuredClone(w.svc.job), w.deps);
  assert.equal(r.status, 'published', JSON.stringify(r));
  assert.equal(w.renders.length, 1);
  assert.equal(w.drive.calls.filter((c) => c === 'uploadContent').length, 1);
  assert.match(w.pylon.article.current_published_content_html, /resumed\.mp4/);
  assert.ok(w.svc.notes.some((n) => /resumed/.test(n)));
});

test('in_progress job owned by another machine is left alone', async () => {
  const w = world();
  const r = await executeJob({ ...w.job, status: 'in_progress' }, w.deps);
  assert.equal(r.reason, 'in_progress_elsewhere');
});

test('service without the note route -> notes fall back to a direct Slack thread reply', async () => {
  const w = world();
  w.svc.noteRoute = false;
  await executeJob(w.job, w.deps);
  assert.ok(w.svc.notes.length >= 3 && w.svc.notes.every((n) => n.startsWith('[direct] ')));
});

test('missing rebaseline -> built first (recorded), then rendered', async () => {
  const w = world();
  delete w.job.details.execution.rebaselineDir;
  let built = null;
  w.deps.rebaseline = async ({ output }) => { fs.mkdirSync(output); fs.copyFileSync(path.join(w.rebaselineDir, 'baseline-manifest.json'), path.join(output, 'baseline-manifest.json')); built = output; return output; };
  const r = await executeJob(w.job, w.deps);
  assert.equal(r.status, 'published'); assert.ok(built);
  assert.match(w.svc.notes[0], /disclosed lossy re-encode/);
});

test('manual rollback restores Drive/Pylon/library once; second click is refused', async () => {
  const w = world();
  await executeJob(w.job, w.deps);
  const rb = await rollbackJob(w.job.id, w.deps);
  assert.equal(rb.ok, true);
  assert.equal(w.drive.head().content.toString(), 'baseline-video');
  assert.equal(w.pylon.article.current_published_content_html, ARTICLE_BODY);
  assert.deepEqual(w.lib.lib.get(w.name), w.base);
  assert.match(w.svc.notes.at(-1), /rolled back by tester/);
  assert.equal(localJobState(w.job.id, w.deps.stateRoot).canRollback, false);
  await assert.rejects(rollbackJob(w.job.id, w.deps), (e) => e.code === 'already_rolled_back');
});

test('change manifest: unapproved step or non-approved screenshot bytes are refused', () => {
  const w = world();
  const inputs = resolveInputs(w.job, { repo: w.repo });
  fs.writeFileSync(path.join(w.weekly, 'candidate-manifest.json'), JSON.stringify({ changes: [{ stepId: 'step-1', imagePath: 'today-02.png', sha256: sha(PNG) }] }));
  assert.throws(() => buildChangeManifest(w.job, inputs, 'h'), (e) => e.code === 'unapproved_step_in_candidate');
  fs.writeFileSync(path.join(w.weekly, 'other.png'), 'different');
  fs.writeFileSync(path.join(w.weekly, 'candidate-manifest.json'), JSON.stringify({ changes: [{ stepId: 'step-2', imagePath: 'other.png' }] }));
  assert.throws(() => buildChangeManifest(w.job, inputs, 'h'), (e) => e.code === 'approved_evidence_mismatch');
});

test('weeklyDir is found from evidence paths when execution.weeklyDir is absent; missing _build fails', () => {
  const w = world();
  const inputs = resolveInputs(w.job, { repo: w.repo });
  assert.equal(inputs.weeklyDir, w.weekly);
  fs.rmSync(path.join(w.repo, 'out', w.name, '_build'), { recursive: true });
  assert.throws(() => resolveInputs(w.job, { repo: w.repo }), (e) => e.code === 'missing_build_dir');
});

test('checkVerification refuses noop / dry-run / tampered candidates', () => {
  const dir = tmp();
  const c = path.join(dir, 'c.mp4'); fs.writeFileSync(c, 'x');
  const write = (v) => fs.writeFileSync(path.join(dir, 'verification.json'), JSON.stringify(v));
  write({ ok: true, noop: true, candidate: c, candidate_sha256: sha('x') }); assert.throws(() => checkVerification(dir), (e) => e.code === 'noop_candidate');
  write({ ok: true, dry_run: true }); assert.throws(() => checkVerification(dir), (e) => e.code === 'verification_dry_run');
  write({ ok: true, candidate: c, candidate_sha256: 'nope' }); assert.throws(() => checkVerification(dir), (e) => e.code === 'candidate_hash_mismatch');
  fs.writeFileSync(path.join(dir, 'verification.json'), `{"ok": true, "candidate": ${JSON.stringify(c)}, "candidate_sha256": "${sha('x')}", "audio": {"snr_db": Infinity, "x": [NaN, -Infinity]}, "plan": {"frames": {"base": 30, "new": 30}, "cell_map": []}}`);
  assert.equal(checkVerification(dir).v.audio.snr_db, null, 'Python Infinity/NaN parse as null');
});

test('lock: second executor is refused while the first holds it; a dead pid lock is stale', () => {
  const dir = tmp(); const f = path.join(dir, 'executor.lock');
  const a = acquireLock(f); assert.ok(a); assert.equal(acquireLock(f), null); a.release();
  fs.writeFileSync(f, JSON.stringify({ pid: 999999, at: new Date().toISOString() }));
  const b = acquireLock(f); assert.ok(b); b.release();
});

test('poll executes approved jobs one at a time and stops when busy', async () => {
  const w = world();
  w.deps.isBusy = () => true;
  assert.deepEqual((await pollOnce(w.deps)).map((r) => r.reason), ['bridge_busy']);
  w.deps.isBusy = () => false;
  assert.equal((await pollOnce(w.deps))[0].status, 'published');
  assert.ok(md5);
});
