// Baseline promotion: after a drift update is PUBLISHED, make that version the video's baseline so the next drift
// update is built on what viewers actually have (otherwise every later update for the video is refused by the
// live check: Drive no longer holds the baseline the preview was built on).
//
//   1. re-render the published update with the real renderer (same baseline, script, captures, build, layout) and
//      require the exact published bytes (sha256): proves the inputs are the ones that produced what is live;
//   2. stage the current version's original/_build/assembly (renderer/promote_baseline.py; gated: frames and
//      audio equal to the published file, visually identical by PSNR/SSIM);
//   3. check the local shared script already is the published one (steps equal, driftUpdate.jobId = this job) and
//      that its recordings are the very captures the render used (sha256 per screenshot);
//   4. install into out/<name>/ (previous files MOVED to the job's durable state dir: Undo restores them), write
//      out/<name>/drive-live.json (Drive md5 of the published file, bound to the new original's sha256);
//   5. enroll a NEW baseline with the normal registry + renderer.rebaseline (all of its own checks);
//   6. full original-image control: the real renderer re-renders EVERY slide from its own screenshots on the new
//      baseline and must reproduce the baseline exactly (what each future update relies on).
// Any failure after step 4 restores the previous files; the old baseline row was never touched. Nothing here
// writes to Drive, Pylon, Slack or the jobs service. Visual-only updates only (narration: fails closed).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { REPO, runProcess, readPyJson, ExecError } from './executor.mjs';
import { sha256File, md5File } from './publish.mjs';
import { getOrEnrollBaseline } from './baseline-registry.mjs';
import { LIVE_RECORD, liveRecordPath } from './live-version.mjs';

const SCRATCH = path.join(os.homedir(), '.hermes', 'cache', 'scratch');
const PY = (repo) => path.join(repo, '.venv', 'bin', 'python');
const canon = (v) => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((kk) => [kk, x[kk]])) : x));
const fail = (code, detail = null) => { throw new ExecError(code, detail); };
const lastJson = (s) => { const lines = String(s || '').trim().split('\n'); for (let i = lines.length - 1; i >= 0; i--) { try { return JSON.parse(lines.slice(i).join('\n')); } catch { /* keep going */ } } return null; };
const INSTALLED = (name) => [`${name}.mp4`, 'assembly.json', '_build'];

async function py(repo, args, { log, timeoutMs = 75 * 60_000, run = runProcess } = {}) {
  const r = await run(PY(repo), ['-B', ...args], { cwd: repo, timeoutMs, log, env: { ...process.env, TMPDIR: SCRATCH, PYTHONDONTWRITEBYTECODE: '1' } });
  const j = lastJson(r.stdout);
  if (r.timedOut) fail('promotion_timeout', args[1]);
  if (j?.rejected) fail(`promotion_rejected:${j.rejected}`, j.detail);
  if (r.code !== 0) fail('promotion_process_failed', `${args[1]}: ${(r.stderr || r.stdout || '').trim().split('\n').slice(-3).join(' | ')}`);
  return j;
}

/**
 * Render inputs of a pre-certified (weekly automatic) result, from its retained, durable files:
 * <result>/repair/verification.json, <result>/repair.changes.json, the baseline it was made on (source snapshot).
 */
export function inputsFromAutomaticResult({ verification, changes, repo = REPO }) {
  const v = readPyJson(verification);
  const keys = Object.keys(v.source_snapshot?.before || {});
  const identifiedScript = keys.find((k) => k.endsWith('/identified-base.script.json'));
  const manifest = keys.find((k) => k.endsWith('/baseline-manifest.json'));
  if (!identifiedScript || !manifest) fail('promotion_inputs_unknown', 'verification source snapshot lacks the script/baseline');
  const rebaselineDir = path.dirname(manifest);
  const script = readPyJson(identifiedScript);
  const report = path.join(rebaselineDir, 'source', 'report.json');
  return { rebaselineDir, script: identifiedScript, recordingsDir: path.join(rebaselineDir, 'source', '_recordings', script.recording?.id || ''),
    buildDir: path.join(rebaselineDir, 'source', '_build'), reportPath: fs.existsSync(report) ? report : null,
    changes: changes || path.join(path.dirname(path.dirname(verification)), 'repair.changes.json'), fontLayout: v.donor?.font_layout || 'basic', repo };
}

function moveInto(src, dst) { fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.renameSync(src, dst); }
function copyTree(src, dst) { fs.cpSync(src, dst, { recursive: true, errorOnExist: true, force: false, dereference: false }); }

function restore({ repo, name, backup, log }) {
  const out = path.join(repo, 'out', name);
  for (const f of INSTALLED(name)) {
    const cur = path.join(out, f), bak = path.join(backup, f);
    if (!fs.existsSync(bak)) continue;
    if (fs.existsSync(cur)) fs.rmSync(cur, { recursive: true, force: true });
    fs.renameSync(bak, cur);
  }
  const live = liveRecordPath(repo, name), bakLive = path.join(backup, LIVE_RECORD);
  if (fs.existsSync(bakLive)) fs.renameSync(bakLive, live); else fs.rmSync(live, { force: true });
  log(`[promote] ${name}: previous out/${name} files restored`);
}

/**
 * promotePublishedUpdate({name, jobId, published, render:{rebaselineDir, script, recordingsDir, buildDir, reportPath,
 *   changes, fontLayout}, stateDir, repo?, log?, enroll?, checkDrive?}) -> {status:'promoted', baselineDir, ...}
 * stateDir: the job's durable executor dir (.drift-cache/exec/<jobId>); promotion.json + backup live there.
 * checkDrive(): optional async () -> md5 now on Drive (must equal the published file's md5).
 */
export async function promotePublishedUpdate({ name, jobId, published, render, stateDir, repo = REPO, log = () => {}, enroll = getOrEnrollBaseline, checkDrive = null, run = runProcess, scratch = SCRATCH }) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/.test(name || '') || !/^[0-9a-f-]{36}$/i.test(jobId || '')) fail('promotion_bad_args');
  const dir = path.join(stateDir, 'promotion');
  const recordFile = path.join(dir, 'promotion.json');
  if (fs.existsSync(recordFile)) {
    const prev = JSON.parse(fs.readFileSync(recordFile, 'utf8'));
    if (prev.status === 'promoted') return { ...prev, resumed: true };
    if (prev.status === 'installing') fail('promotion_interrupted', `inspect ${recordFile} (backup in ${prev.backup})`);
  }
  fs.mkdirSync(dir, { recursive: true });
  const publishedSha = sha256File(published), publishedMd5 = md5File(published);
  if (checkDrive) {
    const md5 = await checkDrive();
    if (md5 !== publishedMd5) fail('promotion_drive_not_published_version', { drive: md5, published: publishedMd5 });
  }
  fs.mkdirSync(scratch, { recursive: true });
  const work = fs.mkdtempSync(path.join(scratch, `promote-${name.slice(0, 40)}-`));
  const write = (rec) => fs.writeFileSync(recordFile, JSON.stringify({ schema: 1, name, jobId, ...rec, at: new Date().toISOString() }, null, 2) + '\n');

  // 1. reproduce the published bytes
  log(`[promote] ${name}: re-rendering the published update`);
  await py(repo, ['-m', 'renderer.drift_update', '--rebaseline-dir', render.rebaselineDir, '--script', render.script, '--recordings-dir', render.recordingsDir,
    '--changes', render.changes, '--build-dir', render.buildDir, ...(render.reportPath ? ['--report', render.reportPath] : []),
    '--font-layout', render.fontLayout || 'basic', '--take-mode', 'manifest', '--output', path.join(work, 'render')], { log, run });
  const rv = readPyJson(path.join(work, 'render', 'verification.json'));
  if (rv.ok !== true || rv.candidate_sha256 !== publishedSha) fail('promotion_published_not_reproduced', { render: rv.candidate_sha256, published: publishedSha });

  // 2. stage
  const st = await py(repo, ['-m', 'renderer.promote_baseline', '--repo', repo, '--name', name, '--old-baseline', render.rebaselineDir,
    '--render', path.join(work, 'render'), '--published', published, '--output', path.join(work, 'stage')], { log, run, timeoutMs: 30 * 60_000 });
  if (!st?.ok) fail('promotion_stage_failed');

  // 3. the local shared script is already the published version, with the same captures
  const scriptPath = path.join(repo, 'scripts', `${name}.script.json`);
  const live = JSON.parse(fs.readFileSync(scriptPath, 'utf8'));
  const staged = JSON.parse(fs.readFileSync(st.script, 'utf8'));
  if (canon(live.steps) !== canon(staged.steps)) fail('promotion_script_not_published_version', 'scripts/<name>.script.json steps differ from the published candidate');
  if (live.driftUpdate?.jobId !== jobId) fail('promotion_script_not_from_this_job', live.driftUpdate?.jobId || null);
  const liveRec = path.join(repo, 'out', '_recordings', live.recording?.id || '');
  if (!live.recording?.id) fail('promotion_script_has_no_recording');
  const media = live.steps.filter((s) => s.capture !== false && s.media?.pre).map((s) => s.media.pre);
  if (!fs.existsSync(liveRec)) { copyTree(st.recordings, liveRec); log(`[promote] ${name}: recordings ${live.recording.id} copied locally`); }
  for (const f of media) {
    const a = path.join(liveRec, f), b = path.join(st.recordings, f);
    if (!fs.existsSync(a) || sha256File(a) !== sha256File(b)) fail('promotion_recordings_differ', f);
  }

  // 4. install (previous files moved aside, durable)
  const out = path.join(repo, 'out', name), backup = path.join(dir, 'backup');
  if (fs.existsSync(backup)) fail('promotion_backup_exists', backup);
  write({ status: 'installing', backup, work, publishedSha256: publishedSha, publishedMd5 });
  try {
    fs.mkdirSync(backup, { recursive: true });
    for (const f of INSTALLED(name)) if (fs.existsSync(path.join(out, f))) moveInto(path.join(out, f), path.join(backup, f));
    if (fs.existsSync(liveRecordPath(repo, name))) moveInto(liveRecordPath(repo, name), path.join(backup, LIVE_RECORD));
    fs.copyFileSync(st.original, path.join(out, `${name}.mp4`));
    fs.copyFileSync(st.assembly, path.join(out, 'assembly.json'));
    copyTree(st.build, path.join(out, '_build'));
    if (sha256File(path.join(out, `${name}.mp4`)) !== st.original_sha256 || sha256File(path.join(out, 'assembly.json')) !== st.assembly_sha256) fail('promotion_install_mismatch');
    fs.writeFileSync(liveRecordPath(repo, name), JSON.stringify({ schema: 1, name, jobId, originalSha256: st.original_sha256, driveMd5: publishedMd5,
      publishedSha256: publishedSha, similarity: st.similarity_to_published, promotedAt: new Date().toISOString() }, null, 2) + '\n');

    // 5. enroll the new baseline (normal rebaseline + registry validation)
    log(`[promote] ${name}: enrolling the new baseline`);
    const b = await enroll({ name, repo, log, supersede: { jobId } });
    if (b?.status !== 'baseline_ready' || !b.snapshotComplete) fail('promotion_enrollment_incomplete', b?.snapshotMissing || b?.status);
    const manifest = readPyJson(path.join(b.directory, 'baseline-manifest.json'));
    if (manifest.original?.sha256 !== st.original_sha256) fail('promotion_enrolled_wrong_original');

    // 6. full original-image control on the new baseline: every slide, its own screenshot, must reproduce the baseline
    const bscript = readPyJson(b.scriptPath);
    const caps = bscript.steps.filter((s) => s.capture !== false && s.media?.pre);
    if (caps.some((s) => !s.id)) fail('promotion_script_needs_step_ids');
    // drift_update requires the identified form (contracts.identify adds a top-level id when absent; steps keep theirs).
    const identified = path.join(work, 'identified-base.script.json');
    fs.writeFileSync(identified, JSON.stringify({ ...bscript, id: bscript.id || `promotion-control-${jobId}` }, null, 2) + '\n');
    const control = { baselineManifestHash: b.manifestSha256, changes: caps.map((s) => ({ stepId: s.id, screenshot: { path: path.join(b.recordingsDir, s.media.pre), sha256: sha256File(path.join(b.recordingsDir, s.media.pre)) } })) };
    const cm = path.join(work, 'control.changes.json');
    fs.writeFileSync(cm, JSON.stringify(control, null, 2) + '\n');
    log(`[promote] ${name}: full original-image control (${caps.length} slides)`);
    await py(repo, ['-m', 'renderer.drift_update', '--rebaseline-dir', b.directory, '--script', identified, '--recordings-dir', b.recordingsDir,
      '--changes', cm, '--build-dir', b.buildDir, ...(b.reportPath ? ['--report', b.reportPath] : []), '--font-layout', st.font_layout || 'basic',
      '--take-mode', 'manifest', '--output', path.join(work, 'control')], { log, run });
    const cv = readPyJson(path.join(work, 'control', 'verification.json'));
    if (cv.ok !== true || cv.candidate_sha256 !== manifest.final?.sha256) fail('promotion_control_failed', { candidate: cv.candidate_sha256, baseline: manifest.final?.sha256 });

    const rec = { status: 'promoted', backup, baselineDir: b.directory, manifestSha256: b.manifestSha256, originalSha256: st.original_sha256,
      publishedSha256: publishedSha, publishedMd5, similarity: st.similarity_to_published, controlSlides: caps.length,
      previousBaseline: render.rebaselineDir };
    write(rec);
    fs.rmSync(work, { recursive: true, force: true });
    log(`[promote] ${name}: promoted (baseline ${b.manifestSha256.slice(0, 12)})`);
    return rec;
  } catch (e) {
    try { restore({ repo, name, backup, log }); fs.rmSync(backup, { recursive: true, force: true }); } catch (re) { write({ status: 'restore_failed', backup, error: String(re?.message || re) }); throw e; }
    write({ status: 'failed', reason: e?.code || 'error', detail: String(e?.message || e).slice(0, 1000) });
    throw e;
  }
}

/** Executor hook: promote right after a preview-bound (weekly automatic) update was published. */
export function promoteAfterPublish({ name, jobId, published, automaticResult, stateDir, repo = REPO, log = () => {}, enroll, run }) {
  const render = inputsFromAutomaticResult({ verification: automaticResult.verification, repo });
  return promotePublishedUpdate({ name, jobId, published, render, stateDir, repo, log, ...(enroll ? { enroll } : {}), ...(run ? { run } : {}) });
}

/** Undo support: put back the files a promotion replaced (the old baseline row was never removed). */
export function revertPromotion({ name, stateDir, repo = REPO, log = () => {} }) {
  const recordFile = path.join(stateDir, 'promotion', 'promotion.json');
  if (!fs.existsSync(recordFile)) return { reverted: false, reason: 'no_promotion' };
  const rec = JSON.parse(fs.readFileSync(recordFile, 'utf8'));
  if (rec.status !== 'promoted') return { reverted: false, reason: `status_${rec.status}` };
  const live = JSON.parse(fs.readFileSync(liveRecordPath(repo, name), 'utf8'));
  if (live.jobId !== rec.jobId) return { reverted: false, reason: 'superseded_by_a_later_promotion' };
  const undone = path.join(stateDir, 'promotion', `undone-${Date.now()}`);
  fs.mkdirSync(undone, { recursive: true });
  for (const f of INSTALLED(name)) if (fs.existsSync(path.join(repo, 'out', name, f))) moveInto(path.join(repo, 'out', name, f), path.join(undone, f));
  moveInto(liveRecordPath(repo, name), path.join(undone, LIVE_RECORD));
  restore({ repo, name, backup: rec.backup, log });
  fs.writeFileSync(recordFile, JSON.stringify({ ...rec, status: 'reverted', undone, revertedAt: new Date().toISOString() }, null, 2) + '\n');
  return { reverted: true, undone };
}

// CLI (one-time catch-up for updates published before promotion existed):
//   node tools/drift/promote.mjs --name <n> --job <jobId> --result <weekly automatic result dir> [--no-drive-check]
if (import.meta.url === `file://${process.argv[1]}`) {
  const a = process.argv.slice(2), get = (k) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : null; };
  const name = get('--name'), jobId = get('--job'), result = get('--result');
  if (!name || !jobId || !result || !fs.existsSync(path.join(result, 'repair', 'verification.json'))) {
    console.log(JSON.stringify({ ok: false, reason: 'usage', detail: 'node tools/drift/promote.mjs --name <n> --job <jobId> --result <automatic result dir containing repair/verification.json>' }));
    process.exit(2);
  }
  let render;
  try { render = inputsFromAutomaticResult({ verification: path.join(result, 'repair', 'verification.json'), changes: path.join(result, 'repair.changes.json') }); }
  catch (e) { console.log(JSON.stringify({ ok: false, reason: e?.code || 'inputs_unreadable', detail: String(e?.message || e) })); process.exit(2); }
  let checkDrive = null;
  if (!a.includes('--no-drive-check')) {
    const { googleDriveAuthorizedFetch } = await import('../gdrive.mjs');
    const { createDriveClient } = await import('./publish.mjs');
    const drive = createDriveClient({ fetchAuthorized: googleDriveAuthorizedFetch });
    const script = JSON.parse(fs.readFileSync(path.join(REPO, 'scripts', `${name}.script.json`), 'utf8'));
    checkDrive = async () => (await drive.getFile(script.driveVideoId)).md5Checksum;
  }
  try {
    const r = await promotePublishedUpdate({ name, jobId, published: path.join(result, 'candidate.mp4'), render, stateDir: path.join(REPO, '.drift-cache', 'exec', jobId),
      log: (m) => console.error(m), checkDrive });
    console.log(JSON.stringify({ ok: true, ...r }, null, 2));
  } catch (e) { console.log(JSON.stringify({ ok: false, reason: e?.code || 'error', detail: e?.detail ?? String(e?.message || e) })); process.exitCode = 2; }
}
